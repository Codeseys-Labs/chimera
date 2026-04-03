"""
Evolution Tools - Self-evolution capabilities for premium Chimera agents

Provides tools for agents to trigger infrastructure evolution via CodeCommit/
CodePipeline, register new capabilities in the Gateway skills registry, and
monitor deployment status.

Self-evolution flow:
1. Agent calls trigger_infra_evolution with CDK TypeScript stack code
2. Tool validates Cedar policy + rate limits + basic CDK syntax
3. Tool commits CDK code to CodeCommit (triggers CI/CD pipeline)
4. Pipeline validates (cdk synth, CDK Nag), deploys to staging then prod
5. Agent calls register_capability to surface new tools via Gateway discovery

Safety rails:
- Cedar policy validation via AWS Verified Permissions
- Rate limit: max 5 evolution requests per tenant per day
- Kill switch: SSM /chimera/evolution/self-modify-enabled/{env}
- Forbidden CDK patterns: AdministratorAccess, wildcard IAM grants
- Audit trail: all requests recorded in DynamoDB evolution-state table

Environment variables:
- EVOLUTION_TABLE   DynamoDB evolution state table (default: chimera-evolution-state)
- SKILLS_TABLE      DynamoDB skills registry table (default: chimera-skills)
- CEDAR_POLICY_STORE_ID  Verified Permissions policy store ID (optional; skips if unset)
- CHIMERA_ENV_NAME  Deployment environment for SSM param paths (default: dev)
"""
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

import boto3
from strands.tools import tool

logger = logging.getLogger(__name__)

# Forbidden CDK patterns that agents may never emit.
# Checked as literal substrings (case-sensitive) before committing.
# This list MUST stay in sync with the TypeScript orchestrator's
# BLOCKED_CDK_PATTERNS in packages/core/src/evolution/self-evolution-orchestrator.ts.
_FORBIDDEN_CDK_PATTERNS: list[tuple[str, str]] = [
    # IAM escalation
    ('AdministratorAccess', 'AdministratorAccess managed policy is forbidden'),
    ('PowerUserAccess', 'PowerUserAccess managed policy is forbidden'),
    ('addToPolicy', 'Direct IAM policy mutations are forbidden — use pre-approved constructs'),
    ('grantAdmin', 'IAM admin grants are forbidden'),
    ('grant(*)', 'Wildcard IAM grants are forbidden'),
    # Wildcard resources — multiple quote styles (no trailing \n required)
    ('"*"', 'Bare wildcard resource string is forbidden'),
    ("'*'", 'Bare wildcard resource string is forbidden'),
    ('`*`', 'Bare wildcard resource string (template literal) is forbidden'),
    # Destructive operations
    ('RemovalPolicy.DESTROY', 'RemovalPolicy.DESTROY is forbidden in agent-generated stacks'),
    ('.deleteTable', 'DynamoDB table deletion is forbidden'),
    ('.deleteBucket', 'S3 bucket deletion is forbidden'),
    # Network/Security modifications
    ('ec2.Vpc', 'VPC creation/modification is forbidden in agent-generated stacks'),
    ('ec2.CfnVPC', 'VPC creation/modification is forbidden in agent-generated stacks'),
    ('ec2.SecurityGroup', 'Security group creation is forbidden — use shared groups from NetworkStack'),
    ('addIngressRule', 'Security group rule modifications are forbidden'),
    ('addEgressRule', 'Security group rule modifications are forbidden'),
    # Cross-stack resource access
    ('fromLookup', 'Resource lookups are forbidden — accept resources as stack props'),
]

# Maximum allowed CDK stack file size (bytes, UTF-8 encoded).
_MAX_CDK_SIZE = 65_536  # 64 KB — matches TypeScript orchestrator limit


# ---------------------------------------------------------------------------
# Public tools
# ---------------------------------------------------------------------------


