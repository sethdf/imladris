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

from spot_restart import lambda_handler, get_config


@pytest.fixture
def mock_env(monkeypatch):
    """Set required environment variables."""
    monkeypatch.setenv('INSTANCE_ID', 'i-1234567890abcdef0')
    monkeypatch.setenv('MAX_ATTEMPTS', '3')
    monkeypatch.setenv('SNS_TOPIC_ARN', '')


@pytest.fixture
def mock_clients():
    """Create mock EC2 and SNS clients for dependency injection."""
    ec2_mock = MagicMock()
    sns_mock = MagicMock()
    return {'ec2': ec2_mock, 'sns': sns_mock}


def create_event(instance_id='i-1234567890abcdef0', state='stopped'):
    """Helper to create test events."""
    return {
        'detail': {
            'instance-id': instance_id,
            'state': state
        }
    }


def create_spot_instance_response(lifecycle='spot', state='stopped', state_reason=''):
    """Helper to create describe_instances responses."""
    instance = {
        'State': {'Name': state},
        'StateReason': {'Code': state_reason}
    }
    if lifecycle != 'on-demand':
        instance['InstanceLifecycle'] = lifecycle
    return {
        'Reservations': [{
            'Instances': [instance]
        }]
    }


class TestConfiguration:
    """Tests for configuration handling."""

    def test_get_config_with_env(self, mock_env):
        """Should read configuration from environment."""
        config = get_config()
        assert config['instance_id'] == 'i-1234567890abcdef0'
        assert config['max_attempts'] == 3
        assert config['sns_topic_arn'] == ''

    def test_get_config_missing_instance_id(self, monkeypatch):
        """Should raise error when INSTANCE_ID is missing."""
        monkeypatch.delenv('INSTANCE_ID', raising=False)
        with pytest.raises(ValueError, match="INSTANCE_ID"):
            get_config()

    def test_handler_returns_error_on_missing_config(self, monkeypatch, mock_clients):
        """Should return error when config is missing."""
        monkeypatch.delenv('INSTANCE_ID', raising=False)
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'error'
        assert 'INSTANCE_ID' in result['error']


class TestEventFiltering:
    """Tests for event filtering logic."""

    def test_ignores_different_instance(self, mock_env, mock_clients):
        """Should ignore events for other instances."""
        event = create_event(instance_id='i-different-instance')

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'ignored'
        assert result['reason'] == 'different instance'
        mock_clients['ec2'].describe_instances.assert_not_called()

    def test_ignores_non_stopped_state(self, mock_env, mock_clients):
        """Should ignore events for states other than 'stopped'."""
        event = create_event(state='running')

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'ignored'
        assert 'running' in result['reason']

    def test_ignores_non_spot_instance(self, mock_env, mock_clients):
        """Should not restart on-demand instances."""
        mock_clients['ec2'].describe_instances.return_value = \
            create_spot_instance_response(lifecycle='on-demand')
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'ignored'
        assert 'not a spot instance' in result['reason']


class TestDefensiveParsing:
    """Tests for defensive response parsing."""

    def test_handles_empty_reservations(self, mock_env, mock_clients):
        """Should handle response with no reservations."""
        mock_clients['ec2'].describe_instances.return_value = {'Reservations': []}
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'error'
        assert 'not found' in result['error']

    def test_handles_empty_instances(self, mock_env, mock_clients):
        """Should handle response with no instances in reservation."""
        mock_clients['ec2'].describe_instances.return_value = {
            'Reservations': [{'Instances': []}]
        }
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'error'
        assert 'missing' in result['error']

    def test_handles_missing_lifecycle_key(self, mock_env, mock_clients):
        """Should treat missing InstanceLifecycle as on-demand."""
        # Response without InstanceLifecycle key (on-demand instance)
        mock_clients['ec2'].describe_instances.return_value = {
            'Reservations': [{
                'Instances': [{
                    'State': {'Name': 'stopped'},
                    'StateReason': {'Code': 'Client.UserInitiatedShutdown'}
                    # No InstanceLifecycle key
                }]
            }]
        }
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'ignored'
        assert 'not a spot instance' in result['reason']


class TestSuccessfulRestart:
    """Tests for successful restart scenarios."""

    def test_successful_restart(self, mock_env, mock_clients):
        """Should successfully restart a stopped spot instance."""
        mock_clients['ec2'].describe_instances.side_effect = [
            create_spot_instance_response(lifecycle='spot', state='stopped'),
            create_spot_instance_response(lifecycle='spot', state='running'),
        ]
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'success'
        assert result['attempts'] == 1
        mock_clients['ec2'].start_instances.assert_called_once_with(
            InstanceIds=['i-1234567890abcdef0']
        )

    def test_successful_restart_pending_state(self, mock_env, mock_clients):
        """Should accept 'pending' as successful start."""
        mock_clients['ec2'].describe_instances.side_effect = [
            create_spot_instance_response(lifecycle='spot', state='stopped'),
            create_spot_instance_response(lifecycle='spot', state='pending'),
        ]
        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'success'


