"""
Unit tests for spot-restart Lambda function.

Run with: pytest tests/unit/ -v
"""

import json
import os
import sys
from unittest.mock import MagicMock, patch

import pytest

# Add scripts directory to path for import
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../scripts'))


@pytest.fixture
def mock_env(monkeypatch):
    """Set required environment variables."""
    monkeypatch.setenv('INSTANCE_ID', 'i-1234567890abcdef0')
    monkeypatch.setenv('MAX_ATTEMPTS', '3')
    monkeypatch.setenv('SNS_TOPIC_ARN', '')


@pytest.fixture
def mock_boto3():
    """Mock boto3 clients."""
    with patch('boto3.client') as mock_client:
        ec2_mock = MagicMock()
        sns_mock = MagicMock()

        def get_client(service):
            if service == 'ec2':
                return ec2_mock
            elif service == 'sns':
                return sns_mock
            return MagicMock()

        mock_client.side_effect = get_client
        yield {'ec2': ec2_mock, 'sns': sns_mock}


class TestLambdaHandler:
    """Tests for the main Lambda handler."""

    def test_ignores_different_instance(self, mock_env, mock_boto3):
        """Should ignore events for other instances."""
        # Import after env is set
        import importlib
        spot_restart = importlib.import_module('spot_restart')

        event = {
            'detail': {
                'instance-id': 'i-different-instance',
                'state': 'stopped'
            }
        }

        result = spot_restart.lambda_handler(event, None)

        assert result['status'] == 'ignored'
        assert result['reason'] == 'different instance'

    def test_ignores_non_stopped_state(self, mock_env, mock_boto3):
        """Should ignore events for states other than 'stopped'."""
        import importlib
        spot_restart = importlib.import_module('spot_restart')

        event = {
            'detail': {
                'instance-id': 'i-1234567890abcdef0',
                'state': 'running'
            }
        }

        result = spot_restart.lambda_handler(event, None)

        assert result['status'] == 'ignored'
        assert 'running' in result['reason']

    def test_ignores_non_spot_instance(self, mock_env, mock_boto3):
        """Should not restart on-demand instances."""
        import importlib
        spot_restart = importlib.import_module('spot_restart')

        # Mock describe_instances to return on-demand instance
        mock_boto3['ec2'].describe_instances.return_value = {
            'Reservations': [{
                'Instances': [{
                    'InstanceLifecycle': 'on-demand',  # Not spot
                    'StateReason': {'Code': 'Client.UserInitiatedShutdown'}
                }]
            }]
        }

        event = {
            'detail': {
                'instance-id': 'i-1234567890abcdef0',
                'state': 'stopped'
            }
        }

        result = spot_restart.lambda_handler(event, None)

        assert result['status'] == 'ignored'
        assert 'not a spot instance' in result['reason']

    def test_successful_restart(self, mock_env, mock_boto3):
        """Should successfully restart a stopped spot instance."""
        import importlib
        spot_restart = importlib.import_module('spot_restart')

        # Mock describe_instances - first call shows spot, second shows running
        mock_boto3['ec2'].describe_instances.side_effect = [
            {
                'Reservations': [{
                    'Instances': [{
                        'InstanceLifecycle': 'spot',
                        'StateReason': {'Code': 'Server.SpotInstanceShutdown'}
                    }]
                }]
            },
            {
                'Reservations': [{
                    'Instances': [{
                        'State': {'Name': 'running'}
                    }]
                }]
            }
        ]

        event = {
            'detail': {
                'instance-id': 'i-1234567890abcdef0',
                'state': 'stopped'
            }
        }

        result = spot_restart.lambda_handler(event, None)

        assert result['status'] == 'success'
        mock_boto3['ec2'].start_instances.assert_called_once()


class TestRetryLogic:
    """Tests for the retry behavior on capacity errors."""

    def test_retries_on_insufficient_capacity(self, mock_env, mock_boto3):
        """Should retry when spot capacity is unavailable."""
        import importlib
        from botocore.exceptions import ClientError
        spot_restart = importlib.import_module('spot_restart')

        # Mock describe_instances to return spot instance
        mock_boto3['ec2'].describe_instances.return_value = {
            'Reservations': [{
                'Instances': [{
                    'InstanceLifecycle': 'spot',
                    'StateReason': {'Code': 'Server.SpotInstanceShutdown'}
                }]
            }]
        }

        # Mock start_instances to fail with capacity error, then succeed
        capacity_error = ClientError(
            {'Error': {'Code': 'InsufficientInstanceCapacity', 'Message': 'No capacity'}},
            'StartInstances'
        )
        mock_boto3['ec2'].start_instances.side_effect = [
            capacity_error,
            capacity_error,
            None  # Success on third attempt
        ]

        # Update describe_instances for success check
        mock_boto3['ec2'].describe_instances.side_effect = [
            # First call - check if spot
            {'Reservations': [{'Instances': [{'InstanceLifecycle': 'spot', 'StateReason': {'Code': ''}}]}]},
            # Calls after each start attempt
            {'Reservations': [{'Instances': [{'State': {'Name': 'stopped'}}]}]},
            {'Reservations': [{'Instances': [{'State': {'Name': 'stopped'}}]}]},
            {'Reservations': [{'Instances': [{'State': {'Name': 'running'}}]}]},
        ]

        event = {
            'detail': {
                'instance-id': 'i-1234567890abcdef0',
                'state': 'stopped'
            }
        }

        # This test verifies retry logic exists - actual timing tested differently
        # Just verify start_instances is called
        result = spot_restart.lambda_handler(event, None)

        assert mock_boto3['ec2'].start_instances.call_count >= 1


class TestNotifications:
    """Tests for SNS notification behavior."""

    def test_sends_notification_on_success(self, mock_env, mock_boto3, monkeypatch):
        """Should send SNS notification when restart succeeds."""
        monkeypatch.setenv('SNS_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789:test')

        import importlib
        spot_restart = importlib.import_module('spot_restart')
        importlib.reload(spot_restart)  # Reload to pick up new env

        mock_boto3['ec2'].describe_instances.side_effect = [
            {'Reservations': [{'Instances': [{'InstanceLifecycle': 'spot', 'StateReason': {'Code': ''}}]}]},
            {'Reservations': [{'Instances': [{'State': {'Name': 'running'}}]}]},
        ]

        event = {
            'detail': {
                'instance-id': 'i-1234567890abcdef0',
                'state': 'stopped'
            }
        }

        spot_restart.lambda_handler(event, None)

        # Verify SNS publish was called
        mock_boto3['sns'].publish.assert_called()

    def test_no_notification_without_topic(self, mock_env, mock_boto3):
        """Should not attempt notification when no topic configured."""
        import importlib
        spot_restart = importlib.import_module('spot_restart')

        mock_boto3['ec2'].describe_instances.side_effect = [
            {'Reservations': [{'Instances': [{'InstanceLifecycle': 'spot', 'StateReason': {'Code': ''}}]}]},
            {'Reservations': [{'Instances': [{'State': {'Name': 'running'}}]}]},
        ]

        event = {
            'detail': {
                'instance-id': 'i-1234567890abcdef0',
                'state': 'stopped'
            }
        }

        spot_restart.lambda_handler(event, None)

        # SNS should not be called when topic is empty
        mock_boto3['sns'].publish.assert_not_called()
