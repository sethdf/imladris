"""
Lambda function to auto-restart spot instance after hibernation.

Triggered by EventBridge when instance enters 'stopped' state.
Attempts to restart the instance (which will use spot if available).
Sends SNS notification on final failure.
"""

import json
import os
import time
import random
import boto3
from botocore.exceptions import ClientError


def get_config():
    """Get configuration from environment variables at runtime."""
    instance_id = os.environ.get('INSTANCE_ID')
    if not instance_id:
        raise ValueError("INSTANCE_ID environment variable is required")

    return {
        'instance_id': instance_id,
        'max_attempts': int(os.environ.get('MAX_ATTEMPTS', '5')),
        'sns_topic_arn': os.environ.get('SNS_TOPIC_ARN', ''),
    }


def lambda_handler(event, context, ec2_client=None, sns_client=None):
    """
    Main Lambda handler.

    Args:
        event: EventBridge event
        context: Lambda context
        ec2_client: Optional EC2 client (for testing)
        sns_client: Optional SNS client (for testing)
    """
    # Create clients if not injected (production mode)
    ec2 = ec2_client or boto3.client('ec2')
    sns = sns_client or boto3.client('sns')

    # Get configuration at runtime
    try:
        config = get_config()
    except ValueError as e:
        print(f"Configuration error: {e}")
        return {'status': 'error', 'error': str(e)}

    instance_id = config['instance_id']
    max_attempts = config['max_attempts']
    sns_topic_arn = config['sns_topic_arn']

    print(f"Received event: {json.dumps(event)}")

    # Verify this is for our instance
    detail = event.get('detail', {})
    event_instance_id = detail.get('instance-id')
    state = detail.get('state')

    if event_instance_id != instance_id:
        print(f"Event for different instance {event_instance_id}, ignoring")
        return {'status': 'ignored', 'reason': 'different instance'}

    if state != 'stopped':
        print(f"Instance state is {state}, not stopped. Ignoring.")
        return {'status': 'ignored', 'reason': f'state is {state}'}

    # Check if this was a spot interruption (hibernation)
    try:
        response = ec2.describe_instances(InstanceIds=[instance_id])

        # Defensive parsing - handle missing keys gracefully
        reservations = response.get('Reservations', [])
        if not reservations:
            print(f"No reservations found for instance {instance_id}")
            return {'status': 'error', 'error': 'instance not found'}

        instances = reservations[0].get('Instances', [])
        if not instances:
            print(f"No instance data found in reservation")
            return {'status': 'error', 'error': 'instance data missing'}

        instance = instances[0]

        # Check if it's a spot instance (use .get() for on-demand instances)
        lifecycle = instance.get('InstanceLifecycle', 'on-demand')
        if lifecycle != 'spot':
            print(f"Instance is {lifecycle}, not spot. Not auto-restarting.")
            return {'status': 'ignored', 'reason': 'not a spot instance'}

        # Check the state reason
        state_reason = instance.get('StateReason', {}).get('Code', 'unknown')
        print(f"Instance stopped with reason: {state_reason}")

    except ClientError as e:
        print(f"Error describing instance: {e}")
        return {'status': 'error', 'error': str(e)}

    # Attempt to restart with exponential backoff
    for attempt in range(1, max_attempts + 1):
        print(f"Restart attempt {attempt}/{max_attempts}")

        try:
            ec2.start_instances(InstanceIds=[instance_id])
            print(f"Successfully started instance {instance_id}")

            # Wait a moment and verify it's running
            time.sleep(5)
            response = ec2.describe_instances(InstanceIds=[instance_id])

            # Defensive parsing for verify step
            reservations = response.get('Reservations', [])
            if reservations and reservations[0].get('Instances'):
                new_state = reservations[0]['Instances'][0].get('State', {}).get('Name', 'unknown')
            else:
                new_state = 'unknown'

            if new_state in ['pending', 'running']:
                print(f"Instance is now {new_state}")
                _send_notification(
                    sns, sns_topic_arn,
                    subject="DevBox Restarted Successfully",
                    message=f"Your devbox instance {instance_id} was hibernated due to spot interruption and has been successfully restarted.\n\nAttempt: {attempt}/{max_attempts}"
                )
                return {'status': 'success', 'attempts': attempt}
            else:
                print(f"Instance state is {new_state}, retrying...")

        except ClientError as e:
            error_response = e.response.get('Error', {})
            error_code = error_response.get('Code', 'Unknown')
            print(f"Start failed: {error_code} - {e}")

            if error_code == 'InsufficientInstanceCapacity':
                # No spot capacity, wait with exponential backoff + jitter
                if attempt < max_attempts:
                    # True exponential backoff: 2^attempt * 10, capped at 120s
                    # Plus jitter to prevent thundering herd
                    base_wait = min(10 * (2 ** attempt), 120)
                    jitter = random.uniform(0, 5)
                    wait_time = base_wait + jitter
                    print(f"No spot capacity, waiting {wait_time:.1f}s before retry")
                    time.sleep(wait_time)
            else:
                # Other error, don't retry
                _send_notification(
                    sns, sns_topic_arn,
                    subject="DevBox Restart Failed",
                    message=f"Failed to restart devbox {instance_id}.\n\nError: {error_code}\n{e}\n\nManual intervention required."
                )
                return {'status': 'error', 'error': str(e)}

    # All attempts exhausted
    _send_notification(
        sns, sns_topic_arn,
        subject="DevBox Restart Failed - No Spot Capacity",
        message=f"Failed to restart devbox {instance_id} after {max_attempts} attempts.\n\nNo spot capacity available. You can:\n1. Wait and try manually: aws ec2 start-instances --instance-ids {instance_id}\n2. Switch to on-demand (modify instance and restart)"
    )

    return {'status': 'failed', 'reason': 'max attempts exhausted'}


def _send_notification(sns_client, topic_arn, subject, message):
    """Send SNS notification if topic is configured."""
    if not topic_arn:
        print(f"No SNS topic configured. Would send: {subject}")
        return

    try:
        sns_client.publish(
            TopicArn=topic_arn,
            Subject=subject,
            Message=message
        )
        print(f"Sent notification: {subject}")
    except ClientError as e:
        print(f"Failed to send notification: {e}")
