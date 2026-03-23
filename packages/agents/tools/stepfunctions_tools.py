"""
Step Functions Tools - AWS Step Functions operations for Chimera agent

Provides workflow orchestration operations with tenant-scoped access control.
All operations respect IAM policies enforced at the tenant level.
"""
import boto3
import json
from typing import Optional, Dict, Any, List
from strands.tools import tool


@tool
def list_stepfunctions_state_machines(region: str = "us-east-1") -> str:
    """
    List all Step Functions state machines in the specified region.

    Args:
        region: AWS region to query (default: us-east-1)

    Returns:
        A formatted string listing all state machines with their details.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)
        response = sfn_client.list_state_machines()

        state_machines = response.get('stateMachines', [])
        if not state_machines:
            return f"No Step Functions state machines found in region {region}."

        result = f"Found {len(state_machines)} state machine(s) in {region}:\n\n"

        for sm in state_machines:
            name = sm['name']
            sm_type = sm.get('type', 'N/A')
            creation_date = sm.get('creationDate', 'N/A')
            if creation_date != 'N/A':
                creation_date = creation_date.strftime('%Y-%m-%d %H:%M:%S')

            result += f"• {name}\n"
            result += f"  Type: {sm_type}\n"
            result += f"  ARN: {sm['stateMachineArn']}\n"
            result += f"  Created: {creation_date}\n\n"

        return result

    except Exception as e:
        return f"Error listing Step Functions state machines in {region}: {str(e)}"


@tool
def create_stepfunctions_state_machine(
    name: str,
    definition: str,
    role_arn: str,
    state_machine_type: str = "STANDARD",
    region: str = "us-east-1"
) -> str:
    """
    Create a new Step Functions state machine.

    Args:
        name: Name for the state machine
        definition: Amazon States Language definition (JSON string)
        role_arn: IAM role ARN for Step Functions execution
        state_machine_type: Type of state machine - STANDARD or EXPRESS (default: STANDARD)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the created state machine details.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)

        # Validate state machine type
        if state_machine_type not in ['STANDARD', 'EXPRESS']:
            return f"Error: Invalid state_machine_type '{state_machine_type}'. Must be 'STANDARD' or 'EXPRESS'."

        response = sfn_client.create_state_machine(
            name=name,
            definition=definition,
            roleArn=role_arn,
            type=state_machine_type
        )

        state_machine_arn = response.get('stateMachineArn', 'N/A')
        creation_date = response.get('creationDate', 'N/A')
        if creation_date != 'N/A':
            creation_date = creation_date.strftime('%Y-%m-%d %H:%M:%S')

        result = f"""Step Functions State Machine Created:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Name: {name}
ARN: {state_machine_arn}
Type: {state_machine_type}
Created: {creation_date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error creating state machine {name}: {str(e)}"


@tool
def describe_stepfunctions_state_machine(state_machine_arn: str, region: str = "us-east-1") -> str:
    """
    Get detailed information about a Step Functions state machine.

    Args:
        state_machine_arn: ARN of the state machine
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with detailed state machine configuration.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)
        response = sfn_client.describe_state_machine(stateMachineArn=state_machine_arn)

        name = response.get('name', 'N/A')
        status = response.get('status', 'N/A')
        sm_type = response.get('type', 'N/A')
        role_arn = response.get('roleArn', 'N/A')
        creation_date = response.get('creationDate', 'N/A')
        if creation_date != 'N/A':
            creation_date = creation_date.strftime('%Y-%m-%d %H:%M:%S')

        # Definition (truncate if too long)
        definition = response.get('definition', '')
        if len(definition) > 500:
            definition_display = definition[:500] + "...\n(truncated, full definition available via API)"
        else:
            definition_display = definition

        result = f"""State Machine: {name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARN: {state_machine_arn}
Type: {sm_type}
Status: {status}
Role ARN: {role_arn}
Created: {creation_date}

Definition:
{definition_display}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error describing state machine {state_machine_arn}: {str(e)}"


@tool
def start_stepfunctions_execution(
    state_machine_arn: str,
    execution_input: Optional[str] = None,
    execution_name: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Start a Step Functions state machine execution.

    Args:
        state_machine_arn: ARN of the state machine
        execution_input: Input JSON for the execution (optional)
        execution_name: Name for the execution (auto-generated if omitted)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the execution details.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)

        # Build execution request
        start_config = {'stateMachineArn': state_machine_arn}
        if execution_name:
            start_config['name'] = execution_name
        if execution_input:
            start_config['input'] = execution_input

        response = sfn_client.start_execution(**start_config)

        execution_arn = response.get('executionArn', 'N/A')
        start_date = response.get('startDate', 'N/A')
        if start_date != 'N/A':
            start_date = start_date.strftime('%Y-%m-%d %H:%M:%S')

        result = f"""Step Functions Execution Started:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Execution ARN: {execution_arn}