@tool
def trigger_infra_evolution(
    capability_name: str,
    cdk_stack_code: str,
    tenant_id: str,
    rationale: str,
    estimated_monthly_cost_usd: float = 0.0,
    target_repo: str = "chimera-infra",
    region: str = "us-east-1",
) -> str:
    """
    Trigger infrastructure self-evolution by committing a CDK stack to CodeCommit.

    The CI/CD pipeline automatically validates (cdk synth, CDK Nag security scan),
    deploys to staging, then promotes to production if all checks pass.

    Args:
        capability_name: Short slug for the new capability (e.g., 'media-ingestion').
                         Use lowercase letters, numbers, and hyphens only.
        cdk_stack_code: Complete CDK TypeScript stack class (must extend cdk.Stack).
        tenant_id: Tenant initiating the evolution (from JWT claims).
        rationale: Human-readable explanation of why this capability is needed.
        estimated_monthly_cost_usd: Estimated incremental AWS cost per month in USD.
        target_repo: CodeCommit repository name (default: chimera-infra).
        region: AWS region (default: us-east-1).

    Returns:
        Evolution request ID and pipeline status on success, or an error message.
    """
    # 1. Kill switch — operator can disable all evolution
    kill = _check_kill_switch(region)
    if not kill['enabled']:
        return f"Evolution disabled: {kill['reason']}"

    # 2. Cedar policy — check the tenant is allowed to evolve
    policy = _validate_evolution_policy(
        tenant_id, capability_name, estimated_monthly_cost_usd, region
    )
    if not policy['allowed']:
        return f"Evolution denied by policy: {policy['reason']}"

    # 3. Rate limit — max 5 evolution requests per tenant per calendar day
    rate = _check_evolution_rate_limit(tenant_id)
    if not rate['allowed']:
        return f"Evolution rate limit exceeded: {rate['reason']}"

    # 4. Basic CDK validation
    validation = _validate_cdk_code(cdk_stack_code)
    if not validation['valid']:
        return f"CDK code validation failed: {validation['reason']}"

    # 5. Commit to CodeCommit — this triggers the pipeline via EventBridge
    timestamp = datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')
    evolution_id = f"evo-{tenant_id[:8]}-{capability_name[:20]}-{timestamp}"
    file_path = f"infra/lib/agent-evolved/{capability_name}-stack.ts"

    commit_result = _commit_to_codecommit(
        repo_name=target_repo,
        file_path=file_path,
        content=cdk_stack_code,
        commit_message=(
            f"Agent evolution: Add {capability_name} stack\n\n"
            f"Tenant: {tenant_id}\n"
            f"Rationale: {rationale}\n"
            f"Evolution ID: {evolution_id}"
        ),
        region=region,
    )
    if 'error' in commit_result:
        return f"Failed to commit CDK code to {target_repo}: {commit_result['error']}"

    # 6. Audit record in DynamoDB
    _record_evolution_request(
        evolution_id=evolution_id,
        tenant_id=tenant_id,
        capability_name=capability_name,
        file_path=file_path,
        commit_id=commit_result.get('commit_id', ''),
        rationale=rationale,
        estimated_cost=estimated_monthly_cost_usd,
    )

    return (
        f"Evolution request submitted successfully!\n\n"
        f"Evolution ID: {evolution_id}\n"
        f"Capability: {capability_name}\n"
        f"File committed: {file_path}\n"
        f"Commit ID: {commit_result.get('commit_id', 'N/A')}\n\n"
        f"The CI/CD pipeline will now:\n"
        f"  1. Validate CDK syntax (cdk synth)\n"
        f"  2. Run security scans (CDK Nag)\n"
        f"  3. Deploy to staging\n"
        f"  4. Promote to production if all checks pass\n\n"
        f"Use check_evolution_status('{evolution_id}') to monitor progress."
    )


@tool
def check_evolution_status(
    evolution_id: str,
    pipeline_name: str = "chimera-infra-pipeline",
    region: str = "us-east-1",
) -> str:
    """
    Check the deployment status of a self-evolution request.

    Args:
        evolution_id: Evolution ID returned by trigger_infra_evolution.
        pipeline_name: CodePipeline watching the infra repo (default: chimera-infra-pipeline).
        region: AWS region (default: us-east-1).

    Returns:
        Current pipeline stage and overall status.
    """
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(os.environ.get('EVOLUTION_TABLE', 'chimera-evolution-state'))

    response = table.get_item(
        Key={'PK': f'EVOLUTION#{evolution_id}', 'SK': 'REQUEST'}
    )

    if 'Item' not in response:
        return (
            f"Evolution ID '{evolution_id}' not found. "
            "It may have been archived or the ID is incorrect."
        )

    item = response['Item']
    commit_id = item.get('commit_id', 'N/A')
    capability_name = item.get('capability_name', 'unknown')
    submitted_at = item.get('submitted_at', 'N/A')

    # Fetch live pipeline state
    pipeline_section = _format_pipeline_status(pipeline_name, region)

    return (
        f"Evolution Status: {evolution_id}\n"
        f"{'━' * 50}\n"
        f"Capability: {capability_name}\n"
        f"Commit ID:  {commit_id}\n"
        f"Submitted:  {submitted_at}\n"
        f"{pipeline_section}\n"
        f"{'━' * 50}"
    )


