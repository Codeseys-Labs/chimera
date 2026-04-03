"""
Swarm Tools — Multi-agent orchestration for complex tasks

Provides tools for the Chimera agent to:
- Decompose complex requests into subtasks
- Spawn specialist agents for parallel execution
- Monitor task completion and aggregate results
- Handle blockers and escalations

These tools bridge the Python agent runtime to the TypeScript
SwarmExecutor via EventBridge events and DynamoDB state tracking.

Architecture:
  Agent → swarm_tools → EventBridge (chimera.agents/Swarm Execution Started)
                       → DynamoDB (swarm state tracking)
  Background: SwarmExecutor → TaskDecomposer → RoleAssigner → AgentOrchestrator
              → SQS (task delegation) → EventBridge (task completion)
              → DynamoDB (result aggregation)
  Agent ← poll DynamoDB for swarm execution result
"""

import json
import logging
import os
import time
from typing import Optional

import boto3
from strands.tools import tool

logger = logging.getLogger(__name__)


def _get_ddb():
    region = os.environ.get("AWS_REGION", "us-west-2")
    return boto3.resource("dynamodb", region_name=region)


def _get_eb():
    region = os.environ.get("AWS_REGION", "us-west-2")
    return boto3.client("events", region_name=region)


@tool
def decompose_and_execute(
    request: str,
    strategy: str = "plan-and-execute",
    max_subtasks: int = 10,
    tenant_id: str = "",
    session_id: str = "",
) -> str:
    """
    Decompose a complex request into subtasks and execute them in parallel via a swarm of agents.

    Use this for tasks that would benefit from parallel execution or specialist agents:
    - "Build a data pipeline with S3 ingestion, Lambda processing, and DynamoDB storage"
    - "Research and compare 3 AWS database options, then recommend one"
    - "Set up monitoring for all our Lambda functions with alarms and dashboards"

    The swarm executor will:
    1. Decompose the request into subtasks with dependency graph
    2. Build execution waves (tasks that can run in parallel)
    3. Assign specialist agents to each subtask
    4. Execute waves sequentially, tasks within waves in parallel
    5. Handle failures and blockers
    6. Aggregate results

    Args:
        request: The complex task description to decompose and execute.
        strategy: Decomposition strategy - "plan-and-execute" (default), "tree-of-thought",
                  "recursive", "goal-decomposition", "dependency-aware".
        max_subtasks: Maximum number of subtasks to create (default 10, max 20).
        tenant_id: Tenant ID for isolation.
        session_id: Session ID for tracking.

    Returns:
        Swarm execution ID for monitoring progress, or error message.
    """
    if not tenant_id:
        return "Error: tenant_id is required for swarm execution."

    max_subtasks = min(max_subtasks, 20)
    execution_id = f"swarm_{int(time.time())}_{os.urandom(4).hex()}"
    table_name = os.environ.get("CHIMERA_SESSIONS_TABLE", "chimera-sessions-dev")
    event_bus = os.environ.get("EVENT_BUS_NAME", "chimera-agents-dev")

    try:
        ddb = _get_ddb()
        table = ddb.Table(table_name)
        eb = _get_eb()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Write initial swarm execution record
        table.put_item(
            Item={
                "PK": f"TENANT#{tenant_id}#SWARM#{execution_id}",
                "SK": "EXECUTION",
                "executionId": execution_id,
                "tenantId": tenant_id,
                "sessionId": session_id,
                "request": request[:2000],
                "strategy": strategy,
                "maxSubtasks": max_subtasks,
                "status": "decomposing",
                "createdAt": now,
            }
        )

        # Publish swarm execution event to trigger the TypeScript SwarmExecutor
        eb.put_events(
            Entries=[
                {
                    "Source": "chimera.agents",
                    "DetailType": "Swarm Execution Started",
                    "EventBusName": event_bus,
                    "Detail": json.dumps(
                        {
                            "executionId": execution_id,
                            "tenantId": tenant_id,
                            "sessionId": session_id,
                            "request": request[:2000],
                            "strategy": strategy,
                            "maxSubtasks": max_subtasks,
                        }
                    ),
                }
            ]
        )

        return (
            f"SWARM EXECUTION STARTED\n"
            f"{'=' * 50}\n"
            f"Execution ID: {execution_id}\n"
            f"Strategy:     {strategy}\n"
            f"Max subtasks: {max_subtasks}\n"
            f"{'=' * 50}\n\n"
            f"The swarm executor is decomposing your request and will assign\n"
            f"specialist agents to work on subtasks in parallel.\n\n"
            f"Monitor progress with: check_swarm_status('{execution_id}')\n"
            f"Wait for completion with: wait_for_swarm('{execution_id}')"
        )

    except Exception as e:
        logger.error(f"Swarm execution failed: {e}")
        return f"Failed to start swarm execution: {str(e)[:500]}"


