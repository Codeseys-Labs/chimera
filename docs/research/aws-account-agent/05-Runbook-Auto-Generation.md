# AWS Chimera: Runbook Auto-Generation

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Activity Documentation (5 of 6)
> **See also:** [[01-Activity-Logging-Architecture-Overview]] | [[04-Auto-Generated-ADRs]] | [[06-Real-Time-Status-Dashboards]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Why Runbooks Matter]]
- [[#Runbook Generation Strategy]]
- [[#Runbook Template and Structure]]
- [[#Operational Procedures]]
- [[#Troubleshooting Guides]]
- [[#Monitoring and Alerting]]
- [[#Cost Management Sections]]
- [[#Runbook Updates and Versioning]]
- [[#Code Examples]]
- [[#Key Takeaways]]

---

## Executive Summary

Chimera **automatically generates operational runbooks** as agents build infrastructure. Instead of creating runbooks weeks after deployment (or never), documentation is assembled incrementally with each action:

- **What was built** — resources, configurations, dependencies
- **How to operate** — common commands, queries, procedures
- **How to troubleshoot** — known issues, debugging steps, solutions
- **How to monitor** — metrics, alarms, dashboards
- **How to manage costs** — cost queries, optimization tips

**Key Innovation:** Runbooks are generated from action logs, not written from scratch. Every infrastructure change updates the runbook automatically.

**Benefits:**
- ✅ **No documentation lag** — runbooks created as infrastructure is built
- ✅ **Always up-to-date** — runbook regenerates when infra changes
- ✅ **Operator-friendly** — copy-paste commands that actually work
- ✅ **Context-aware** — knows why resources exist (links to ADRs)
- ✅ **Human handoff** — human operator can take over mid-task with full context

---

## Why Runbooks Matter

### The Problem: Undocumented Infrastructure

Traditional AI agent systems create infrastructure without documentation:

```
Agent: "I've created a DynamoDB table, Lambda function, and API Gateway"
Operator: "Great! How do I check if it's working?"
Agent: [no documentation]
Operator: [reads CloudFormation, guesses commands, hopes for best]
```

**Problems:**
1. **No operational procedures** — operator doesn't know how to check health
2. **No troubleshooting** — operator doesn't know what can go wrong
3. **No monitoring guidance** — operator doesn't know which metrics to watch
4. **No cost management** — operator can't optimize spending

### Chimera's Solution: Runbook-as-You-Go

```
Agent creates DynamoDB table → Runbook updated with:
  - "Check table health" command
  - "Query active sessions" example
  - "Troubleshoot throttling" guide
  - "Monitor table metrics" dashboard link
  - "Optimize table cost" tips
```

**Operator handoff:**
```markdown
# Runbook: Chimera Session Storage (DynamoDB)

## What Was Built
- DynamoDB table: `chimera-sessions`
- GSI: `user-session-index`
- CloudWatch alarm: `SessionTableThrottles`

## How to Check Health
```bash
aws dynamodb describe-table --table-name chimera-sessions --query 'Table.TableStatus'
```
Expected output: `ACTIVE`

## How to Query Sessions
```bash
aws dynamodb query \
  --table-name chimera-sessions \
  --key-condition-expression 'PK = :tenantId' \
  --expression-attribute-values '{":tenantId": {"S": "TENANT#acme"}}'
```

## Troubleshooting: "ProvisionedThroughputExceededException"
**Cause:** Table in provisioned mode hit read/write limits
**Fix:**
```bash
aws dynamodb update-table \
  --table-name chimera-sessions \
  --billing-mode PAY_PER_REQUEST
```
```

---

## Runbook Generation Strategy

### Incremental Assembly

Runbook grows as agent works:

```
Action 1: Create DynamoDB table
  → Add "What Was Built" section
  → Add "Check Table Health" command

Action 2: Add GSI for user queries
  → Update "What Was Built" section
  → Add "Query Sessions by User" command

Action 3: Create CloudWatch alarm
  → Add "Monitoring" section
  → Add alarm details and response procedures

Action 4: Optimize table capacity
  → Add "Cost Management" section
  → Add capacity optimization commands
```

### Runbook Sources

Runbooks assembled from:

1. **Action logs** — what resources were created, with ARNs and configs
2. **Decision logs** — why resources exist (purpose, requirements, constraints)
3. **ADRs** — architectural context and rollback procedures
4. **AWS documentation** — command templates for resource types
5. **Known issues database** — common problems and solutions

### Runbook Format

Markdown with executable bash/Python code blocks:

```markdown
# Runbook: {System Name}

**Generated:** {ISO 8601 timestamp}
**Agent:** {agentId}
**Decision ID:** {decisionId}

## What Was Built
{List of resources with ARNs}

## How to Operate
{Common operational commands}

## Troubleshooting
{Known issues and fixes}

## Monitoring
{Metrics, alarms, dashboards}

## Cost Management
{Cost queries and optimization}

## Rollback
{Link to ADR rollback plan}
```

---

## Runbook Template and Structure

### Full Template

```markdown
# Runbook: {System Name} ({Resource Type})

**Generated:** {ISO 8601 date time}
**Agent:** {agentId}
**Decision ID:** {decisionId}
**Last Updated:** {ISO 8601 date time}

---

## What Was Built

{Narrative description of system}

### Resources
| Resource Type | Name | ARN | Created |
|--------------|------|-----|---------|
| {type} | {name} | {arn} | {date} |

### Dependencies
- **Depends on:** {List of upstream dependencies}
- **Required by:** {List of downstream dependents}

### Configuration
```json
{Key configuration parameters}
```

---

## How to Operate

### Check System Health
```bash
{Command to check overall health}
```
**Expected output:** {What healthy output looks like}
**Unhealthy indicators:** {What failure looks like}

### {Common Operation 1}
```bash
{Command with explanatory comments}
```
**Example output:**
```
{Sample output}
```

### {Common Operation 2}
```bash
{Command}
```

---

## Troubleshooting

### Issue: {Problem Title}
**Symptoms:**
- {Symptom 1}
- {Symptom 2}

**Cause:** {Root cause explanation}

**Fix:**
```bash
{Step-by-step commands to resolve}
```

**Verification:**
```bash
{Command to verify fix worked}
```

{Repeat for each known issue}

---

## Monitoring

### Key Metrics
| Metric | Namespace | Threshold | Alarm |
|--------|-----------|-----------|-------|
| {name} | {ns} | {threshold} | {alarm name} |

### View Metrics
```bash
aws cloudwatch get-metric-statistics \
  --namespace {namespace} \
  --metric-name {metric} \
  --dimensions Name={dimension},Value={value} \
  --start-time {start} \
  --end-time {end} \
  --period 300 \
  --statistics Average,Maximum
```

### Alarms
- **{Alarm Name}:** Triggers when {condition}. Action: {response}

### Dashboard
[CloudWatch Dashboard Link]({url})

---

## Cost Management

### Current Cost
```bash
{Command to check current month cost}
```

### Cost Breakdown
```bash
{Command to show cost by resource}
```

### Optimization Opportunities
1. {Optimization tip 1}
2. {Optimization tip 2}

---

## Rollback

See: [[{ADR-ID}]] Section "Rollback Plan"

---

## Related Resources
- **Decision Log:** [{decisionId}]({link})
- **ADR:** [[{ADR-ID}]]
- **CloudFormation Stack:** {stack name}
- **Monitoring Dashboard:** [{dashboard name}]({link})
```

---

## Example: DynamoDB Sessions Runbook

```markdown
# Runbook: Chimera Session Storage (DynamoDB)

**Generated:** 2026-03-20 14:32:00 UTC
**Agent:** agent-claude-3-5
**Decision ID:** act-2026-03-20-db-001
**Last Updated:** 2026-03-20 14:32:00 UTC

---

## What Was Built

Multi-tenant session storage using Amazon DynamoDB with partition key isolation (TENANT#{id}). Supports 10,000 sessions per day with automatic 30-day expiration via TTL.

### Resources
| Resource Type | Name | ARN | Created |
|--------------|------|-----|---------|
| DynamoDB Table | chimera-sessions | arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions | 2026-03-20 14:31:15 |
| GSI | user-session-index | (part of table) | 2026-03-20 14:31:15 |
| Lambda Function | SessionCleanup | arn:aws:lambda:us-west-2:123456789012:function:SessionCleanup | 2026-03-20 14:33:00 |
| CloudWatch Alarm | SessionTableThrottles | arn:aws:cloudwatch:us-west-2:123456789012:alarm:SessionTableThrottles | 2026-03-20 14:35:00 |

### Dependencies
- **Depends on:** None (foundational service)
- **Required by:** API Gateway /sessions endpoints, ECS tasks

### Configuration
```json
{
  "tableName": "chimera-sessions",
  "billingMode": "PAY_PER_REQUEST",
  "partitionKey": "PK",
  "sortKey": "SK",
  "ttlAttribute": "expiresAt",
  "ttlEnabled": true,
  "encryption": "AWS_MANAGED",
  "pointInTimeRecovery": true,
  "gsi": {
    "name": "user-session-index",
    "partitionKey": "userId",
    "sortKey": "lastActivity"
  }
}
```

---

## How to Operate

### Check Table Health
```bash
aws dynamodb describe-table \
  --table-name chimera-sessions \
  --query 'Table.TableStatus'
```
**Expected output:** `"ACTIVE"`
**Unhealthy indicators:** `"CREATING"`, `"UPDATING"`, `"DELETING"`, `"ARCHIVING"`

### Query Active Sessions for Tenant
```bash
# List all sessions for tenant-acme
aws dynamodb query \
  --table-name chimera-sessions \
  --key-condition-expression 'PK = :tenantId' \
  --filter-expression 'expiresAt > :now' \
  --expression-attribute-values '{
    ":tenantId": {"S": "TENANT#acme"},
    ":now": {"N": "'$(date +%s)'"}
  }'
```
**Example output:**
```json
{
  "Items": [
    {
      "PK": {"S": "TENANT#acme"},
      "SK": {"S": "SESSION#sess-2026-03-20-abc123"},
      "userId": {"S": "user-john-doe"},
      "expiresAt": {"N": "1710960000"},
      "lastActivity": {"N": "1710950000"}
    }
  ],
  "Count": 15
}
```

### Get Session by ID
```bash
aws dynamodb get-item \
  --table-name chimera-sessions \
  --key '{
    "PK": {"S": "TENANT#acme"},
    "SK": {"S": "SESSION#sess-2026-03-20-abc123"}
  }'
```

### Manually Expire Session
```bash
# Set expiresAt to current time (will be deleted within 48 hours by TTL)
aws dynamodb update-item \
  --table-name chimera-sessions \
  --key '{
    "PK": {"S": "TENANT#acme"},
    "SK": {"S": "SESSION#sess-2026-03-20-abc123"}
  }' \
  --update-expression 'SET expiresAt = :now' \
  --expression-attribute-values '{":now": {"N": "'$(date +%s)'"}}'
```

### Count Sessions by Tenant
```bash
aws dynamodb query \
  --table-name chimera-sessions \
  --key-condition-expression 'PK = :tenantId' \
  --select COUNT \
  --expression-attribute-values '{":tenantId": {"S": "TENANT#acme"}}'
```

---

## Troubleshooting

### Issue: "ProvisionedThroughputExceededException"
**Symptoms:**
- API returns 400 error with `ProvisionedThroughputExceededException`
- CloudWatch alarm `SessionTableThrottles` firing

**Cause:** Table in provisioned mode hit read/write capacity limits

**Fix:**
```bash
# Switch to on-demand billing (no capacity limits)
aws dynamodb update-table \
  --table-name chimera-sessions \
  --billing-mode PAY_PER_REQUEST
```

**Verification:**
```bash
aws dynamodb describe-table \
  --table-name chimera-sessions \
  --query 'Table.BillingModeSummary.BillingMode'
```
Expected: `"PAY_PER_REQUEST"`

---

### Issue: Session Not Found After Creation
**Symptoms:**
- Session created successfully (200 OK)
- Immediate read returns empty result

**Cause:** DynamoDB eventual consistency

**Fix:** Use `ConsistentRead=true` for reads immediately after writes
```python
# Python SDK example
response = dynamodb.get_item(
    TableName='chimera-sessions',
    Key={'PK': f'TENANT#{tenant_id}', 'SK': f'SESSION#{session_id}'},
    ConsistentRead=True  # Forces strongly consistent read
)
```

**Verification:** Session returned immediately after creation

---

### Issue: Old Sessions Not Deleted
**Symptoms:**
- Sessions older than 30 days still in table
- Table size growing beyond expected

**Cause:** TTL not enabled or misconfigured

**Fix:**
```bash
# Enable TTL
aws dynamodb update-time-to-live \
  --table-name chimera-sessions \
  --time-to-live-specification 'Enabled=true,AttributeName=expiresAt'

# Verify TTL configuration
aws dynamodb describe-time-to-live --table-name chimera-sessions
```

**Note:** TTL deletions occur within 48 hours of expiration (not immediate).

---

## Monitoring

### Key Metrics
| Metric | Namespace | Threshold | Alarm |
|--------|-----------|-----------|-------|
| UserErrors | AWS/DynamoDB | > 10 in 5 min | SessionTableErrors |
| SystemErrors | AWS/DynamoDB | > 5 in 5 min | SessionTableSystemErrors |
| ConsumedReadCapacityUnits | AWS/DynamoDB | > 80% provisioned | SessionTableReadThrottles |
| ConsumedWriteCapacityUnits | AWS/DynamoDB | > 80% provisioned | SessionTableWriteThrottles |

### View Metrics
```bash
# Check read/write capacity consumption (last hour)
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=chimera-sessions \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum,Average,Maximum
```

### Alarms
- **SessionTableThrottles:** Triggers when read or write throttles > 5 in 5 minutes. Action: Check if on-demand mode needed.
- **SessionTableErrors:** Triggers when user errors > 10 in 5 minutes. Action: Review application logs for invalid queries.
- **SessionTableSystemErrors:** Triggers when system errors > 5 in 5 minutes. Action: Check AWS Health Dashboard for service issues.

### Dashboard
[CloudWatch Dashboard: DynamoDB Sessions](https://console.aws.amazon.com/cloudwatch/home?region=us-west-2#dashboards:name=chimera-sessions)

---

## Cost Management

### Current Month Cost
```bash
# Query Cost Explorer for DynamoDB chimera-sessions cost
aws ce get-cost-and-usage \
  --time-period Start=$(date -u +%Y-%m-01),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter '{
    "And": [
      {"Dimensions": {"Key": "SERVICE", "Values": ["Amazon DynamoDB"]}},
      {"Tags": {"Key": "chimera:resource-name", "Values": ["chimera-sessions"]}}
    ]
  }'
```

### Cost Breakdown
```bash
# Show read vs write vs storage cost
aws ce get-cost-and-usage \
  --time-period Start=$(date -u +%Y-%m-01),End=$(date -u +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=USAGE_TYPE
```

### Optimization Opportunities

1. **Enable TTL** (if not already enabled)
   - Automatically deletes expired sessions
   - Reduces storage cost by ~30%
   - No additional charge for TTL deletions

2. **Use Batch Operations**
   - `BatchGetItem` for reading multiple sessions: 50% fewer RCUs
   - `BatchWriteItem` for bulk updates: 50% fewer WCUs

3. **Optimize Read Consistency**
   - Use eventual consistency (default) for non-critical reads: 50% cost reduction
   - Reserve `ConsistentRead=true` for auth flows only

4. **Monitor GSI Costs**
   - GSI consumes additional storage and RCUs
   - Consider removing if usage is low (<100 queries/day)

5. **Consider Reserved Capacity** (if usage is predictable)
   - If average RCU/WCU usage is stable, reserved capacity saves 40-60%
   - Only applicable for provisioned mode (not on-demand)

---

## Rollback

See: [[ADR-0042]] Section "Rollback Plan"

Quick summary:
1. Export sessions to S3
2. Deploy RDS PostgreSQL
3. Migrate data from DynamoDB to RDS
4. Update application code
5. Delete DynamoDB table

Full rollback procedure with tested code: [ADR-0042 Rollback](link-to-adr#rollback-plan)

---

## Related Resources
- **Decision Log:** [act-2026-03-20-db-001](link-to-decision-log)
- **ADR:** [[ADR-0042]]
- **CloudFormation Stack:** ChimeraDataStack
- **Monitoring Dashboard:** [DynamoDB Sessions Dashboard](link-to-dashboard)
- **Cost Dashboard:** [Session Storage Cost](link-to-cost-dashboard)
```

---

## Operational Procedures

### Common Procedure Patterns

**Health Check:**
```markdown
### Check {Resource} Health
```bash
{AWS CLI command to check status}
```
**Expected output:** `{Healthy state}`
**Unhealthy indicators:** `{Failure states}`
```

**Query Data:**
```markdown
### Query {Data Type}
```bash
{Command with filters}
```
**Example output:**
```{Example result}```
```

**Manual Intervention:**
```markdown
### {Action Title}
```bash
{Step 1}
{Step 2}
```
**Verification:**
```bash
{Command to confirm success}
```
```

---

## Troubleshooting Guides

### Troubleshooting Entry Format

```markdown
### Issue: {Problem Title}
**Symptoms:**
- {Observable behavior 1}
- {Observable behavior 2}

**Cause:** {Root cause explanation}

**Fix:**
```bash
{Commands to resolve}
```

**Verification:**
```bash
{Command to verify fix}
```

**Prevention:** {How to avoid this in future}
```

### Populating Troubleshooting

Sources for troubleshooting entries:

1. **Agent's own errors** — if agent encountered error during build, add troubleshooting entry
2. **AWS documentation** — extract common issues for resource type
3. **Historical incidents** — query past failures for this resource type
4. **Well-Architected review** — anticipate failure modes

---

## Monitoring and Alerting

### Metrics Section

```markdown
### Key Metrics
| Metric | Namespace | Threshold | Alarm |
|--------|-----------|-----------|-------|
| {name} | {AWS namespace} | {threshold value} | {alarm name} |

### View Metrics
```bash
aws cloudwatch get-metric-statistics ...
```

### Alarms
- **{Alarm Name}:** Triggers when {condition}. Action: {response procedure}
```

---

## Cost Management Sections

### Cost Query Commands

```markdown
### Current Month Cost
```bash
aws ce get-cost-and-usage \
  --time-period Start=$(date +%Y-%m-01),End=$(date +%Y-%m-%d) \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --filter '{"Tags": {"Key": "chimera:decision-id", "Values": ["{decisionId}"]}}'
```

### Optimization Opportunities
1. {Specific optimization for this resource type}
2. {Configuration change that reduces cost}
```

---

## Runbook Updates and Versioning

### Incremental Updates

When infrastructure changes, runbook is regenerated:

```typescript
async function updateRunbook(actionLog: ActionLog) {
  // 1. Load existing runbook
  const runbook = await loadRunbook(actionLog.decisionId);

  // 2. Update "What Was Built" section
  if (actionLog.actionCategory === 'create') {
    runbook.resources.push({
      type: actionLog.resource.type,
      name: actionLog.resource.name,
      arn: actionLog.resource.arn,
      created: actionLog.timestamp
    });
  }

  // 3. Add operational procedure
  const procedure = generateProcedure(actionLog);
  runbook.procedures.push(procedure);

  // 4. Add troubleshooting entries
  const troubleshooting = await generateTroubleshooting(actionLog);
  runbook.troubleshooting.push(...troubleshooting);

  // 5. Update monitoring section
  const metrics = await discoverMetrics(actionLog.resource.arn);
  runbook.monitoring.metrics.push(...metrics);

  // 6. Update cost section
  runbook.cost.estimatedMonthly += actionLog.cost.estimatedMonthly;

  // 7. Save updated runbook
  await saveRunbook(runbook);
}
```

### Version Control

Runbooks committed to git on every update:

```bash
git add docs/runbooks/session-storage-dynamodb.md
git commit -m "docs: Update session storage runbook - added GSI query procedure

Updated by action: action-2026-03-20-ddb-002
Added: Query sessions by user via GSI
Decision: act-2026-03-20-db-001"
```

---

## Code Examples

### Runbook Generator

```typescript
import { ActionLog, DecisionLog, ADR } from '@chimera/types';
import { renderRunbookTemplate } from './runbook-template';

export async function generateRunbook(decision: DecisionLog): Promise<Runbook> {
  // 1. Gather all actions for this decision
  const actions = await getActionsByDecision(decision.activityId);

  // 2. Load ADR
  const adr = await getADR(decision.activityId);

  // 3. Generate runbook sections
  const runbook = {
    title: `${decision.selectedOption} (${decision.decisionType.split('.').pop()})`,
    generatedAt: new Date().toISOString(),
    agentId: decision.agentId,
    decisionId: decision.activityId,

    whatWasBuilt: {
      description: decision.justification,
      resources: actions
        .filter(a => a.actionCategory === 'create')
        .map(a => ({
          type: a.resource.type,
          name: a.resource.name,
          arn: a.resource.arn,
          created: a.timestamp
        })),
      dependencies: await discoverDependencies(actions),
      configuration: extractKeyConfiguration(actions)
    },

    operations: await generateOperations(actions),
    troubleshooting: await generateTroubleshooting(actions),
    monitoring: await generateMonitoring(actions),
    costManagement: await generateCostSection(decision, actions),
    rollback: {
      adrLink: adr.adrId,
      summary: adr.rollbackPlan.summary
    },
    relatedResources: {
      decisionLog: decision.activityId,
      adr: adr.adrId,
      stack: decision.tags['cloudformation-stack'],
      dashboard: await findDashboard(actions)
    }
  };

  // 4. Render markdown
  const markdown = renderRunbookTemplate(runbook);

  // 5. Save to S3
  await s3.putObject({
    Bucket: 'chimera-runbooks',
    Key: `runbooks/${decision.tenantId}/${decision.activityId}.md`,
    Body: markdown,
    ContentType: 'text/markdown'
  });

  // 6. Commit to git
  await commitToGit({
    filePath: `docs/runbooks/${slugify(runbook.title)}.md`,
    content: markdown,
    message: `docs: Add runbook for ${runbook.title}`
  });

  return runbook;
}

async function generateOperations(actions: ActionLog[]): Promise<Operation[]> {
  const ops = [];

  for (const action of actions) {
    // Health check for every resource
    ops.push({
      title: `Check ${action.resource.name} Health`,
      command: generateHealthCheckCommand(action.resource),
      expectedOutput: getExpectedHealthOutput(action.resource.type),
      unhealthyIndicators: getUnhealthyIndicators(action.resource.type)
    });

    // Query operations for data stores
    if (isDataStore(action.resource.type)) {
      ops.push({
        title: `Query ${action.resource.name}`,
        command: generateQueryCommand(action.resource),
        example: await getExampleOutput(action.resource)
      });
    }

    // Manual operations
    if (requiresManualOps(action.resource.type)) {
      ops.push(...await generateManualOps(action.resource));
    }
  }

  return ops;
}
```

---

## Key Takeaways

1. **Runbooks generated as infrastructure is built** — no documentation lag

2. **Operator-ready commands** — copy-paste bash commands that work

3. **Troubleshooting from day one** — known issues documented before they occur

4. **Monitoring guidance included** — operators know which metrics to watch

5. **Cost management built-in** — optimization tips specific to resources

6. **Links to context** — runbook references decision logs and ADRs for "why"

7. **Version controlled** — runbooks committed to git, track evolution

8. **Human handoff ready** — operator can take over mid-task with full context

---

**Next:** [[06-Real-Time-Status-Dashboards]] — Live visibility into what agents are doing, what they built, what changed
