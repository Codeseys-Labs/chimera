"""
Background Task Tools - Delegate long-running work to Step Functions workflows

Provides fire-and-forget task delegation:
1. start_background_task: Creates DDB record + publishes EventBridge event
2. check_background_task: Queries task status from DDB

Architecture:
- Task metadata stored in sessions table (PK=TENANT#{id}, SK=BGTASK#{taskId})
- EventBridge event triggers appropriate Step Functions state machine
- Agent continues conversation immediately without blocking
"""
import os
import json
import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError
from datetime import datetime, timezone
from typing import Optional
from strands.tools import tool

from .tenant_context import TenantContextError, require_tenant_id

_BOTO_CONFIG = Config(
    connect_timeout=5,
    read_timeout=30,
    retries={"max_attempts": 3, "mode": "standard"},
)

# Initialize AWS clients
dynamodb = boto3.client('dynamodb', config=_BOTO_CONFIG)
events = boto3.client('events', config=_BOTO_CONFIG)


def _generate_task_id() -> str:
    """Generate unique background task ID."""
    import random
    import string
    timestamp = int(datetime.now(timezone.utc).timestamp() * 1000)
    random_suffix = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
    return f"bg-task-{timestamp}-{random_suffix}"


def _get_state_machine_arn(task_type: str, region: str, account_id: str, env: str) -> Optional[str]:
    """
    Map task type to Step Functions state machine ARN.

    Supported task types:
    - pipeline_build: Triggers pipeline build workflow
    - data_analysis: Triggers data analysis workflow
    - report_generation: Triggers report generation workflow (future)
    """
    state_machines = {
        'pipeline_build': f"arn:aws:states:{region}:{account_id}:stateMachine:chimera-pipeline-build-{env}",
        'data_analysis': f"arn:aws:states:{region}:{account_id}:stateMachine:chimera-data-analysis-{env}",
    }
    return state_machines.get(task_type)


@tool
def start_background_task(
    task_type: str,
    instruction: str,
    priority: str = "normal",
    context: Optional[dict] = None,
    timeout_seconds: int = 300
) -> str:
    """
    Start a background task that runs asynchronously without blocking the conversation.

    Use this for long-running operations like pipeline builds, data analysis, or report generation
    that would otherwise timeout in a synchronous agent conversation.

    Args:
        task_type: Type of task to run. Options: "pipeline_build", "data_analysis", "report_generation"
        instruction: Clear description of what the task should do
        priority: Task priority ("low", "normal", "high", "urgent"). Default: "normal"
        context: Optional additional context data for the task (e.g., repository, branch, query)
        timeout_seconds: Maximum execution time in seconds. Default: 300 (5 minutes)

    Returns:
        A confirmation message with the task ID for status checking

    Example:
        start_background_task(
            task_type="pipeline_build",
            instruction="Build the main branch and run all tests",
            priority="high",
            context={"repository": "chimera", "branch": "main"}
        )
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        # Get environment configuration
        region = os.environ.get('AWS_REGION', 'us-west-2')
        env_name = os.environ.get('CHIMERA_ENV', 'dev')
        event_bus_name = os.environ.get('EVENT_BUS_NAME', f'chimera-agents-{env_name}')
        sessions_table = os.environ.get('SESSIONS_TABLE', f'chimera-sessions-{env_name}')

        # Extract tenant context from environment (set by AgentCore runtime)
        tenant_id = os.environ.get('TENANT_ID', 'default-tenant')
        source_agent_id = os.environ.get('AGENT_ID', 'chimera-agent')
        session_id = os.environ.get('SESSION_ID', 'unknown-session')

        # Get AWS account ID for state machine ARN
        sts = boto3.client('sts', config=_BOTO_CONFIG)
        account_id = sts.get_caller_identity()['Account']

        # Validate task type
        state_machine_arn = _get_state_machine_arn(task_type, region, account_id, env_name)
        if not state_machine_arn:
            return f"Error: Unsupported task type '{task_type}'. Supported types: pipeline_build, data_analysis"

        # Generate task ID
        task_id = _generate_task_id()

        # Prepare task metadata
        now = datetime.now(timezone.utc).isoformat()
        task_context = context or {}

        # Store task metadata in DynamoDB sessions table
        # PK=TENANT#{tenantId}, SK=BGTASK#{taskId}
        dynamodb.put_item(
            TableName=sessions_table,
            Item={
                'PK': {'S': f'TENANT#{tenant_id}'},
                'SK': {'S': f'BGTASK#{task_id}'},
                'taskId': {'S': task_id},
                'taskType': {'S': task_type},
                'sourceAgentId': {'S': source_agent_id},
                'sourceSessionId': {'S': session_id},
                'instruction': {'S': instruction},
                'context': {'S': json.dumps(task_context)},
                'priority': {'S': priority},
                'timeoutSeconds': {'N': str(timeout_seconds)},
                'status': {'S': 'queued'},
                'queuedAt': {'S': now},
                'stateMachineArn': {'S': state_machine_arn},
                # TTL: 7 days from now (tasks expire after a week)
                'ttl': {'N': str(int((datetime.now(timezone.utc).timestamp()) + 7 * 24 * 60 * 60))},
            }
        )

        # Publish EventBridge event to trigger Step Functions
        event_detail = {
            'taskId': task_id,
            'tenantId': tenant_id,
            'taskType': task_type,
            'sourceAgentId': source_agent_id,
            'sourceSessionId': session_id,
            'instruction': instruction,
            'context': task_context,
            'priority': priority,
            'timeoutSeconds': timeout_seconds,
            'stateMachineArn': state_machine_arn,
            'queuedAt': now,
        }

        events.put_events(
            Entries=[
                {
                    'Source': 'chimera.agents',
                    'DetailType': 'Background Task Started',
                    'Detail': json.dumps(event_detail),
                    'EventBusName': event_bus_name,
                }
            ]
        )

        return f"""Background task started successfully!

