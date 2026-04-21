"""
SQS Tools - AWS SQS operations for Chimera agent

Provides SQS message queue operations for agent-to-agent communication
and background task coordination.
"""
import boto3
import json
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from typing import List, Dict, Any, Optional
from strands.tools import tool
from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)


@tool
def create_sqs_queue(
    queue_name: str,
    fifo_queue: bool = False,
    delay_seconds: int = 0,
    region: str = "us-east-1"
) -> str:
    """
    Create an SQS queue (standard or FIFO) with configurable attributes.

    Args:
        queue_name: Queue name (must end with .fifo for FIFO queues)
        fifo_queue: Create FIFO queue (default: False)
        delay_seconds: Message delivery delay in seconds (0-900, default: 0)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with queue URL and configuration.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        attributes = {}
        if fifo_queue:
            attributes['FifoQueue'] = 'true'
        if delay_seconds > 0:
            attributes['DelaySeconds'] = str(delay_seconds)

        response = sqs.create_queue(
            QueueName=queue_name,
            Attributes=attributes if attributes else {}
        )

        queue_url = response['QueueUrl']
        queue_type = "FIFO" if fifo_queue else "Standard"

        return f"""SQS Queue Created:
Queue URL: {queue_url}
Type: {queue_type}
Delay: {delay_seconds}s
Region: {region}"""

    except (ClientError, BotoCoreError) as e:
        return f"Error creating SQS queue '{queue_name}': {str(e)}"


@tool
def send_sqs_message(
    queue_url: str,
    message_body: str,
    message_group_id: Optional[str] = None,
    delay_seconds: int = 0,
    region: str = "us-east-1"
) -> str:
    """
    Send a single message to an SQS queue.

    Args:
        queue_url: Queue URL
        message_body: Message body (up to 256KB)
        message_group_id: Message group ID (required for FIFO queues)
        delay_seconds: Message-level delivery delay (0-900)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with message ID and metadata.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        kwargs = {
            'QueueUrl': queue_url,
            'MessageBody': message_body
        }

        if message_group_id:
            kwargs['MessageGroupId'] = message_group_id
        if delay_seconds > 0:
            kwargs['DelaySeconds'] = delay_seconds

        response = sqs.send_message(**kwargs)

        return f"""Message Sent:
Message ID: {response['MessageId']}
MD5: {response['MD5OfMessageBody']}
Sequence: {response.get('SequenceNumber', 'N/A')}"""

    except (ClientError, BotoCoreError) as e:
        return f"Error sending message to queue: {str(e)}"


@tool
def send_sqs_message_batch(
    queue_url: str,
    messages: str,
    region: str = "us-east-1"
) -> str:
    """
    Send up to 10 messages to an SQS queue in a single request.

    Args:
        queue_url: Queue URL
        messages: JSON string containing list of message objects with 'id' and 'messageBody' keys
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with successful and failed message details.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        # Parse messages JSON
        message_list = json.loads(messages)

        # Build entries
        entries = []
        for msg in message_list[:10]:  # Limit to 10
            entry = {
                'Id': msg['id'],
                'MessageBody': msg['messageBody']
            }
            if 'messageGroupId' in msg:
                entry['MessageGroupId'] = msg['messageGroupId']
            if 'delaySeconds' in msg:
                entry['DelaySeconds'] = msg['delaySeconds']
            entries.append(entry)

        response = sqs.send_message_batch(
            QueueUrl=queue_url,
            Entries=entries
        )

        successful = response.get('Successful', [])
        failed = response.get('Failed', [])

        result = f"Batch Send Complete:\nSuccessful: {len(successful)}\nFailed: {len(failed)}\n"

        if failed:
            result += "\nFailed Messages:\n"
            for f in failed:
                result += f"  • {f['Id']}: {f.get('Code')} - {f.get('Message')}\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error sending batch messages: {str(e)}"


@tool
def receive_sqs_messages(
    queue_url: str,
    max_messages: int = 1,
    wait_time_seconds: int = 0,
    region: str = "us-east-1"
) -> str:
    """
    Poll messages from an SQS queue (long polling supported).

    Args:
        queue_url: Queue URL
        max_messages: Max messages to return (1-10, default: 1)
        wait_time_seconds: Long polling wait time (0-20, default: 0)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with received messages and receipt handles.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        response = sqs.receive_message(
            QueueUrl=queue_url,
            MaxNumberOfMessages=min(max_messages, 10),
            WaitTimeSeconds=wait_time_seconds
        )

        messages = response.get('Messages', [])

        if not messages:
            return "No messages received from queue."

        result = f"Received {len(messages)} message(s):\n\n"

        for i, msg in enumerate(messages, 1):
            result += f"Message {i}:\n"
            result += f"  ID: {msg['MessageId']}\n"
            result += f"  Body: {msg['Body'][:100]}{'...' if len(msg['Body']) > 100 else ''}\n"
            result += f"  Receipt Handle: {msg['ReceiptHandle'][:50]}...\n\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error receiving messages: {str(e)}"