@tool
def wait_for_evolution_deployment(
    evolution_id: str,
    max_wait_seconds: int = 900,
    poll_interval_seconds: int = 30,
    region: str = "us-east-1",
) -> str:
    """
    Wait for an infrastructure evolution deployment to complete.

    Polls the evolution state table until the status transitions from 'deploying'
    to 'deployed', 'deploy_failed', or 'stopped', or until the timeout expires.

    Use this after calling trigger_infra_evolution to wait for the CI/CD pipeline
    to finish and know whether your infrastructure change was successful.

    Args:
        evolution_id: Evolution ID returned by trigger_infra_evolution.
        max_wait_seconds: Maximum time to wait in seconds (default: 900 = 15 minutes).
        poll_interval_seconds: Seconds between status checks (default: 30).
        region: AWS region (default: us-east-1).

    Returns:
        Final deployment status with details, or timeout message.
    """
    import time

    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(os.environ.get('EVOLUTION_TABLE', 'chimera-evolution-state'))

    start_time = time.time()
    elapsed = 0
    last_status = 'unknown'

    while elapsed < max_wait_seconds:
        try:
            response = table.get_item(
                Key={'PK': f'EVOLUTION#{evolution_id}', 'SK': 'REQUEST'}
            )

            if 'Item' not in response:
                return (
                    f"Evolution ID '{evolution_id}' not found in state table. "
                    "It may not have been recorded yet — wait a moment and retry."
                )

            item = response['Item']
            last_status = item.get('status', 'unknown')
            capability = item.get('capability_name', 'unknown')
            commit_id = item.get('commit_id', 'N/A')
            exec_id = item.get('pipeline_execution_id', 'N/A')

            # Terminal states
            if last_status == 'deployed':
                return (
                    f"DEPLOYMENT SUCCEEDED\n"
                    f"{'=' * 50}\n"
                    f"Evolution:  {evolution_id}\n"
                    f"Capability: {capability}\n"
                    f"Commit:     {commit_id}\n"
                    f"Pipeline:   {exec_id}\n"
                    f"Duration:   {int(elapsed)}s\n"
                    f"{'=' * 50}\n\n"
                    f"The infrastructure is live. You can now:\n"
                    f"  1. Verify the new resources with check_evolution_status()\n"
                    f"  2. Register tools with register_capability() if applicable\n"
                    f"  3. Test the new capability"
                )

            if last_status == 'deploy_failed':
                return (
                    f"DEPLOYMENT FAILED\n"
                    f"{'=' * 50}\n"
                    f"Evolution:  {evolution_id}\n"
                    f"Capability: {capability}\n"
                    f"Commit:     {commit_id}\n"
                    f"Pipeline:   {exec_id}\n"
                    f"Duration:   {int(elapsed)}s\n"
                    f"{'=' * 50}\n\n"
                    f"The pipeline failed. Investigate:\n"
                    f"  1. Check pipeline logs for build/deploy errors\n"
                    f"  2. The CDK code may have synthesis errors\n"
                    f"  3. Consider fixing the code and re-triggering evolution"
                )

            if last_status == 'stopped':
                return (
                    f"DEPLOYMENT STOPPED\n"
                    f"Evolution: {evolution_id} | Status: {last_status}\n"
                    f"The pipeline was manually stopped. Re-trigger if needed."
                )

        except Exception as e:
            logger.warning(f"Error polling evolution status: {e}")

        # Still deploying — wait and poll again
        time.sleep(poll_interval_seconds)
        elapsed = time.time() - start_time

    return (
        f"TIMEOUT — deployment still in progress after {max_wait_seconds}s\n"
        f"Evolution: {evolution_id} | Last status: {last_status}\n"
        f"The pipeline may still be running. Check with check_evolution_status()."
    )


