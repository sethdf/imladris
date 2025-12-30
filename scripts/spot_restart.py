"""
Lambda function to auto-restart spot instance after hibernation.

Triggered by EventBridge when instance enters 'stopped' state.
Attempts to restart the instance (which will use spot if available).
Sends SNS notification on final failure.
"""

import json
import os
import time
import boto3
from botocore.exceptions import ClientError

ec2 = boto3.client('ec2')
sns = boto3.client('sns')

INSTANCE_ID = os.environ['INSTANCE_ID']
MAX_ATTEMPTS = int(os.environ.get('MAX_ATTEMPTS', '5'))
SNS_TOPIC_ARN = os.environ.get('SNS_TOPIC_ARN', '')


def lambda_handler(event, context):
    print(f"Received event: {json.dumps(event)}")

    # Verify this is for our instance
    detail = event.get('detail', {})
    instance_id = detail.get('instance-id')
    state = detail.get('state')

    if instance_id != INSTANCE_ID:
        print(f"Event for different instance {instance_id}, ignoring")
        return {'status': 'ignored', 'reason': 'different instance'}

    if state != 'stopped':
        print(f"Instance state is {state}, not stopped. Ignoring.")
        return {'status': 'ignored', 'reason': f'state is {state}'}

    # Check if this was a spot interruption (hibernation)
    try:
        response = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
        instance = response['Reservations'][0]['Instances'][0]

        # Check if it's a spot instance
        lifecycle = instance.get('InstanceLifecycle', 'on-demand')
        if lifecycle != 'spot':
            print(f"Instance is {lifecycle}, not spot. Not auto-restarting.")
            return {'status': 'ignored', 'reason': 'not a spot instance'}

        # Check the state reason
        state_reason = instance.get('StateReason', {}).get('Code', '')
        print(f"Instance stopped with reason: {state_reason}")

    except ClientError as e:
        print(f"Error describing instance: {e}")
        return {'status': 'error', 'error': str(e)}

    # Attempt to restart with retries
    for attempt in range(1, MAX_ATTEMPTS + 1):
        print(f"Restart attempt {attempt}/{MAX_ATTEMPTS}")

        try:
            ec2.start_instances(InstanceIds=[INSTANCE_ID])
            print(f"Successfully started instance {INSTANCE_ID}")

            # Wait a moment and verify it's running
            time.sleep(5)
            response = ec2.describe_instances(InstanceIds=[INSTANCE_ID])
            new_state = response['Reservations'][0]['Instances'][0]['State']['Name']

            if new_state in ['pending', 'running']:
                print(f"Instance is now {new_state}")
                send_notification(
                    subject="DevBox Restarted Successfully",
                    message=f"Your devbox instance {INSTANCE_ID} was hibernated due to spot interruption and has been successfully restarted.\n\nAttempt: {attempt}/{MAX_ATTEMPTS}"
                )
                return {'status': 'success', 'attempts': attempt}
            else:
                print(f"Instance state is {new_state}, retrying...")

        except ClientError as e:
            error_code = e.response['Error']['Code']
            print(f"Start failed: {error_code} - {e}")

            if error_code == 'InsufficientInstanceCapacity':
                # No spot capacity, wait and retry
                if attempt < MAX_ATTEMPTS:
                    wait_time = min(30 * attempt, 120)  # Exponential backoff, max 2 min
                    print(f"No spot capacity, waiting {wait_time}s before retry")
                    time.sleep(wait_time)
            else:
                # Other error, don't retry
                send_notification(
                    subject="DevBox Restart Failed",
                    message=f"Failed to restart devbox {INSTANCE_ID}.\n\nError: {error_code}\n{e}\n\nManual intervention required."
                )
                return {'status': 'error', 'error': str(e)}

    # All attempts exhausted
    send_notification(
        subject="DevBox Restart Failed - No Spot Capacity",
        message=f"Failed to restart devbox {INSTANCE_ID} after {MAX_ATTEMPTS} attempts.\n\nNo spot capacity available. You can:\n1. Wait and try manually: aws ec2 start-instances --instance-ids {INSTANCE_ID}\n2. Switch to on-demand (modify instance and restart)"
    )

    return {'status': 'failed', 'reason': 'max attempts exhausted'}


def send_notification(subject, message):
    """Send SNS notification if topic is configured."""
    if not SNS_TOPIC_ARN:
        print(f"No SNS topic configured. Would send: {subject}")
        return

    try:
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject=subject,
            Message=message
        )
        print(f"Sent notification: {subject}")
    except ClientError as e:
        print(f"Failed to send notification: {e}")