@tool
def delete_sqs_message(
    queue_url: str,
    receipt_handle: str,
    region: str = "us-east-1"
) -> str:
    """
    Delete a message from the queue after processing.

    Args:
        queue_url: Queue URL
        receipt_handle: Receipt handle from receive_message
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        sqs.delete_message(
            QueueUrl=queue_url,
            ReceiptHandle=receipt_handle
        )

        return "Message deleted successfully from queue."

    except (ClientError, BotoCoreError) as e:
        return f"Error deleting message: {str(e)}"


@tool
def delete_sqs_queue(
    queue_url: str,
    region: str = "us-east-1"
) -> str:
    """
    Permanently delete an SQS queue and all messages.

    Args:
        queue_url: Queue URL to delete
        region: AWS region (default: us-east-1)

    Returns:
        Confirmation message.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        sqs.delete_queue(QueueUrl=queue_url)

        return f"Queue deleted: {queue_url}"

    except (ClientError, BotoCoreError) as e:
        return f"Error deleting queue: {str(e)}"


@tool
def get_sqs_queue_attributes(
    queue_url: str,
    region: str = "us-east-1"
) -> str:
    """
    Query queue attributes and configuration.

    Args:
        queue_url: Queue URL
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string with queue attributes.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        response = sqs.get_queue_attributes(
            QueueUrl=queue_url,
            AttributeNames=['All']
        )

        attrs = response['Attributes']

        result = f"""Queue Attributes:
URL: {queue_url}
Messages Available: {attrs.get('ApproximateNumberOfMessages', 'N/A')}
Messages In Flight: {attrs.get('ApproximateNumberOfMessagesNotVisible', 'N/A')}
Messages Delayed: {attrs.get('ApproximateNumberOfMessagesDelayed', 'N/A')}
Queue Type: {'FIFO' if attrs.get('FifoQueue') == 'true' else 'Standard'}
Created: {attrs.get('CreatedTimestamp', 'N/A')}
Visibility Timeout: {attrs.get('VisibilityTimeout', 'N/A')}s
Message Retention: {attrs.get('MessageRetentionPeriod', 'N/A')}s"""

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error getting queue attributes: {str(e)}"


@tool
def list_sqs_queues(
    queue_name_prefix: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    List SQS queues with optional name prefix filter.

    Args:
        queue_name_prefix: Filter queues by name prefix (optional)
        region: AWS region (default: us-east-1)

    Returns:
        Formatted string listing all matching queue URLs.
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        sqs = boto3.client('sqs', region_name=region, config=_BOTO_CONFIG)

        kwargs = {}
        if queue_name_prefix:
            kwargs['QueueNamePrefix'] = queue_name_prefix

        response = sqs.list_queues(**kwargs)

        queue_urls = response.get('QueueUrls', [])

        if not queue_urls:
            prefix_msg = f" matching prefix '{queue_name_prefix}'" if queue_name_prefix else ""
            return f"No queues found{prefix_msg} in region {region}."

        result = f"Found {len(queue_urls)} queue(s):\n\n"
        for url in queue_urls:
            queue_name = url.split('/')[-1]
            result += f"• {queue_name}\n  {url}\n"

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error listing queues: {str(e)}"