@tool
def register_capability(
    capability_name: str,
    tool_module: str,
    tool_names: list,
    tier: int,
    description: str,
    tenant_id: str,
    region: str = "us-east-1",
) -> str:
    """
    Register a deployed capability in the Chimera Gateway skills registry.

    Call this after successful infrastructure evolution so Gateway discovery
    exposes the new tools to qualifying tenants.

    Args:
        capability_name: Unique slug for the capability (e.g., 'media-ingestion').
        tool_module: Python module path (e.g., 'tools.media_ingestion_tools').
        tool_names: List of exported tool function names in the module.
        tier: Minimum tenant tier required: 1 (basic+), 2 (advanced+), 3 (premium).
        description: Human-readable description shown in Gateway discovery.
        tenant_id: Tenant registering the capability.
        region: AWS region (default: us-east-1).

    Returns:
        Confirmation message on success, or an error description.
    """
    if tier not in (1, 2, 3):
        return f"Invalid tier {tier}. Must be 1 (basic+), 2 (advanced+), or 3 (premium)."

    if not tool_names:
        return "tool_names must be a non-empty list."

    registered_at = datetime.now(timezone.utc).isoformat()
    dynamodb = boto3.resource('dynamodb', region_name=region)
    skills_table = dynamodb.Table(os.environ.get('SKILLS_TABLE', 'chimera-skills'))

    try:
        skills_table.put_item(
            Item={
                'PK': f'SKILL#{capability_name}',
                'SK': 'REGISTRY',
                'capability_name': capability_name,
                'tool_module': tool_module,
                'tool_names': tool_names,
                'tier': tier,
                'description': description,
                'registered_by': tenant_id,
                'registered_at': registered_at,
                'status': 'ACTIVE',
            }
        )
    except Exception as e:
        return f"Failed to register capability: {str(e)}"

    # Mirror to evolution audit table for traceability
    try:
        evolution_table = dynamodb.Table(
            os.environ.get('EVOLUTION_TABLE', 'chimera-evolution-state')
        )
        evolution_table.put_item(
            Item={
                'PK': f'TENANT#{tenant_id}#CAPABILITIES',
                'SK': f'REGISTERED#{capability_name}#{registered_at}',
                'capability_name': capability_name,
                'tool_module': tool_module,
                'tool_names': tool_names,
                'tier': tier,
                'description': description,
                'registered_at': registered_at,
                'ttl': int(
                    (datetime.now(timezone.utc) + timedelta(days=365)).timestamp()
                ),
            }
        )
    except Exception as e:
        logger.warning("Failed to mirror capability registration to evolution table: %s", e)

    tier_labels = {1: 'basic+', 2: 'advanced+', 3: 'premium'}
    return (
        f"Capability registered successfully!\n\n"
        f"Name:        {capability_name}\n"
        f"Module:      {tool_module}\n"
        f"Tools:       {', '.join(tool_names)}\n"
        f"Tier:        {tier} ({tier_labels.get(tier, 'unknown')})\n"
        f"Description: {description}\n"
        f"Registered:  {registered_at}\n\n"
        f"New tools are discoverable via Gateway for qualifying tenants.\n"
        f"Note: Existing agent sessions must reconnect to pick up new tools."
    )


@tool
def list_evolution_history(
    tenant_id: str,
    limit: int = 10,
    region: str = "us-east-1",
) -> str:
    """
    List recent self-evolution requests for a tenant.

    Args:
        tenant_id: Tenant whose evolution history to retrieve.
        limit: Maximum records to return (default: 10, max: 50).
        region: AWS region (default: us-east-1).

    Returns:
        Formatted list of evolution requests with status.
    """
    limit = min(max(limit, 1), 50)
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(os.environ.get('EVOLUTION_TABLE', 'chimera-evolution-state'))

    try:
        response = table.query(
            IndexName='GSI1-lifecycle',
            KeyConditionExpression='lifecycleIndexPK = :pk',
            ExpressionAttributeValues={':pk': f'TENANT#{tenant_id}#EVOLUTION'},
            ScanIndexForward=False,
            Limit=limit,
        )
    except Exception as e:
        return f"Failed to query evolution history: {str(e)}"

    items = response.get('Items', [])
    if not items:
        return f"No evolution history found for tenant {tenant_id}."

    lines = [f"Evolution History ({len(items)} records):\n"]
    for item in items:
        eid = item.get('evolution_id', 'unknown')
        capability = item.get('capability_name', 'unknown')
        status = item.get('status', 'UNKNOWN')
        submitted_at = item.get('submitted_at', 'N/A')
        rationale = item.get('rationale', '')[:100]

        lines.append(f"• {eid}")
        lines.append(f"  Capability: {capability}")
        lines.append(f"  Status:     {status}")
        lines.append(f"  Submitted:  {submitted_at}")
        if rationale:
            lines.append(f"  Rationale:  {rationale}")
        lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Internal helpers — not exposed as tools