State Machine: {state_machine_arn}
Start Time: {start_date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error starting execution for {state_machine_arn}: {str(e)}"


@tool
def describe_stepfunctions_execution(execution_arn: str, region: str = "us-east-1") -> str:
    """
    Get details about a Step Functions execution.

    Args:
        execution_arn: ARN of the execution
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with execution status and details.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)
        response = sfn_client.describe_execution(executionArn=execution_arn)

        name = response.get('name', 'N/A')
        status = response.get('status', 'N/A')
        state_machine_arn = response.get('stateMachineArn', 'N/A')
        start_date = response.get('startDate', 'N/A')
        stop_date = response.get('stopDate', 'N/A')

        if start_date != 'N/A':
            start_date = start_date.strftime('%Y-%m-%d %H:%M:%S')
        if stop_date != 'N/A':
            stop_date = stop_date.strftime('%Y-%m-%d %H:%M:%S')

        # Input and output
        exec_input = response.get('input', 'N/A')
        output = response.get('output', 'N/A')
        error = response.get('error', None)
        cause = response.get('cause', None)

        result = f"""Execution: {name}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ARN: {execution_arn}
State Machine: {state_machine_arn}
Status: {status}
Start Time: {start_date}
Stop Time: {stop_date}

Input:
{exec_input}

Output:
{output}
"""

        if error:
            result += f"\n⚠️  Error: {error}\n"
        if cause:
            result += f"Cause: {cause}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error describing execution {execution_arn}: {str(e)}"


@tool
def list_stepfunctions_executions(
    state_machine_arn: str,
    status_filter: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    List executions for a Step Functions state machine.

    Args:
        state_machine_arn: ARN of the state machine
        status_filter: Filter by status - RUNNING, SUCCEEDED, FAILED, TIMED_OUT, or ABORTED (optional)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string listing executions with their status.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)

        # Build list request
        list_config = {'stateMachineArn': state_machine_arn}
        if status_filter:
            valid_statuses = ['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']
            if status_filter not in valid_statuses:
                return f"Error: Invalid status_filter '{status_filter}'. Must be one of: {', '.join(valid_statuses)}"
            list_config['statusFilter'] = status_filter

        response = sfn_client.list_executions(**list_config)

        executions = response.get('executions', [])
        if not executions:
            filter_msg = f" with status {status_filter}" if status_filter else ""
            return f"No executions found{filter_msg} for state machine {state_machine_arn}."

        filter_msg = f" (filtered by: {status_filter})" if status_filter else ""
        result = f"Found {len(executions)} execution(s){filter_msg}:\n\n"

        for execution in executions:
            name = execution.get('name', 'N/A')
            status = execution.get('status', 'N/A')
            start_date = execution.get('startDate', 'N/A')
            stop_date = execution.get('stopDate', 'N/A')

            if start_date != 'N/A':
                start_date = start_date.strftime('%Y-%m-%d %H:%M:%S')
            if stop_date != 'N/A':
                stop_date = stop_date.strftime('%Y-%m-%d %H:%M:%S')

            result += f"• {name}\n"
            result += f"  Status: {status}\n"
            result += f"  Started: {start_date}\n"
            if stop_date != 'N/A':
                result += f"  Stopped: {stop_date}\n"
            result += f"  ARN: {execution['executionArn']}\n\n"

        return result

    except Exception as e:
        return f"Error listing executions for {state_machine_arn}: {str(e)}"


@tool
def stop_stepfunctions_execution(
    execution_arn: str,
    error: Optional[str] = None,
    cause: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Stop a running Step Functions execution.

    Args:
        execution_arn: ARN of the execution to stop
        error: Error code (optional)
        cause: Human-readable cause for stopping (optional)
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string confirming the stop operation.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)

        # Build stop request
        stop_config = {'executionArn': execution_arn}
        if error:
            stop_config['error'] = error
        if cause:
            stop_config['cause'] = cause

        response = sfn_client.stop_execution(**stop_config)

        stop_date = response.get('stopDate', 'N/A')
        if stop_date != 'N/A':
            stop_date = stop_date.strftime('%Y-%m-%d %H:%M:%S')

        result = f"""Execution Stopped:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Execution ARN: {execution_arn}
Stop Time: {stop_date}
"""
        if error:
            result += f"Error: {error}\n"
        if cause:
            result += f"Cause: {cause}\n"

        result += "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

        return result

    except Exception as e:
        return f"Error stopping execution {execution_arn}: {str(e)}"


@tool
def update_stepfunctions_state_machine(
    state_machine_arn: str,
    definition: Optional[str] = None,
    role_arn: Optional[str] = None,
    region: str = "us-east-1"
) -> str:
    """
    Update an existing Step Functions state machine.

    Args:
        state_machine_arn: ARN of the state machine
        definition: Updated Amazon States Language definition (JSON string)
        role_arn: Updated IAM role ARN
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string with the update status.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)

        # Build update configuration
        update_config = {'stateMachineArn': state_machine_arn}

        if definition is not None:
            update_config['definition'] = definition
        if role_arn is not None:
            update_config['roleArn'] = role_arn

        if len(update_config) == 1:  # Only stateMachineArn
            return "Error: Must provide at least one field to update (definition or role_arn)"

        response = sfn_client.update_state_machine(**update_config)

        update_date = response.get('updateDate', 'N/A')
        if update_date != 'N/A':
            update_date = update_date.strftime('%Y-%m-%d %H:%M:%S')

        updated_fields = [k for k in update_config.keys() if k != 'stateMachineArn']

        result = f"""State Machine Updated:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
State Machine ARN: {state_machine_arn}
Updated Fields: {', '.join(updated_fields)}
Update Time: {update_date}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"""

        return result

    except Exception as e:
        return f"Error updating state machine {state_machine_arn}: {str(e)}"


@tool
def delete_stepfunctions_state_machine(state_machine_arn: str, region: str = "us-east-1") -> str:
    """
    Delete a Step Functions state machine.

    Args:
        state_machine_arn: ARN of the state machine to delete
        region: AWS region (default: us-east-1)

    Returns:
        A formatted string confirming deletion.
    """
    try:
        sfn_client = boto3.client('stepfunctions', region_name=region)
        sfn_client.delete_state_machine(stateMachineArn=state_machine_arn)

        return f"Successfully deleted state machine: {state_machine_arn}"

    except Exception as e:
        return f"Error deleting state machine {state_machine_arn}: {str(e)}"
