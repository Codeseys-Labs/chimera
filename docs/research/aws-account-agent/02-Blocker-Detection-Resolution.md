---
title: Blocker Detection and Resolution in Autonomous Agent Swarms
date: 2026-03-20
status: complete
task: chimera-c487
tags:
  - autonomous-agents
  - blocker-detection
  - error-handling
  - self-healing
  - agent-coordination
---

# Blocker Detection and Resolution in Autonomous Agent Swarms

> **Research Focus**: How autonomous agents identify execution blockers, resolve them autonomously, and escalate appropriately when human intervention is required

---

## Table of Contents

- [[#Executive Summary]]
- [[#Types of Blockers]]
- [[#Detection Mechanisms]]
- [[#Resolution Strategies]]
  - [[#Autonomous Resolution]]
  - [[#Agent-to-Agent Collaboration]]
  - [[#Human Escalation]]
- [[#Blocker Patterns and Solutions]]
- [[#AWS-Specific Blockers]]
- [[#Multi-Agent Coordination for Blockers]]
- [[#Learning from Blockers]]
- [[#Real-World Examples]]
- [[#Key Takeaways]]
- [[#Sources]]

---

## Executive Summary

**Blocker detection and resolution** is what separates autonomous agent swarms from simple automation scripts. When a task fails, intelligent agents must:

1. **Detect the blocker**: Identify root cause (missing dependency, permission denied, rate limit, invalid input)
2. **Classify severity**: Critical (blocks all work), high (blocks this task), medium (workaround exists), low (cosmetic)
3. **Attempt autonomous resolution**: Fix permissions, provision resources, retry with backoff, find alternatives
4. **Collaborate if needed**: Ask another agent with different permissions/capabilities
5. **Escalate appropriately**: Human intervention for decisions, approvals, external dependencies

**Core Insight**: Most blockers fall into predictable categories (permissions, dependencies, rate limits, invalid state). Agents can maintain a **blocker resolution playbook** that maps error patterns to resolution strategies, learning from successes and failures.

**Key Blocker Categories:**
- **Missing Dependencies**: Service not deployed, table doesn't exist, config not set
- **Permission Denied**: IAM policies insufficient, API keys missing, role not assumed
- **Rate Limits**: API throttling, concurrent execution limits, quota exceeded
- **Invalid State**: Resource in wrong state (creating, deleting, locked)
- **Validation Failures**: Input validation, constraint violations, uniqueness conflicts
- **External Dependencies**: Third-party service down, DNS resolution failed, network timeout

**Resolution Patterns:**
- **Provision-on-Demand**: Create missing resources automatically
- **Permission Escalation**: Request elevated permissions or assume different role
- **Retry with Backoff**: Exponential backoff for transient failures
- **Workaround Discovery**: Find alternative approach (e.g., different API, different tool)
- **Decompose Further**: Break task into smaller steps to isolate blocker
- **Human-in-Loop**: Escalate for decisions, approvals, external coordination

---

## Types of Blockers

### 1. Missing Dependencies

**Definition**: Required resources, services, or configurations don't exist.

**Examples**:
```python
# Lambda deployment fails
Error: The security group 'sg-12345' does not exist
Blocker: Security group not created yet
Resolution: Create security group first, then retry Lambda deployment

# DynamoDB query fails
Error: Requested resource not found: Table: chimera-sessions
Blocker: Table doesn't exist in this account/region
Resolution: Provision table or use correct region

# API call fails
Error: Configuration not found: /app/config/database
Blocker: SSM Parameter Store value not set
Resolution: Create parameter with default value, ask user for production value
```

**Detection**:
```python
def detect_missing_dependency(error: Exception) -> Optional[Dependency]:
    """Detect if error is due to missing dependency."""
    error_patterns = {
        'ResourceNotFoundException': lambda e: Dependency(
            type='missing_resource',
            name=extract_resource_name(e),
            service=extract_service_name(e)
        ),
        'NoSuchEntity': lambda e: Dependency(
            type='missing_iam_entity',
            name=extract_entity_name(e)
        ),
        'TableNotFoundException': lambda e: Dependency(
            type='missing_table',
            name=extract_table_name(e)
        )
    }

    for pattern, extractor in error_patterns.items():
        if pattern in str(error):
            return extractor(error)

    return None
```

### 2. Permission Denied

**Definition**: Agent lacks IAM permissions, API keys, or credentials to perform action.

**Examples**:
```python
# IAM permission missing
Error: User: arn:aws:iam::123456789012:user/agent is not authorized to perform: dynamodb:CreateTable
Blocker: IAM policy doesn't grant CreateTable permission
Resolution: Request permission or assume role with permission

# API key invalid
Error: Invalid API key for service 'external-api'
Blocker: API key not configured or expired
Resolution: Retrieve valid API key from Secrets Manager, or ask user

# Cross-account access denied
Error: Access Denied when assuming role arn:aws:iam::987654321098:role/CrossAccountRole
Blocker: Trust relationship not configured
Resolution: Cannot auto-fix, escalate to user
```

**Detection**:
```python
def detect_permission_blocker(error: Exception) -> Optional[PermissionBlocker]:
    """Detect permission-related blockers."""
    if 'AccessDenied' in str(error) or 'UnauthorizedException' in str(error):
        # Parse error for specific action and resource
        action = extract_action_from_error(error)
        resource = extract_resource_from_error(error)

        return PermissionBlocker(
            action=action,
            resource=resource,
            current_principal=get_current_identity(),
            required_permission=infer_required_permission(action)
        )

    return None
```

### 3. Rate Limits

**Definition**: Service throttling due to TPS limits, concurrent execution quotas, or API rate limits.

**Examples**:
```python
# API throttling
Error: Rate exceeded: Maximum of 10 requests per second
Blocker: Too many API calls in short timeframe
Resolution: Implement exponential backoff, reduce concurrency

# Lambda concurrent execution limit
Error: Lambda function reached concurrent execution limit (1000)
Blocker: All execution slots in use
Resolution: Wait for executions to complete, or request limit increase

# DynamoDB throughput exceeded
Error: ProvisionedThroughputExceededException
Blocker: Read/write capacity exceeded
Resolution: Enable auto-scaling or switch to on-demand billing
```

**Detection**:
```python
def detect_rate_limit(error: Exception) -> Optional[RateLimitBlocker]:
    """Detect rate limiting errors."""
    rate_limit_patterns = [
        'ThrottlingException',
        'TooManyRequestsException',
        'Rate exceeded',
        'ConcurrentExecutionLimitExceeded',
        'ProvisionedThroughputExceededException'
    ]

    for pattern in rate_limit_patterns:
        if pattern in str(error):
            return RateLimitBlocker(
                service=extract_service(error),
                limit_type=classify_limit_type(pattern),
                retry_after=extract_retry_after(error)
            )

    return None
```

### 4. Invalid State

**Definition**: Resource exists but is in wrong state for requested operation.

**Examples**:
```python
# Resource being created
Error: Resource sg-12345 is in 'creating' state, operation not allowed
Blocker: Resource not ready
Resolution: Wait for creation to complete, then retry

# Resource locked
Error: Table 'chimera-sessions' is being updated, cannot modify
Blocker: Concurrent modification in progress
Resolution: Wait for update to complete

# Resource being deleted
Error: Cannot update resource in 'deleting' state
Blocker: Resource marked for deletion
Resolution: Abort operation or recreate resource after deletion completes
```

**Detection**:
```python
async def detect_invalid_state(error: Exception, resource_arn: str) -> Optional[StateBlocker]:
    """Detect state-related blockers."""
    if 'InvalidState' in str(error) or 'ResourceInUseException' in str(error):
        # Query resource to get current state
        current_state = await get_resource_state(resource_arn)

        valid_states = get_valid_states_for_operation(error)

        return StateBlocker(
            resource=resource_arn,
            current_state=current_state,
            required_states=valid_states,
            estimated_wait_time=estimate_state_transition_time(current_state, valid_states)
        )

    return None
```

### 5. Validation Failures

**Definition**: Input parameters fail validation rules (format, constraints, uniqueness).

**Examples**:
```python
# Invalid input format
Error: Invalid CIDR block: 10.0.0.0/33
Blocker: CIDR prefix must be /0 to /32
Resolution: Correct CIDR format, retry

# Constraint violation
Error: Subnet CIDR 10.0.1.0/24 overlaps with existing subnet
Blocker: CIDR collision
Resolution: Choose non-overlapping CIDR range

# Uniqueness violation
Error: Table 'chimera-tenants' already exists
Blocker: Duplicate table name
Resolution: Use existing table or choose different name
```

**Detection**:
```python
def detect_validation_failure(error: Exception) -> Optional[ValidationBlocker]:
    """Detect validation-related errors."""
    validation_patterns = {
        'InvalidParameterException': 'parameter_invalid',
        'ValidationException': 'validation_failed',
        'ConditionalCheckFailedException': 'condition_not_met',
        'ResourceAlreadyExistsException': 'duplicate_resource'
    }

    for pattern, failure_type in validation_patterns.items():
        if pattern in str(error):
            return ValidationBlocker(
                failure_type=failure_type,
                parameter=extract_parameter_name(error),
                provided_value=extract_parameter_value(error),
                expected_format=extract_expected_format(error)
            )

    return None
```

### 6. External Dependencies

**Definition**: Third-party service unavailable, network issues, DNS failures.

**Examples**:
```python
# Service unavailable
Error: Connection timeout to https://external-api.example.com
Blocker: External service down or unreachable
Resolution: Retry with backoff, use fallback endpoint if available

# DNS resolution failed
Error: Name or service not known: newservice.internal
Blocker: DNS record not yet propagated
Resolution: Wait for DNS propagation, use IP address temporarily

# Certificate expired
Error: SSL certificate expired for https://api.example.com
Blocker: TLS handshake failed
Resolution: Cannot auto-fix, escalate to user
```

**Detection**:
```python
async def detect_external_dependency_failure(error: Exception) -> Optional[ExternalBlocker]:
    """Detect external service failures."""
    if any(pattern in str(error) for pattern in [
        'ConnectionTimeout',
        'ConnectionRefused',
        'NameResolutionError',
        'SSLCertVerificationError',
        'ServiceUnavailable'
    ]):
        service_url = extract_service_url(error)

        # Test if service is actually down
        is_down = await health_check(service_url)

        return ExternalBlocker(
            service_url=service_url,
            error_type=classify_external_error(error),
            is_service_down=is_down,
            fallback_available=check_for_fallback(service_url)
        )

    return None
```

---

## Detection Mechanisms

### Proactive Detection

**Pattern**: Detect blockers before execution fails.

```python
async def preflight_check(task: Task) -> List[Blocker]:
    """
    Check for potential blockers before executing task.
    """
    blockers = []

    # Check 1: Dependencies exist?
    for dependency in task.dependencies:
        if not await resource_exists(dependency):
            blockers.append(MissingDependency(resource=dependency))

    # Check 2: Permissions granted?
    required_permissions = task.required_permissions
    current_permissions = await get_current_permissions()
    missing_permissions = set(required_permissions) - set(current_permissions)
    if missing_permissions:
        blockers.append(PermissionBlocker(missing=list(missing_permissions)))

    # Check 3: Within rate limits?
    if await rate_limit_exceeded(task.service):
        blockers.append(RateLimitBlocker(service=task.service))

    # Check 4: Resource in valid state?
    if task.target_resource:
        state = await get_resource_state(task.target_resource)
        if state not in task.valid_states:
            blockers.append(StateBlocker(
                resource=task.target_resource,
                current_state=state
            ))

    return blockers

# Usage
blockers = await preflight_check(task)
if blockers:
    # Resolve blockers before execution
    for blocker in blockers:
        await resolve_blocker(blocker)
```

### Reactive Detection

**Pattern**: Detect blockers from execution failures.

```python
async def execute_with_blocker_detection(task: Task) -> TaskResult:
    """
    Execute task and detect blockers from failures.
    """
    try:
        result = await execute_task(task)
        return TaskResult(status='success', result=result)

    except Exception as error:
        # Classify error as blocker
        blocker = classify_blocker(error, task)

        if blocker:
            # Attempt resolution
            resolution_result = await resolve_blocker(blocker)

            if resolution_result.resolved:
                # Retry task after resolution
                return await execute_with_blocker_detection(task)
            else:
                # Could not resolve
                return TaskResult(
                    status='blocked',
                    blocker=blocker,
                    resolution_attempted=resolution_result
                )
        else:
            # Not a blocker, just a failure
            return TaskResult(status='failed', error=error)

def classify_blocker(error: Exception, task: Task) -> Optional[Blocker]:
    """
    Classify exception as specific blocker type.
    """
    # Try each detector
    detectors = [
        detect_missing_dependency,
        detect_permission_blocker,
        detect_rate_limit,
        detect_invalid_state,
        detect_validation_failure,
        detect_external_dependency_failure
    ]

    for detector in detectors:
        blocker = detector(error)
        if blocker:
            blocker.task = task
            blocker.error = error
            return blocker

    return None
```

### Pattern-Based Detection

**Pattern**: Learn blocker patterns from history.

```python
class BlockerPatternMatcher:
    """
    Learn blocker patterns from execution history.
    """

    def __init__(self):
        self.known_patterns = []

    def learn_from_failure(self, error: Exception, blocker: Blocker, resolution: Resolution):
        """
        Record error pattern and successful resolution.
        """
        pattern = BlockerPattern(
            error_signature=self.compute_error_signature(error),
            blocker_type=type(blocker).__name__,
            resolution_strategy=resolution.strategy,
            success_rate=1.0
        )

        # Check if pattern already exists
        existing = self.find_pattern(pattern.error_signature)
        if existing:
            # Update success rate
            existing.success_rate = (existing.success_rate + 1.0) / 2
        else:
            self.known_patterns.append(pattern)

    def predict_blocker(self, error: Exception) -> Optional[Blocker]:
        """
        Use learned patterns to predict blocker from error.
        """
        error_sig = self.compute_error_signature(error)

        for pattern in self.known_patterns:
            if pattern.matches(error_sig):
                # Create blocker of predicted type
                return pattern.instantiate_blocker()

        return None

    def compute_error_signature(self, error: Exception) -> str:
        """
        Create fingerprint of error for pattern matching.
        """
        return f"{type(error).__name__}:{extract_error_code(error)}:{extract_service(error)}"
```

---

## Resolution Strategies

### Autonomous Resolution

**Goal**: Fix blockers without human intervention.

#### Strategy 1: Provision-on-Demand

```python
async def provision_missing_dependency(blocker: MissingDependency) -> Resolution:
    """
    Automatically create missing resources.
    """
    resource_type = blocker.dependency_type

    if resource_type == 'dynamodb_table':
        # Provision table with sensible defaults
        table_name = blocker.resource_name
        await create_dynamodb_table(
            table_name=table_name,
            key_schema={'pk': 'S', 'sk': 'S'},
            billing_mode='PAY_PER_REQUEST'
        )
        return Resolution(
            resolved=True,
            strategy='provision_on_demand',
            actions_taken=['Created DynamoDB table with default schema']
        )

    elif resource_type == 'security_group':
        # Create security group
        vpc_id = await get_default_vpc()
        sg_id = await create_security_group(
            name=blocker.resource_name,
            vpc_id=vpc_id,
            description='Auto-created by agent'
        )
        return Resolution(
            resolved=True,
            strategy='provision_on_demand',
            actions_taken=[f'Created security group {sg_id}']
        )

    elif resource_type == 'ssm_parameter':
        # Create parameter with placeholder
        await create_ssm_parameter(
            name=blocker.resource_name,
            value='PLACEHOLDER_VALUE',
            description='Auto-created by agent, update with real value'
        )
        return Resolution(
            resolved=True,
            strategy='provision_on_demand',
            actions_taken=['Created SSM parameter with placeholder'],
            requires_user_action='Update parameter with production value'
        )

    return Resolution(
        resolved=False,
        strategy='provision_on_demand',
        reason=f'Cannot auto-provision {resource_type}'
    )
```

#### Strategy 2: Permission Escalation

```python
async def escalate_permissions(blocker: PermissionBlocker) -> Resolution:
    """
    Attempt to gain required permissions.
    """
    required_action = blocker.required_permission

    # Strategy A: Assume role with required permission
    roles = await list_assumable_roles()
    for role in roles:
        if await role_has_permission(role, required_action):
            # Assume role
            credentials = await assume_role(role)
            # Update agent session with new credentials
            update_credentials(credentials)

            return Resolution(
                resolved=True,
                strategy='permission_escalation',
                actions_taken=[f'Assumed role {role} with required permissions']
            )

    # Strategy B: Request temporary permission elevation
    if can_request_permission_elevation():
        approval = await request_permission_elevation(
            action=required_action,
            reason=blocker.task.description,
            duration_minutes=60
        )

        if approval.granted:
            return Resolution(
                resolved=True,
                strategy='permission_escalation',
                actions_taken=['Received temporary permission elevation']
            )

    # Strategy C: Cannot escalate, must ask user
    return Resolution(
        resolved=False,
        strategy='permission_escalation',
        reason='No available roles with permission, human approval required'
    )
```

#### Strategy 3: Retry with Backoff

```python
async def retry_with_backoff(blocker: RateLimitBlocker, task: Task) -> Resolution:
    """
    Retry with exponential backoff for rate limits.
    """
    max_retries = 5
    base_delay = 1  # seconds

    for attempt in range(max_retries):
        # Exponential backoff
        delay = base_delay * (2 ** attempt)

        # Add jitter to avoid thundering herd
        jittered_delay = delay + random.uniform(0, delay * 0.1)

        await asyncio.sleep(jittered_delay)

        try:
            result = await execute_task(task)
            return Resolution(
                resolved=True,
                strategy='retry_with_backoff',
                actions_taken=[f'Succeeded after {attempt + 1} retries']
            )
        except Exception as error:
            if attempt == max_retries - 1:
                return Resolution(
                    resolved=False,
                    strategy='retry_with_backoff',
                    reason=f'Failed after {max_retries} retries'
                )
            # Continue retrying
```

#### Strategy 4: Workaround Discovery

```python
async def find_workaround(blocker: Blocker, task: Task) -> Resolution:
    """
    Find alternative approach when direct resolution fails.
    """

    # Example: If Lambda VPC attachment fails, try without VPC
    if isinstance(blocker, MissingDependency) and 'vpc' in blocker.resource_name.lower():
        # Try deploying Lambda without VPC
        alternative_task = task.copy()
        alternative_task.config['vpc_config'] = None

        try:
            result = await execute_task(alternative_task)
            return Resolution(
                resolved=True,
                strategy='workaround',
                actions_taken=['Deployed Lambda without VPC'],
                tradeoffs='Lambda cannot access VPC resources'
            )
        except Exception:
            pass

    # Example: If DynamoDB query fails, try scan with filter
    if isinstance(blocker, ValidationBlocker) and blocker.failure_type == 'query_invalid':
        alternative_task = task.copy()
        alternative_task.operation = 'scan'
        alternative_task.filter_expression = task.key_condition_expression

        try:
            result = await execute_task(alternative_task)
            return Resolution(
                resolved=True,
                strategy='workaround',
                actions_taken=['Used scan instead of query'],
                tradeoffs='Scan is less efficient than query'
            )
        except Exception:
            pass

    return Resolution(
        resolved=False,
        strategy='workaround',
        reason='No workaround found'
    )
```

### Agent-to-Agent Collaboration

**Goal**: Leverage other agents' capabilities or permissions.

```python
async def delegate_to_capable_agent(blocker: Blocker, task: Task) -> Resolution:
    """
    Hand off task to agent with required capabilities.
    """

    if isinstance(blocker, PermissionBlocker):
        # Find agent with required permission
        required_permission = blocker.required_permission

        agents = await discover_peer_agents()
        for agent in agents:
            if await agent_has_permission(agent, required_permission):
                # Delegate task to capable agent
                result = await agent.execute_task(task)

                return Resolution(
                    resolved=True,
                    strategy='agent_delegation',
                    actions_taken=[f'Delegated to agent {agent.id}']
                )

    elif isinstance(blocker, MissingDependency):
        # Find agent specialized in provisioning
        provisioning_agents = await discover_agents_by_capability('resource_provisioning')

        if provisioning_agents:
            # Ask provisioning agent to create resource
            resource = await provisioning_agents[0].provision_resource(
                resource_type=blocker.dependency_type,
                resource_name=blocker.resource_name
            )

            return Resolution(
                resolved=True,
                strategy='agent_delegation',
                actions_taken=[f'Provisioned {resource} via specialist agent']
            )

    return Resolution(
        resolved=False,
        strategy='agent_delegation',
        reason='No capable agent found'
    )
```

### Human Escalation

**Goal**: Request human intervention when autonomous resolution fails.

```python
class EscalationPolicy:
    """
    Determine when and how to escalate to humans.
    """

    def should_escalate(self, blocker: Blocker, resolution_attempts: List[Resolution]) -> bool:
        """
        Decide if human escalation is needed.
        """

        # Immediate escalation conditions
        if blocker.severity == 'critical' and len(resolution_attempts) == 0:
            return True

        # Escalate if all resolution attempts failed
        if all(not r.resolved for r in resolution_attempts):
            return True

        # Escalate if blocker requires decision
        if requires_human_decision(blocker):
            return True

        # Escalate if stuck for too long
        if blocker.time_elapsed > timedelta(hours=1):
            return True

        return False

    def determine_escalation_urgency(self, blocker: Blocker) -> str:
        """
        Classify escalation urgency.
        """
        if blocker.blocks_all_work:
            return 'urgent'  # PagerDuty alert
        elif blocker.blocks_production:
            return 'high'    # Slack notification
        elif blocker.blocks_current_task:
            return 'medium'  # Email notification
        else:
            return 'low'     # Background ticket

async def escalate_to_human(blocker: Blocker, resolution_attempts: List[Resolution]) -> Resolution:
    """
    Create human-readable escalation request.
    """

    policy = EscalationPolicy()
    urgency = policy.determine_escalation_urgency(blocker)

    escalation_request = {
        'title': f'Agent Blocked: {blocker.task.description}',
        'blocker_type': type(blocker).__name__,
        'description': blocker.explain(),
        'resolution_attempts': [
            {
                'strategy': r.strategy,
                'actions_taken': r.actions_taken,
                'reason_failed': r.reason if not r.resolved else None
            }
            for r in resolution_attempts
        ],
        'suggested_actions': blocker.suggest_human_actions(),
        'urgency': urgency,
        'context': {
            'task': blocker.task.to_dict(),
            'agent_id': get_agent_id(),
            'timestamp': datetime.utcnow().isoformat()
        }
    }

    # Send escalation based on urgency
    if urgency == 'urgent':
        await send_pagerduty_alert(escalation_request)
    elif urgency == 'high':
        await send_slack_notification(escalation_request)
    elif urgency == 'medium':
        await send_email(escalation_request)
    else:
        await create_jira_ticket(escalation_request)

    # Wait for human response
    response = await wait_for_human_response(escalation_request['id'])

    return Resolution(
        resolved=response.resolved,
        strategy='human_escalation',
        actions_taken=[response.action_description],
        human_guidance=response.guidance
    )
```

---

## Blocker Patterns and Solutions

### Pattern 1: Circular Dependency

**Problem**: Task A depends on Task B, Task B depends on Task A.

```python
# Detection
def detect_circular_dependency(task_graph: nx.DiGraph) -> List[List[str]]:
    """Find circular dependencies in task graph."""
    try:
        # If graph is acyclic, this succeeds
        nx.topological_sort(task_graph)
        return []
    except nx.NetworkXError:
        # Find cycles
        cycles = list(nx.simple_cycles(task_graph))
        return cycles

# Resolution
def resolve_circular_dependency(cycle: List[str]) -> Resolution:
    """
    Break circular dependency by:
    1. Identifying which dependency is optional
    2. Reordering tasks
    3. Introducing intermediate state
    """

    # Strategy: Create resources in specific order
    # Example: Lambda + Security Group
    # - Create SG with placeholder rule
    # - Create Lambda referencing SG
    # - Update SG rule to allow Lambda traffic

    reordered_tasks = break_cycle(cycle)

    return Resolution(
        resolved=True,
        strategy='break_circular_dependency',
        actions_taken=['Reordered tasks', 'Introduced intermediate state'],
        new_task_order=reordered_tasks
    )
```

### Pattern 2: Cascading Failures

**Problem**: One failed task causes downstream tasks to fail.

```python
# Detection
def detect_cascading_failure(execution_log: List[TaskResult]) -> Optional[CascadingFailure]:
    """
    Detect if failures are cascading from root cause.
    """
    failed_tasks = [r for r in execution_log if r.status == 'failed']

    # Group failures by time
    failure_clusters = cluster_by_time(failed_tasks, window_seconds=60)

    for cluster in failure_clusters:
        # Check if failures share common dependency
        common_dependency = find_common_dependency(cluster)
        if common_dependency:
            return CascadingFailure(
                root_cause=common_dependency,
                affected_tasks=cluster
            )

    return None

# Resolution
async def resolve_cascading_failure(cascade: CascadingFailure) -> Resolution:
    """
    Fix root cause, then retry affected tasks.
    """

    # Step 1: Fix root cause
    root_blocker = identify_blocker(cascade.root_cause)
    root_resolution = await resolve_blocker(root_blocker)

    if not root_resolution.resolved:
        return root_resolution  # Cannot fix cascade if root not fixed

    # Step 2: Retry affected tasks
    retry_results = []
    for task in cascade.affected_tasks:
        result = await execute_task(task)
        retry_results.append(result)

    return Resolution(
        resolved=all(r.status == 'success' for r in retry_results),
        strategy='fix_cascading_failure',
        actions_taken=[
            f'Fixed root cause: {cascade.root_cause}',
            f'Retried {len(retry_results)} affected tasks'
        ]
    )
```

### Pattern 3: Starvation

**Problem**: Task waiting indefinitely for resource/permission/dependency.

```python
# Detection
def detect_starvation(task: Task, wait_time: timedelta) -> bool:
    """
    Detect if task is starving (waiting too long).
    """
    STARVATION_THRESHOLD = timedelta(minutes=30)

    return wait_time > STARVATION_THRESHOLD

# Resolution
async def resolve_starvation(task: Task) -> Resolution:
    """
    Break starvation by:
    1. Finding alternative resource
    2. Decomposing task differently
    3. Escalating to human
    """

    # Strategy A: Find alternative resource
    if task.resource_requirements:
        alternative = await find_alternative_resource(task.resource_requirements)
        if alternative:
            task.resource_requirements = alternative
            return Resolution(
                resolved=True,
                strategy='alternative_resource',
                actions_taken=[f'Switched to alternative resource']
            )

    # Strategy B: Decompose differently
    alternative_decomposition = await redecompose_task(task)
    if alternative_decomposition:
        return Resolution(
            resolved=True,
            strategy='redecomposition',
            actions_taken=['Decomposed task differently to avoid starvation'],
            new_subtasks=alternative_decomposition
        )

    # Strategy C: Escalate
    return await escalate_to_human(
        blocker=StarvationBlocker(task=task, wait_time=wait_time),
        resolution_attempts=[]
    )
```

---

## AWS-Specific Blockers

### IAM Permission Boundaries

```python
async def resolve_permission_boundary_violation(blocker: PermissionBlocker) -> Resolution:
    """
    IAM permission boundary prevents action even with policy grant.
    """

    # Check if permission boundary is the issue
    current_user = await get_current_user()
    boundary = await get_permission_boundary(current_user)

    if boundary and not boundary_allows_action(boundary, blocker.required_permission):
        # Cannot escalate beyond boundary
        return Resolution(
            resolved=False,
            strategy='permission_boundary_check',
            reason=f'Permission boundary prevents {blocker.required_permission}',
            requires_human_action='Admin must modify permission boundary'
        )

    # Permission boundary not the issue
    return await escalate_permissions(blocker)
```

### Service Quota Limits

```python
async def resolve_service_quota_exceeded(blocker: RateLimitBlocker) -> Resolution:
    """
    AWS service quota exceeded (e.g., VPC limit, Lambda concurrency).
    """

    # Get current quota
    service = blocker.service
    quota_code = blocker.quota_code
    current_quota = await get_service_quota(service, quota_code)

    # Check if quota is adjustable
    quota_info = await describe_service_quota(service, quota_code)

    if quota_info.adjustable:
        # Request quota increase
        increase_request = await request_quota_increase(
            service=service,
            quota_code=quota_code,
            desired_value=current_quota * 2,
            reason=f'Agent blocked: {blocker.task.description}'
        )

        return Resolution(
            resolved=False,  # Not immediately resolved
            strategy='request_quota_increase',
            actions_taken=[f'Requested quota increase to {current_quota * 2}'],
            estimated_resolution_time='1-2 business days',
            workaround=await find_workaround(blocker, blocker.task)
        )

    else:
        # Quota is hard limit
        return Resolution(
            resolved=False,
            strategy='quota_limit',
            reason=f'Quota {quota_code} is not adjustable',
            requires_human_action='Redesign to work within quota limits'
        )
```

### CloudFormation Stack Rollback

```python
async def resolve_cfn_rollback(blocker: StateBlocker) -> Resolution:
    """
    CloudFormation stack in ROLLBACK_COMPLETE state.
    """

    stack_name = blocker.resource

    # Stack in ROLLBACK_COMPLETE cannot be updated
    # Must delete and recreate

    # Check if stack has resources
    resources = await list_stack_resources(stack_name)

    if not resources:
        # Safe to delete
        await delete_stack(stack_name)
        await wait_for_deletion(stack_name)

        # Recreate stack
        await create_stack(stack_name, template=blocker.task.template)

        return Resolution(
            resolved=True,
            strategy='delete_and_recreate',
            actions_taken=['Deleted failed stack', 'Recreated stack']
        )

    else:
        # Stack has resources, risky to delete
        return Resolution(
            resolved=False,
            strategy='cfn_rollback',
            reason='Stack has resources, deletion may cause data loss',
            requires_human_action='Manually review stack resources before deletion'
        )
```

---

## Multi-Agent Coordination for Blockers

### Blocker Broadcasting

```python
async def broadcast_blocker_to_swarm(blocker: Blocker):
    """
    Notify other agents about blocker to avoid duplicate attempts.
    """

    await publish_event({
        'event_type': 'blocker_detected',
        'blocker_id': blocker.id,
        'blocker_type': type(blocker).__name__,
        'affected_tasks': [blocker.task.id],
        'resolution_in_progress': True,
        'agent_id': get_agent_id()
    })

async def subscribe_to_blocker_notifications():
    """
    Listen for blocker notifications from other agents.
    """

    async for event in event_stream('blocker_detected'):
        blocker_id = event['blocker_id']

        # Check if our tasks are affected
        our_tasks = await get_pending_tasks()
        affected = [t for t in our_tasks if shares_dependency(t, blocker_id)]

        if affected:
            # Pause affected tasks until resolution
            for task in affected:
                await pause_task(task)

            # Wait for resolution
            await wait_for_blocker_resolution(blocker_id)

            # Resume tasks
            for task in affected:
                await resume_task(task)
```

### Collaborative Resolution

```python
async def collaborative_blocker_resolution(blocker: Blocker) -> Resolution:
    """
    Multiple agents work together to resolve complex blocker.
    """

    # Example: IAM policy requires multiple services to configure

    if isinstance(blocker, PermissionBlocker):
        # Decompose permission requirement
        sub_permissions = decompose_permission(blocker.required_permission)

        # Assign sub-permissions to specialized agents
        resolution_tasks = []
        for sub_perm in sub_permissions:
            specialist = await find_specialist_agent(sub_perm)
            resolution_tasks.append(specialist.grant_permission(sub_perm))

        # Wait for all agents to complete
        resolutions = await asyncio.gather(*resolution_tasks)

        if all(r.resolved for r in resolutions):
            return Resolution(
                resolved=True,
                strategy='collaborative_resolution',
                actions_taken=[r.actions_taken for r in resolutions],
                contributing_agents=[r.agent_id for r in resolutions]
            )

    return Resolution(resolved=False, strategy='collaborative_resolution')
```

---

## Learning from Blockers

### Blocker Playbook

```python
class BlockerPlaybook:
    """
    Maintain knowledge base of blockers and resolutions.
    """

    def __init__(self):
        self.playbook = {}

    async def record_blocker(self, blocker: Blocker, resolution: Resolution):
        """
        Record successful resolution for future reference.
        """

        blocker_signature = self.compute_signature(blocker)

        if blocker_signature not in self.playbook:
            self.playbook[blocker_signature] = {
                'blocker_type': type(blocker).__name__,
                'resolutions': [],
                'success_count': 0,
                'failure_count': 0
            }

        entry = self.playbook[blocker_signature]
        entry['resolutions'].append({
            'strategy': resolution.strategy,
            'actions': resolution.actions_taken,
            'timestamp': datetime.utcnow().isoformat(),
            'success': resolution.resolved
        })

        if resolution.resolved:
            entry['success_count'] += 1
        else:
            entry['failure_count'] += 1

    async def suggest_resolution(self, blocker: Blocker) -> Optional[Resolution]:
        """
        Suggest resolution based on historical successes.
        """

        signature = self.compute_signature(blocker)

        if signature in self.playbook:
            entry = self.playbook[signature]

            # Find most successful strategy
            strategy_scores = {}
            for resolution in entry['resolutions']:
                strategy = resolution['strategy']
                if strategy not in strategy_scores:
                    strategy_scores[strategy] = {'success': 0, 'total': 0}

                strategy_scores[strategy]['total'] += 1
                if resolution['success']:
                    strategy_scores[strategy]['success'] += 1

            # Pick strategy with highest success rate
            best_strategy = max(
                strategy_scores.items(),
                key=lambda x: x[1]['success'] / x[1]['total']
            )

            return Resolution(
                resolved=None,  # Not yet attempted
                strategy=best_strategy[0],
                confidence=best_strategy[1]['success'] / best_strategy[1]['total']
            )

        return None

    def compute_signature(self, blocker: Blocker) -> str:
        """
        Compute fingerprint of blocker for matching.
        """
        return f"{type(blocker).__name__}:{blocker.error_code}:{blocker.service}"
```

---

## Real-World Examples

### Example 1: Lambda Deployment Blocker

```
Task: Deploy Lambda function

Error: "The security group 'sg-abc123' does not exist"

Blocker Detection:
├─ Type: MissingDependency
├─ Resource: sg-abc123
└─ Service: EC2

Resolution Attempts:
1. Provision-on-Demand: Create security group
   └─ Success: sg-abc123 created in default VPC

2. Retry Task: Deploy Lambda
   └─ New Error: "Lambda cannot access internet (no NAT Gateway)"

3. Provision-on-Demand: Create NAT Gateway
   └─ Blocker: NAT Gateway requires public subnet with IGW

4. Provision-on-Demand: Create Internet Gateway
   └─ Success: IGW created and attached to VPC

5. Provision-on-Demand: Create NAT Gateway in public subnet
   └─ Success: NAT Gateway created

6. Retry Task: Deploy Lambda
   └─ Success: Lambda deployed with VPC access

Total Resolution Time: 8 minutes
Autonomous: Yes
Human Intervention: None
```

### Example 2: DynamoDB Query Permission Denied

```
Task: Query DynamoDB table chimera-sessions

Error: "User arn:aws:iam::123:user/agent not authorized to perform: dynamodb:Query"

Blocker Detection:
├─ Type: PermissionBlocker
├─ Action: dynamodb:Query
├─ Resource: chimera-sessions
└─ Required: dynamodb:Query permission

Resolution Attempts:
1. Permission Escalation: Assume role with DynamoDB access
   └─ Found: arn:aws:iam::123:role/DataAccessRole
   └─ Success: Assumed role, gained dynamodb:Query permission

2. Retry Task: Query DynamoDB
   └─ Success: Query returned results

Total Resolution Time: 2 minutes
Autonomous: Yes
Human Intervention: None
```

### Example 3: CloudFormation Circular Dependency

```
Task: Deploy CloudFormation stack

Error: "Circular dependency detected: [Lambda, SecurityGroup]"

Blocker Detection:
├─ Type: CircularDependency
├─ Resources: [Lambda, SecurityGroup]
└─ Cause: Lambda references SG, SG references Lambda

Resolution Attempts:
1. Break Cycle: Decompose into ordered steps
   ├─ Step 1: Create SG with placeholder rule (allow 0.0.0.0/0)
   ├─ Step 2: Create Lambda referencing SG
   ├─ Step 3: Update SG rule to reference Lambda (precise rule)
   └─ Success: Resources created in correct order

Total Resolution Time: 5 minutes
Autonomous: Yes
Human Intervention: None
```

### Example 4: Service Quota Exceeded (Escalation)

```
Task: Create 100 VPCs for multi-tenant deployment

Error: "VPC limit exceeded (current limit: 5 VPCs per region)"

Blocker Detection:
├─ Type: ServiceQuotaExceeded
├─ Service: EC2
├─ Quota: VPCs per region
└─ Current: 5, Needed: 100

Resolution Attempts:
1. Request Quota Increase
   └─ Action: Submitted request to AWS Support
   └─ ETA: 1-2 business days
   └─ Status: Pending

2. Workaround: Use shared VPC with tenant isolation
   └─ Alternative Architecture:
      ├─ Single VPC with /16 CIDR
      ├─ Subnets per tenant (200+ supported)
      └─ Security groups for isolation
   └─ Status: Proposed to user

Total Resolution Time: Pending
Autonomous: Partial (workaround suggested)
Human Intervention: Required (architecture decision)
```

---

## Key Takeaways

1. **Blocker detection is proactive and reactive**: Check for blockers before execution (preflight), and classify failures after execution.

2. **Most blockers fall into patterns**: Missing dependencies, permission denied, rate limits, invalid state, validation failures, external failures.

3. **Resolution strategies are ordered**: Try autonomous resolution → agent collaboration → human escalation.

4. **Provision-on-demand is powerful**: Many blockers (missing tables, security groups, parameters) can be auto-resolved by creating resources with sensible defaults.

5. **Permission escalation enables autonomy**: Agents can assume roles or request temporary elevation to resolve permission blockers.

6. **Retry with backoff handles transient failures**: Rate limits and service throttling resolve themselves with patience.

7. **Workarounds are creative**: When direct resolution fails, find alternative approaches (different API, different tool, different architecture).

8. **Multi-agent collaboration resolves complex blockers**: Specialized agents can handle aspects requiring specific permissions/capabilities.

9. **Human escalation is a resolution strategy**: Escalate with context, suggested actions, and urgency classification.

10. **Learn from blockers**: Maintain playbook of blocker patterns and successful resolutions to improve future autonomy.

11. **AWS blockers have AWS-specific solutions**: IAM permission boundaries, service quotas, CloudFormation state issues require AWS-aware resolution logic.

12. **Blocker broadcasting prevents duplicate work**: Notify swarm when blocker detected so other agents don't retry the same failed approach.

---

## Sources

1. [Task Decomposition in Autonomous Agent Swarms](./01-Task-Decomposition.md) — Related research
2. [Agent Protocols and Collaboration Patterns](../collaboration/03-Agent-Protocols-and-Collaboration-Patterns.md) — Multi-agent coordination
3. [AWS Service Quotas](https://docs.aws.amazon.com/general/latest/gr/aws_service_limits.html) — AWS quota limits
4. [AWS IAM Policy Evaluation Logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html) — Permission resolution
5. [Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/) — Retry strategies
6. [CloudFormation Best Practices](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/best-practices.html) — State management
7. [Building Resilient Applications](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html) — AWS Well-Architected
8. Chimera Architecture Research — Internal documents