# ---------------------------------------------------------------------------


def _check_kill_switch(region: str = "us-east-1") -> dict:
    """Read SSM kill switch for self-evolution. Fails open if parameter is missing."""
    try:
        ssm = boto3.client('ssm', region_name=region)
        env_name = os.environ.get('CHIMERA_ENV_NAME', 'dev')
        resp = ssm.get_parameter(
            Name=f'/chimera/evolution/self-modify-enabled/{env_name}'
        )
        enabled = resp['Parameter']['Value'].lower() == 'true'
        return {'enabled': enabled, 'reason': '' if enabled else 'Kill switch is off'}
    except Exception as exc:
        logger.warning("Kill switch SSM param not found, defaulting to enabled: %s", exc)
        return {'enabled': True, 'reason': ''}


def _validate_evolution_policy(
    tenant_id: str,
    capability_name: str,
    estimated_cost: float,
    region: str,
) -> dict:
    """
    Validate evolution request against Cedar policies via AWS Verified Permissions.

    Fails open (allows) when CEDAR_POLICY_STORE_ID is not set or when AVP
    is unavailable, so dev/test environments don't require a policy store.
    """
    policy_store_id = os.environ.get('CEDAR_POLICY_STORE_ID', '')
    if not policy_store_id:
        logger.warning(
            "CEDAR_POLICY_STORE_ID not configured; skipping Cedar policy check"
        )
        return {'allowed': True, 'reason': ''}

    try:
        avp = boto3.client('verifiedpermissions', region_name=region)
        response = avp.is_authorized(
            policyStoreId=policy_store_id,
            principal={'entityType': 'Chimera::Agent', 'entityId': tenant_id},
            action={'actionType': 'Chimera::Action', 'actionId': 'TriggerEvolution'},
            resource={'entityType': 'Chimera::Platform', 'entityId': 'infra'},
            context={
                'contextMap': {
                    'capability_name': {'string': capability_name},
                    'estimated_monthly_cost': {'decimal': str(estimated_cost)},
                }
            },
        )
        allowed = response.get('decision') == 'ALLOW'
        determining = response.get('determiningPolicies', [])
        reason = determining[0].get('policyId', 'Policy denied') if (not allowed and determining) else ''
        return {'allowed': allowed, 'reason': reason}

    except Exception as exc:
        logger.warning("Cedar policy check unavailable, defaulting to allowed: %s", exc)
        return {'allowed': True, 'reason': ''}


def _check_evolution_rate_limit(tenant_id: str) -> dict:
    """
    Enforce per-tenant daily evolution rate limit (default: 5 per day).

    Uses DynamoDB conditional atomic increment. Fails open if DynamoDB
    is unavailable.
    """
    try:
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(
            os.environ.get('EVOLUTION_TABLE', 'chimera-evolution-state')
        )
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        pk = f'TENANT#{tenant_id}#RATE'
        sk = f'EVOLUTION#{today}'

        # Read current count first (allows graceful limit reporting)
        get_resp = table.get_item(Key={'PK': pk, 'SK': sk})
        item = get_resp.get('Item', {})
        count = int(item.get('count', 0))
        daily_limit = int(item.get('limit', 5))

        if count >= daily_limit:
            return {
                'allowed': False,
                'reason': f'Daily limit of {daily_limit} reached ({count}/{daily_limit})',
            }

        # Increment atomically
        table.update_item(
            Key={'PK': pk, 'SK': sk},
            UpdateExpression=(
                'ADD #cnt :one '
                'SET #lim = if_not_exists(#lim, :dlim), '
                '    #ttl = :ttl'
            ),
            ExpressionAttributeNames={
                '#cnt': 'count',
                '#lim': 'limit',
                '#ttl': 'ttl',
            },
            ExpressionAttributeValues={
                ':one': 1,
                ':dlim': 5,
                ':ttl': int(
                    (datetime.now(timezone.utc) + timedelta(days=2)).timestamp()
                ),
            },
        )
        return {'allowed': True, 'reason': ''}

    except Exception as exc:
        logger.warning("Rate limit check failed, defaulting to allowed: %s", exc)
        return {'allowed': True, 'reason': ''}