@tool
def check_swarm_status(
    execution_id: str,
    tenant_id: str = "",
) -> str:
    """
    Check the status of a multi-agent swarm execution.

    Args:
        execution_id: The swarm execution ID returned by decompose_and_execute.
        tenant_id: Tenant ID for isolation.

    Returns:
        Current execution status with task progress details.
    """
    if not tenant_id:
        return "Error: tenant_id is required."

    table_name = os.environ.get("CHIMERA_SESSIONS_TABLE", "chimera-sessions-dev")

    try:
        ddb = _get_ddb()
        table = ddb.Table(table_name)

        # Get execution record
        response = table.get_item(
            Key={
                "PK": f"TENANT#{tenant_id}#SWARM#{execution_id}",
                "SK": "EXECUTION",
            }
        )

        if "Item" not in response:
            return f"Swarm execution '{execution_id}' not found."

        item = response["Item"]
        status = item.get("status", "unknown")
        waves_completed = item.get("wavesCompleted", 0)
        total_waves = item.get("totalWaves", "?")
        tasks_completed = item.get("tasksCompleted", 0)
        total_tasks = item.get("totalTasks", "?")
        summary = item.get("summary", "")

        result = (
            f"SWARM STATUS: {status.upper()}\n"
            f"{'=' * 50}\n"
            f"Execution: {execution_id}\n"
            f"Waves:     {waves_completed}/{total_waves}\n"
            f"Tasks:     {tasks_completed}/{total_tasks}\n"
        )

        if summary:
            result += f"\nSummary:\n{summary}\n"

        # Get individual task results
        tasks_response = table.query(
            KeyConditionExpression="PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues={
                ":pk": f"TENANT#{tenant_id}#SWARM#{execution_id}",
                ":prefix": "TASK#",
            },
        )

        if tasks_response.get("Items"):
            result += f"\nTask Details:\n"
            for task in tasks_response["Items"]:
                task_status = task.get("status", "unknown")
                task_desc = task.get("description", "N/A")[:60]
                icon = (
                    "✓"
                    if task_status == "completed"
                    else "✗"
                    if task_status == "failed"
                    else "..."
                    if task_status == "running"
                    else "○"
                )
                result += f"  {icon} {task_desc} [{task_status}]\n"

        return result

    except Exception as e:
        return f"Status check failed: {str(e)[:500]}"