Task ID: {task_id}
Type: {task_type}
Priority: {priority}
Status: queued

The task is now running in the background. Use check_background_task(task_id="{task_id}") to check its status.
You can continue our conversation while the task executes."""

    except (ClientError, BotoCoreError) as e:
        return f"Error starting background task: {str(e)}"


@tool
def check_background_task(task_id: str) -> str:
    """
    Check the status of a background task.

    Args:
        task_id: The task ID returned by start_background_task

    Returns:
        Current task status with details (status, progress, result, or error message)

    Example:
        check_background_task(task_id="bg-task-1234567890-abc123")
    """
    try:
        _tid = require_tenant_id()
    except TenantContextError as e:
        return f"Error: {e}"
    try:
        # Get environment configuration
        env_name = os.environ.get('CHIMERA_ENV', 'dev')
        sessions_table = os.environ.get('SESSIONS_TABLE', f'chimera-sessions-{env_name}')
        tenant_id = os.environ.get('TENANT_ID', 'default-tenant')

        # Query DynamoDB for task metadata
        response = dynamodb.get_item(
            TableName=sessions_table,
            Key={
                'PK': {'S': f'TENANT#{tenant_id}'},
                'SK': {'S': f'BGTASK#{task_id}'},
            }
        )

        if 'Item' not in response:
            return f"Task not found: {task_id}\n\nThis task ID may be invalid, or the task may have expired (tasks are kept for 7 days)."

        # Parse task data
        item = response['Item']
        status = item.get('status', {}).get('S', 'unknown')
        task_type = item.get('taskType', {}).get('S', 'unknown')
        instruction = item.get('instruction', {}).get('S', '')
        queued_at = item.get('queuedAt', {}).get('S', '')
        started_at = item.get('startedAt', {}).get('S', '')
        completed_at = item.get('completedAt', {}).get('S', '')

        # Build status message
        result = f"""Background Task Status

Task ID: {task_id}
Type: {task_type}
Status: {status}
Instruction: {instruction}

Queued at: {queued_at}"""

        if started_at:
            result += f"\nStarted at: {started_at}"

        if completed_at:
            result += f"\nCompleted at: {completed_at}"

        # Add status-specific details
        if status == 'queued':
            result += "\n\nThe task is waiting in the queue to be picked up by a worker."

        elif status == 'running':
            progress = item.get('progress', {}).get('N', '0')
            result += f"\n\nThe task is currently running (progress: {progress}%)."

        elif status == 'completed':
            result_data = item.get('result', {}).get('S', '')
            if result_data:
                result += f"\n\nResult:\n{result_data}"
            else:
                result += "\n\nThe task completed successfully."

        elif status == 'failed':
            error_code = item.get('errorCode', {}).get('S', 'UNKNOWN_ERROR')
            error_message = item.get('errorMessage', {}).get('S', 'No error details available')
            result += f"\n\nError: {error_code}\n{error_message}"

        elif status == 'timeout':
            result += "\n\nThe task exceeded its timeout limit and was terminated."

        return result

    except (ClientError, BotoCoreError) as e:
        return f"Error checking background task status: {str(e)}"