def _validate_cdk_code(cdk_code: str) -> dict:
    """
    Basic structural validation of agent-generated CDK TypeScript code.

    Checks:
    - Non-empty
    - Under 100 KB
    - Looks like a CDK Stack class
    - No forbidden security patterns
    """
    if not cdk_code or not cdk_code.strip():
        return {'valid': False, 'reason': 'CDK code is empty'}

    encoded_size = len(cdk_code.encode('utf-8'))
    if encoded_size > _MAX_CDK_SIZE:
        return {
            'valid': False,
            'reason': f'CDK code is {encoded_size} bytes; limit is {_MAX_CDK_SIZE}',
        }

    # Must contain a CDK Stack class definition (not just the words in a comment)
    import re
    if not re.search(r'class\s+\w+\s+extends\s+\w*Stack', cdk_code):
        return {'valid': False, 'reason': 'Code must contain a CDK Stack class definition (class XxxStack extends cdk.Stack)'}

    for pattern, reason in _FORBIDDEN_CDK_PATTERNS:
        if pattern in cdk_code:
            return {'valid': False, 'reason': reason}

    return {'valid': True, 'reason': ''}


def _commit_to_codecommit(
    repo_name: str,
    file_path: str,
    content: str,
    commit_message: str,
    region: str,
) -> dict:
    """
    Commit a file to the default (main) branch of a CodeCommit repository.

    Returns {'commit_id': str} on success or {'error': str} on failure.
    Uses the CodeCommit CreateCommit API (no local git required).
    """
    try:
        codecommit = boto3.client('codecommit', region_name=region)

        branch_resp = codecommit.get_branch(
            repositoryName=repo_name, branchName='main'
        )
        parent_commit_id = branch_resp['branch']['commitId']

        commit_resp = codecommit.create_commit(
            repositoryName=repo_name,
            branchName='main',
            parentCommitId=parent_commit_id,
            authorName='Chimera Self-Evolution Agent',
            email='agent@chimera.internal',
            commitMessage=commit_message,
            putFiles=[
                {
                    'filePath': file_path,
                    'fileMode': 'NORMAL',
                    'fileContent': content.encode('utf-8'),
                }
            ],
        )
        return {'commit_id': commit_resp['commitId']}

    except Exception as exc:
        return {'error': str(exc)}


def _format_pipeline_status(pipeline_name: str, region: str) -> str:
    """Return a formatted summary of the latest CodePipeline execution."""
    try:
        codepipeline = boto3.client('codepipeline', region_name=region)
        state = codepipeline.get_pipeline_state(name=pipeline_name)
        stages = state.get('stageStates', [])

        lines = [f"\nPipeline: {pipeline_name}"]
        overall = 'IN_PROGRESS'

        for stage in stages:
            stage_name = stage['stageName']
            latest = stage.get('latestExecution', {})
            status = latest.get('status', 'Not started')
            lines.append(f"  • {stage_name}: {status}")

            if status == 'Failed':
                overall = 'Failed'
            elif status == 'Succeeded' and stage is stages[-1]:
                overall = 'Succeeded'

        lines.insert(1, f"Overall Status: {overall}")
        return '\n'.join(lines)

    except Exception as exc:
        return f"\nPipeline status unavailable: {exc}"


def _record_evolution_request(
    evolution_id: str,
    tenant_id: str,
    capability_name: str,
    file_path: str,
    commit_id: str,
    rationale: str,
    estimated_cost: float,
) -> None:
    """Record evolution request in DynamoDB for audit and status tracking."""
    try:
        dynamodb = boto3.resource('dynamodb')
        table = dynamodb.Table(
            os.environ.get('EVOLUTION_TABLE', 'chimera-evolution-state')
        )
        submitted_at = datetime.now(timezone.utc).isoformat()
        table.put_item(
            Item={
                'PK': f'EVOLUTION#{evolution_id}',
                'SK': 'REQUEST',
                'evolution_id': evolution_id,
                'tenant_id': tenant_id,
                'capability_name': capability_name,
                'file_path': file_path,
                'commit_id': commit_id,
                'rationale': rationale,
                'estimated_monthly_cost': str(estimated_cost),
                'status': 'PENDING',
                'submitted_at': submitted_at,
                # GSI1 key so list_evolution_history can query by tenant
                'lifecycleIndexPK': f'TENANT#{tenant_id}#EVOLUTION',
                'last_accessed': submitted_at,
                'ttl': int(
                    (datetime.now(timezone.utc) + timedelta(days=90)).timestamp()
                ),
            }
        )
    except Exception as exc:
        logger.error("Failed to record evolution request %s: %s", evolution_id, exc)