@tool
def wait_for_swarm(
    execution_id: str,
    tenant_id: str = "",
    max_wait_seconds: int = 600,
    poll_interval_seconds: int = 15,
) -> str:
    """
    Wait for a multi-agent swarm execution to complete.

    Polls the execution status until it reaches a terminal state
    (completed, partial, failed) or times out.

    Args:
        execution_id: The swarm execution ID.
        tenant_id: Tenant ID for isolation.
        max_wait_seconds: Maximum time to wait (default 600 = 10 minutes).
        poll_interval_seconds: Seconds between status checks (default 15).

    Returns:
        Final execution result with all task outcomes.
    """
    if not tenant_id:
        return "Error: tenant_id is required."

    table_name = os.environ.get("CHIMERA_SESSIONS_TABLE", "chimera-sessions-dev")
    ddb = _get_ddb()
    table = ddb.Table(table_name)

    start_time = time.time()
    terminal_statuses = {"completed", "partial", "failed", "cancelled"}

    while (time.time() - start_time) < max_wait_seconds:
        try:
            response = table.get_item(
                Key={
                    "PK": f"TENANT#{tenant_id}#SWARM#{execution_id}",
                    "SK": "EXECUTION",
                }
            )

            if "Item" not in response:
                return f"Swarm execution '{execution_id}' not found."

            item = response["Item"]
            status = item.get("status", "unknown")

            if status in terminal_statuses:
                elapsed = int(time.time() - start_time)
                summary = item.get("summary", "No summary available.")
                return (
                    f"SWARM {status.upper()} (waited {elapsed}s)\n"
                    f"{'=' * 50}\n"
                    f"{summary}\n"
                    f"{'=' * 50}\n\n"
                    f"Use check_swarm_status('{execution_id}') for detailed task breakdown."
                )

        except Exception as e:
            logger.warning(f"Poll error: {e}")

        time.sleep(poll_interval_seconds)

    return (
        f"TIMEOUT after {max_wait_seconds}s — swarm still running.\n"
        f"Check again with: check_swarm_status('{execution_id}')"
    )


@tool
def delegate_subtask(
    instruction: str,
    agent_role: str = "builder",
    priority: str = "normal",
    tenant_id: str = "",
    parent_task_id: str = "",
) -> str:
    """
    Delegate a single subtask to a specialist agent.

    Use this for targeted delegation when you don't need full swarm decomposition.
    The subtask runs asynchronously and results can be checked with check_swarm_status.

    Available agent roles:
    - "planner": Strategic planning and architecture design
    - "researcher": Information gathering and analysis
    - "builder": Implementation and code generation
    - "validator": Testing, verification, and quality checks
    - "coordinator": Orchestrating multiple agents

    Args:
        instruction: Clear, specific instruction for the specialist agent.
        agent_role: Agent specialization to assign (default: "builder").
        priority: "low", "normal", "high", "urgent" (default: "normal").
        tenant_id: Tenant ID for isolation.
        parent_task_id: Optional parent task/swarm ID for grouping.

    Returns:
        Task ID for monitoring, or error message.
    """
    if not tenant_id:
        return "Error: tenant_id is required."

    task_id = f"task_{int(time.time())}_{os.urandom(4).hex()}"
    table_name = os.environ.get("CHIMERA_SESSIONS_TABLE", "chimera-sessions-dev")
    event_bus = os.environ.get("EVENT_BUS_NAME", "chimera-agents-dev")

    try:
        ddb = _get_ddb()
        table = ddb.Table(table_name)
        eb = _get_eb()
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

        # Write task record
        table.put_item(
            Item={
                "PK": f"TENANT#{tenant_id}#TASK#{task_id}",
                "SK": "METADATA",
                "taskId": task_id,
                "tenantId": tenant_id,
                "instruction": instruction[:2000],
                "agentRole": agent_role,
                "priority": priority,
                "parentTaskId": parent_task_id or None,
                "status": "pending",
                "createdAt": now,
            }
        )

        # Publish task event
        eb.put_events(
            Entries=[
                {
                    "Source": "chimera.agents",
                    "DetailType": "Swarm Task Created",
                    "EventBusName": event_bus,
                    "Detail": json.dumps(
                        {
                            "taskId": task_id,
                            "tenantId": tenant_id,
                            "instruction": instruction[:2000],
                            "agentRole": agent_role,
                            "priority": priority,
                            "parentTaskId": parent_task_id,
                        }
                    ),
                }
            ]
        )

        return (
            f"Task delegated: {task_id}\n"
            f"Role: {agent_role} | Priority: {priority}\n"
            f"Instruction: {instruction[:100]}...\n\n"
            f"The {agent_role} agent will work on this asynchronously.\n"
            f"Check progress: check_swarm_status('{task_id}')"
        )

    except Exception as e:
        return f"Delegation failed: {str(e)[:500]}"