class TestRetryLogic:
    """Tests for the retry behavior on capacity errors."""

    def test_retries_on_insufficient_capacity(self, mock_env, mock_clients):
        """Should retry when spot capacity is unavailable."""
        from botocore.exceptions import ClientError

        capacity_error = ClientError(
            {'Error': {'Code': 'InsufficientInstanceCapacity', 'Message': 'No capacity'}},
            'StartInstances'
        )

        # First call: check spot, subsequent: verify state after starts
        mock_clients['ec2'].describe_instances.side_effect = [
            create_spot_instance_response(lifecycle='spot', state='stopped'),
            create_spot_instance_response(lifecycle='spot', state='running'),
        ]

        # Fail once, then succeed
        mock_clients['ec2'].start_instances.side_effect = [
            capacity_error,
            None  # Success
        ]

        event = create_event()

        with patch('time.sleep'):  # Skip actual sleep
            result = lambda_handler(
                event, None,
                ec2_client=mock_clients['ec2'],
                sns_client=mock_clients['sns']
            )

        assert mock_clients['ec2'].start_instances.call_count == 2

    def test_max_attempts_exhausted(self, mock_env, mock_clients, monkeypatch):
        """Should fail after max attempts exhausted."""
        from botocore.exceptions import ClientError
        monkeypatch.setenv('MAX_ATTEMPTS', '2')

        capacity_error = ClientError(
            {'Error': {'Code': 'InsufficientInstanceCapacity', 'Message': 'No capacity'}},
            'StartInstances'
        )

        mock_clients['ec2'].describe_instances.return_value = \
            create_spot_instance_response(lifecycle='spot', state='stopped')
        mock_clients['ec2'].start_instances.side_effect = capacity_error

        event = create_event()

        with patch('time.sleep'):
            result = lambda_handler(
                event, None,
                ec2_client=mock_clients['ec2'],
                sns_client=mock_clients['sns']
            )

        assert result['status'] == 'failed'
        assert result['reason'] == 'max attempts exhausted'
        assert mock_clients['ec2'].start_instances.call_count == 2

    def test_non_capacity_error_no_retry(self, mock_env, mock_clients):
        """Should not retry on non-capacity errors."""
        from botocore.exceptions import ClientError

        permission_error = ClientError(
            {'Error': {'Code': 'UnauthorizedOperation', 'Message': 'Not allowed'}},
            'StartInstances'
        )

        mock_clients['ec2'].describe_instances.return_value = \
            create_spot_instance_response(lifecycle='spot', state='stopped')
        mock_clients['ec2'].start_instances.side_effect = permission_error

        event = create_event()

        result = lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        assert result['status'] == 'error'
        assert mock_clients['ec2'].start_instances.call_count == 1  # No retry


class TestNotifications:
    """Tests for SNS notification behavior."""

    def test_sends_notification_on_success(self, mock_env, mock_clients, monkeypatch):
        """Should send SNS notification when restart succeeds."""
        monkeypatch.setenv('SNS_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789:test')

        mock_clients['ec2'].describe_instances.side_effect = [
            create_spot_instance_response(lifecycle='spot', state='stopped'),
            create_spot_instance_response(lifecycle='spot', state='running'),
        ]
        event = create_event()

        lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        mock_clients['sns'].publish.assert_called_once()
        call_kwargs = mock_clients['sns'].publish.call_args[1]
        assert 'Successfully' in call_kwargs['Subject']

    def test_no_notification_without_topic(self, mock_env, mock_clients):
        """Should not attempt notification when no topic configured."""
        mock_clients['ec2'].describe_instances.side_effect = [
            create_spot_instance_response(lifecycle='spot', state='stopped'),
            create_spot_instance_response(lifecycle='spot', state='running'),
        ]
        event = create_event()

        lambda_handler(
            event, None,
            ec2_client=mock_clients['ec2'],
            sns_client=mock_clients['sns']
        )

        mock_clients['sns'].publish.assert_not_called()

    def test_sends_notification_on_failure(self, mock_env, mock_clients, monkeypatch):
        """Should send SNS notification when restart fails."""
        from botocore.exceptions import ClientError
        monkeypatch.setenv('SNS_TOPIC_ARN', 'arn:aws:sns:us-east-1:123456789:test')
        monkeypatch.setenv('MAX_ATTEMPTS', '1')

        capacity_error = ClientError(
            {'Error': {'Code': 'InsufficientInstanceCapacity', 'Message': 'No capacity'}},
            'StartInstances'
        )

        mock_clients['ec2'].describe_instances.return_value = \
            create_spot_instance_response(lifecycle='spot', state='stopped')
        mock_clients['ec2'].start_instances.side_effect = capacity_error

        event = create_event()

        with patch('time.sleep'):
            lambda_handler(
                event, None,
                ec2_client=mock_clients['ec2'],
                sns_client=mock_clients['sns']
            )

        mock_clients['sns'].publish.assert_called_once()
        call_kwargs = mock_clients['sns'].publish.call_args[1]
        assert 'Failed' in call_kwargs['Subject']


class TestExponentialBackoff:
    """Tests for exponential backoff timing."""

    def test_backoff_increases_exponentially(self, mock_env, mock_clients, monkeypatch):
        """Should use exponential backoff with jitter."""
        from botocore.exceptions import ClientError
        import random
        monkeypatch.setenv('MAX_ATTEMPTS', '4')

        capacity_error = ClientError(
            {'Error': {'Code': 'InsufficientInstanceCapacity', 'Message': 'No capacity'}},
            'StartInstances'
        )

        mock_clients['ec2'].describe_instances.return_value = \
            create_spot_instance_response(lifecycle='spot', state='stopped')
        mock_clients['ec2'].start_instances.side_effect = capacity_error

        event = create_event()
        sleep_times = []

        def capture_sleep(duration):
            sleep_times.append(duration)

        # Fix random seed for predictable jitter
        random.seed(42)

        with patch('time.sleep', side_effect=capture_sleep):
            lambda_handler(
                event, None,
                ec2_client=mock_clients['ec2'],
                sns_client=mock_clients['sns']
            )

        # Should have 3 sleeps (between 4 attempts)
        assert len(sleep_times) == 3

        # Base wait times should be exponential: 20, 40, 80 (2^1*10, 2^2*10, 2^3*10)
        # Plus jitter of 0-5
        assert 20 <= sleep_times[0] <= 25
        assert 40 <= sleep_times[1] <= 45
        assert 80 <= sleep_times[2] <= 85
