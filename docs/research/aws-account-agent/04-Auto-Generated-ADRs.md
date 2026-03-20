# AWS Chimera: Auto-Generated Architecture Decision Records

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Activity Documentation (4 of 6)
> **See also:** [[01-Activity-Logging-Architecture-Overview]] | [[02-Decision-Logs-Reasoning-Capture]] | [[03-Action-Audit-Trail-Structured-Storage]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#What Are ADRs?]]
- [[#Why Auto-Generate ADRs?]]
- [[#ADR Generation Triggers]]
- [[#ADR Template and Structure]]
- [[#Rollback Plan Generation]]
- [[#Linking ADRs to Code]]
- [[#ADR Versioning and Evolution]]
- [[#Storage and Discovery]]
- [[#Query Patterns]]
- [[#Code Examples]]
- [[#Key Takeaways]]

---

## Executive Summary

Chimera **automatically generates Architecture Decision Records (ADRs)** for significant infrastructure changes made by AI agents. Instead of documenting decisions weeks after implementation (or never), ADRs are created at decision-time with:

- **Context:** Why was this decision needed?
- **Decision:** What was chosen and why?
- **Alternatives:** What options were considered and rejected?
- **Consequences:** What are the trade-offs?
- **Rollback Plan:** How to undo this change if needed?

**Key Innovation:** ADRs are generated from structured decision logs, not written by humans afterward. The agent that makes the decision also documents it, ensuring consistency and completeness.

**Benefits:**
- ✅ **No documentation debt** — decisions documented at decision-time
- ✅ **Rollback with confidence** — every ADR includes tested rollback code
- ✅ **Onboarding acceleration** — new team members read ADR history to understand system evolution
- ✅ **Audit trail** — compliance teams query ADRs, not code comments
- ✅ **Knowledge preservation** — agent's reasoning captured for future agents/humans

---

## What Are ADRs?

### Architecture Decision Record (ADR)

An ADR documents a significant architectural choice:

**Traditional ADR (human-written):**
```markdown
# ADR-0042: Use DynamoDB for Session Storage

## Status
Accepted

## Context
We need a datastore for user sessions with sub-10ms latency.

## Decision
Use Amazon DynamoDB with partition key TENANT#{id}.

## Consequences
- Pros: Serverless, scalable, cost-effective
- Cons: Limited query flexibility

## Alternatives
- RDS PostgreSQL: Familiar but costly
- Redis: Fast but not durable
```

**Chimera ADR (auto-generated):**
```markdown
# ADR-0042: Use DynamoDB for Session Storage

**Status:** Accepted
**Date:** 2026-03-20
**Decision ID:** act-2026-03-20-db-001
**Agent:** agent-claude-3-5
**Tenant:** tenant-acme

## Context
User session storage requires:
- Read/write latency < 10ms at p99
- Support 10,000 sessions per day
- 30-day retention with TTL
- Multi-tenant data isolation

Access pattern: Key-value lookups by sessionId (no complex queries).

## Decision
Use Amazon DynamoDB with:
- Partition key: `TENANT#{tenantId}`
- Sort key: `SESSION#{sessionId}`
- Billing mode: Pay-per-request
- TTL: Enabled on `expiresAt` attribute

## Alternatives Considered

### 1. Amazon DynamoDB (Score: 9.2/10) ✓ SELECTED
**Pros:**
- Single-digit millisecond latency guaranteed
- Serverless scaling with no capacity planning
- Built-in multi-tenancy via partition keys
- Cost-effective at scale ($45/month vs $300)

**Cons:**
- Eventual consistency default (mitigated with ConsistentRead)
- Limited query flexibility (not needed for key-value access)

**Well-Architected Pillars:** Performance (10), Reliability (10), Cost (9)

### 2. Amazon RDS PostgreSQL (Score: 8.5/10)
**Pros:**
- Team familiar with PostgreSQL
- ACID compliance for all transactions
- Flexible SQL queries for analytics

**Cons:**
- 6x higher cost ($300/month)
- Manual capacity planning required
- Cold start latency after failover (30-60s)

**Well-Architected Pillars:** Reliability (7), Operational Excellence (8)

### 3. Amazon ElastiCache Redis (Score: 7.0/10)
**Pros:**
- Sub-millisecond latency
- Simple key-value API

**Cons:**
- Not durable by default
- Cluster management overhead
- Higher cost than DynamoDB ($120/month)

**Well-Architected Pillars:** Performance (10), Reliability (5)

## Justification
Session data access pattern is key-value lookups by sessionId with no complex query requirements. DynamoDB provides guaranteed single-digit millisecond latency at p99, automatic multi-AZ replication, and built-in multi-tenancy via partition keys (TENANT#{id}). Cost at projected 10K sessions/day is $45/month, 70% lower than RDS PostgreSQL.

Eventual consistency is acceptable for session data outside of authentication flows (where we use ConsistentRead=true). The team's unfamiliarity with DynamoDB is mitigated by comprehensive AWS documentation and Well-Architected best practices.

## Consequences

### Positive
- **Performance:** Single-digit ms latency at any scale
- **Cost:** 70% reduction vs RDS ($45/mo vs $300/mo)
- **Reliability:** Multi-AZ replication by default, 99.99% SLA
- **Scalability:** Auto-scaling with on-demand billing

### Negative
- **Query limitations:** Cannot perform complex SQL queries (not needed for sessions)
- **Learning curve:** Team needs to learn DynamoDB best practices
- **Consistency trade-off:** Eventual consistency default (mitigated)

### Mitigation
- Use `ConsistentRead=true` for authentication flows
- Provide DynamoDB training and documentation
- Monitor with CloudWatch metrics: `ConsumedReadCapacityUnits`, `UserErrors`

## Cost Impact
- **One-time:** $0 (no creation cost)
- **Monthly:** $45 (10K sessions/day, 2 reads + 1 write per session)
- **Annual:** $540
- **Baseline (RDS):** $300/month = $3,600/year
- **Savings:** $3,060/year (85% reduction)

## Compliance
- **Well-Architected Pillars:**
  - Performance Efficiency: 10/10
  - Reliability: 10/10
  - Cost Optimization: 9/10
  - Security: 9/10
  - Operational Excellence: 8/10

- **Data Classification:** Session tokens (PII)
- **Encryption:** At rest with AWS-managed keys
- **Retention:** 30 days (per tenant config)

## Implementation

### Resources Created
```typescript
// CDK Stack: DataStack
const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
  tableName: 'chimera-sessions',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  timeToLiveAttribute: 'expiresAt',
  removalPolicy: cdk.RemovalPolicy.RETAIN,
  pointInTimeRecovery: true
});

// GSI for user queries
sessionsTable.addGlobalSecondaryIndex({
  indexName: 'user-session-index',
  partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'lastActivity', type: dynamodb.AttributeType.NUMBER },
  projectionType: dynamodb.ProjectionType.ALL
});
```

### Tags Applied
```typescript
cdk.Tags.of(sessionsTable).add('chimera:decision-id', 'act-2026-03-20-db-001');
cdk.Tags.of(sessionsTable).add('chimera:adr-id', 'ADR-0042');
cdk.Tags.of(sessionsTable).add('chimera:tenant-id', 'tenant-acme');
```

## Rollback Plan

### Rollback Trigger
If any of these conditions occur:
- DynamoDB throttling > 5% of requests for 5 minutes
- Session read latency p99 > 20ms for 10 minutes
- Monthly cost exceeds $100 (2.2x estimate)

### Rollback Steps

#### Step 1: Export Session Data
```bash
# Export all sessions to S3
aws dynamodb export-table-to-point-in-time \
  --table-arn arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions \
  --s3-bucket chimera-backups \
  --s3-prefix sessions-backup-$(date +%Y%m%d) \
  --export-format DYNAMODB_JSON
```

#### Step 2: Deploy RDS PostgreSQL
```typescript
// rollback/adr-0042-rollback-rds.ts
import * as rds from 'aws-cdk-lib/aws-rds';

const sessionsDB = new rds.DatabaseInstance(this, 'SessionsDB', {
  engine: rds.DatabaseInstanceEngine.postgres({
    version: rds.PostgresEngineVersion.VER_15_4
  }),
  instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
  vpc,
  multiAz: true,
  allocatedStorage: 100,
  databaseName: 'sessions',
  credentials: rds.Credentials.fromSecret(sessionsDBSecret)
});

// Create sessions table
sessionsDB.addRotationSingleUser();
```

#### Step 3: Migrate Data
```typescript
// rollback/migrate-dynamodb-to-rds.ts
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { Pool } from 'pg';

const ddb = new DynamoDBClient({ region: 'us-west-2' });
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  // Scan DynamoDB table
  const sessions = await ddb.send(new ScanCommand({
    TableName: 'chimera-sessions'
  }));

  // Insert into PostgreSQL
  for (const session of sessions.Items) {
    await pg.query(
      'INSERT INTO sessions (tenant_id, session_id, user_id, data, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [
        session.PK.S.replace('TENANT#', ''),
        session.SK.S.replace('SESSION#', ''),
        session.userId.S,
        JSON.stringify(session.data.M),
        new Date(session.expiresAt.N * 1000)
      ]
    );
  }
}
```

#### Step 4: Update Application Code
```typescript
// Before (DynamoDB)
const session = await ddb.getItem({
  TableName: 'chimera-sessions',
  Key: { PK: `TENANT#${tenantId}`, SK: `SESSION#${sessionId}` }
});

// After (PostgreSQL)
const session = await pg.query(
  'SELECT * FROM sessions WHERE tenant_id = $1 AND session_id = $2',
  [tenantId, sessionId]
);
```

#### Step 5: Delete DynamoDB Table
```bash
# After verifying RDS is working
aws dynamodb delete-table --table-name chimera-sessions
```

### Rollback Cost
- **One-time migration cost:** $50 (Lambda execution, data transfer)
- **New monthly cost:** $300 (RDS t3.medium Multi-AZ)
- **Cost increase:** +$255/month

### Rollback Testing
✓ Tested 2026-03-20: Migration script successfully moved 10K test sessions from DynamoDB to RDS in 45 minutes.

## Related Resources
- **Decision Log:** [act-2026-03-20-db-001](link-to-decision-log)
- **Action Logs:** [actions for ADR-0042](link-to-action-logs)
- **CloudFormation Stack:** ChimeraDataStack
- **Monitoring Dashboard:** [DynamoDB Sessions Dashboard](link-to-cloudwatch)

## Approval
- **Auto-approved:** Yes (cost < $500/month threshold)
- **Manual review required:** No

## Supersedes
- None (first session storage decision)

## Superseded By
- None (still active)

---
**Generated by:** Chimera Agent (claude-3-5-sonnet)
**Generation Time:** 2026-03-20T14:32:00Z
**Last Updated:** 2026-03-20T14:32:00Z
```

---

## Why Auto-Generate ADRs?

### The Problem with Manual ADRs

Traditional ADR processes fail because:

1. **Documentation debt** — "We'll write the ADR after the sprint"
2. **Incomplete context** — By the time ADR is written, alternatives are forgotten
3. **Inconsistent format** — Different engineers write ADRs differently
4. **No rollback plans** — ADRs document forward path, not rollback
5. **Orphaned decisions** — ADR exists but code changed, ADR not updated

### Chimera's Solution

**Auto-generation from decision logs:**

```
Agent makes decision → Decision log created → ADR auto-generated
        ↓                      ↓                     ↓
   Alternatives          Structured data       Markdown document
   considered            in DynamoDB           in S3 + Git
```

**Benefits:**
- ✅ **Complete context** — ADR includes all alternatives considered
- ✅ **Consistent format** — Template-driven generation
- ✅ **Rollback plans** — Generated from decision alternatives
- ✅ **Always up-to-date** — ADR regenerated when decision revisited
- ✅ **Linked to code** — ADR tags match resource tags

---

## ADR Generation Triggers

### Automatic Triggers

ADR generated automatically when:

1. **Infrastructure resource created** (Lambda, DynamoDB, RDS, etc.)
2. **Estimated monthly cost > $50**
3. **Decision confidence < 0.8** (uncertain decisions need documentation)
4. **Multi-tenant isolation change** (security critical)
5. **Data retention policy change** (compliance critical)

### Manual Triggers

Engineers can force ADR generation:

```typescript
await generateADR({
  decisionId: 'act-2026-03-20-db-001',
  reason: 'Manual request from compliance team'
});
```

### Suppression

Some decisions don't need ADRs:

```typescript
const decision = await logDecision({
  question: 'Which log level for development?',
  selectedOption: 'DEBUG',
  justification: 'Standard dev environment config',
  suppressADR: true,  // Low-impact decision
  reason: 'Non-architectural configuration change'
});
```

---

## ADR Template and Structure

### Template

```markdown
# ADR-{number}: {Title}

**Status:** Accepted | Deprecated | Superseded
**Date:** {ISO 8601 date}
**Decision ID:** {activityId}
**Agent:** {agentId}
**Tenant:** {tenantId}

## Context
{What problem are we solving?}
{What requirements drove this decision?}
{What constraints exist?}

## Decision
{What was chosen?}
{Key configuration details}

## Alternatives Considered

### 1. {Option Name} (Score: {score}/10) {✓ SELECTED if chosen}
**Pros:**
- {Benefit 1}
- {Benefit 2}

**Cons:**
- {Drawback 1}
- {Drawback 2}

**Well-Architected Pillars:** {Pillar names with scores}

{Repeat for each alternative}

## Justification
{Why was the selected option chosen?}
{How does it meet requirements?}
{What trade-offs were accepted?}

## Consequences

### Positive
- {Benefit 1}
- {Benefit 2}

### Negative
- {Drawback 1}
- {Drawback 2}

### Mitigation
- {How negative consequences are addressed}

## Cost Impact
- **One-time:** ${immediate cost}
- **Monthly:** ${monthly cost}
- **Annual:** ${annual cost}
- **Baseline:** ${alternative cost}
- **Savings:** ${difference}

## Compliance
- **Well-Architected Pillars:** {Scores}
- **Data Classification:** {PII, PHI, etc.}
- **Encryption:** {At rest, in transit}
- **Retention:** {Duration}

## Implementation
{CDK/Terraform code}
{Resources created}
{Tags applied}

## Rollback Plan

### Rollback Trigger
{Conditions that would trigger rollback}

### Rollback Steps
{Step-by-step rollback procedure}
{Code snippets for rollback}

### Rollback Cost
{Financial impact of rollback}

### Rollback Testing
{When rollback was tested, results}

## Related Resources
- **Decision Log:** {link}
- **Action Logs:** {link}
- **CloudFormation Stack:** {stack name}
- **Monitoring Dashboard:** {link}

## Approval
- **Auto-approved:** {Yes/No}
- **Manual review required:** {Yes/No}
- **Approved by:** {Person/Agent}

## Supersedes
{List of previous ADRs this replaces}

## Superseded By
{ADR that replaced this one, if deprecated}

---
**Generated by:** {Agent name}
**Generation Time:** {ISO 8601}
**Last Updated:** {ISO 8601}
```

---

## Rollback Plan Generation

### Automatic Rollback Code

Chimera generates rollback plans by analyzing alternatives:

```typescript
async function generateRollbackPlan(decision: DecisionLog): Promise<RollbackPlan> {
  // If DynamoDB was selected, rollback means using #2 alternative (RDS)
  const selected = decision.selectedOption;
  const runnerUp = decision.alternatives
    .filter(a => a.option !== selected)
    .sort((a, b) => b.score - a.score)[0];

  return {
    trigger: generateRollbackTriggers(decision),
    steps: [
      {
        step: 1,
        description: 'Export data from current solution',
        code: generateExportCode(selected)
      },
      {
        step: 2,
        description: `Deploy ${runnerUp.option}`,
        code: generateDeployCode(runnerUp)
      },
      {
        step: 3,
        description: 'Migrate data',
        code: generateMigrationCode(selected, runnerUp)
      },
      {
        step: 4,
        description: 'Update application code',
        code: generateApplicationUpdateCode(selected, runnerUp)
      },
      {
        step: 5,
        description: 'Delete original resources',
        code: generateCleanupCode(selected)
      }
    ],
    cost: calculateRollbackCost(runnerUp),
    testingStatus: 'not-tested'
  };
}
```

### Rollback Testing

ADR includes rollback testing status:

```typescript
{
  "rollbackTesting": {
    "status": "tested",
    "testDate": "2026-03-20",
    "testEnvironment": "staging",
    "testResult": "success",
    "testDuration": "45 minutes",
    "testNotes": "Successfully migrated 10K sessions from DynamoDB to RDS"
  }
}
```

---

## Linking ADRs to Code

### Resource Tags

Every resource created by agent is tagged with ADR ID:

```typescript
const tags = {
  'chimera:adr-id': 'ADR-0042',
  'chimera:decision-id': 'act-2026-03-20-db-001',
  'chimera:created-by': 'agent-claude-3-5'
};

// Tag DynamoDB table
await dynamodb.tagResource({
  ResourceArn: 'arn:aws:dynamodb:...:table/chimera-sessions',
  Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
});
```

### Code Comments

CDK stacks include ADR references:

```typescript
// ADR-0042: Use DynamoDB for session storage
// Decision: DynamoDB chosen over RDS for 70% cost reduction and < 10ms latency
// See: docs/adrs/ADR-0042.md
const sessionsTable = new dynamodb.Table(this, 'SessionsTable', {
  tableName: 'chimera-sessions',
  // ...
});
```

### Git Commits

ADR generation triggers git commit:

```bash
git add docs/adrs/ADR-0042-dynamodb-sessions.md
git commit -m "docs: ADR-0042 - Use DynamoDB for session storage

Auto-generated from decision act-2026-03-20-db-001
Agent: claude-3-5-sonnet
Tenant: tenant-acme
Cost: $45/month (70% reduction vs RDS)"
```

---

## ADR Versioning and Evolution

### ADR Status Lifecycle

```
Proposed → Accepted → Deprecated → Superseded
```

**Status Definitions:**
- **Proposed:** Decision logged, awaiting implementation
- **Accepted:** Implemented and active
- **Deprecated:** Still in use but discouraged for new systems
- **Superseded:** Replaced by newer ADR

### ADR Updates

When decision is revisited:

```typescript
// Original ADR-0042: DynamoDB for sessions
{
  "status": "accepted",
  "date": "2026-03-20"
}

// Later: DynamoDB hitting scale limits, migrate to Aurora
{
  "status": "superseded",
  "supersededBy": "ADR-0087",
  "supersededDate": "2026-06-15",
  "supersededReason": "DynamoDB throttling at 100K sessions/day"
}

// New ADR-0087: Aurora for sessions
{
  "status": "accepted",
  "supersedes": ["ADR-0042"],
  "supersededReason": "Scale beyond DynamoDB on-demand limits"
}
```

---

## Storage and Discovery

### Storage Strategy

**Primary:** S3 Bucket
```
s3://chimera-adrs-{accountId}/
  adrs/
    by-number/
      ADR-0001-initial-architecture.md
      ADR-0042-dynamodb-sessions.md
      ADR-0087-aurora-sessions.md
    by-date/
      2026/
        03/
          ADR-0042-dynamodb-sessions.md
    by-tenant/
      tenant-acme/
        ADR-0042-dynamodb-sessions.md
```

**Secondary:** Git Repository
```
docs/
  adrs/
    ADR-0042-dynamodb-sessions.md
    ADR-0087-aurora-sessions.md
```

**Tertiary:** DynamoDB Metadata
```typescript
{
  PK: "TENANT#{tenantId}",
  SK: "ADR#{adrId}",
  adrId: "ADR-0042",
  title: "Use DynamoDB for session storage",
  status: "superseded",
  decisionId: "act-2026-03-20-db-001",
  createdAt: "2026-03-20T14:32:00Z",
  supersededAt: "2026-06-15T10:00:00Z",
  supersededBy: "ADR-0087",
  s3Location: "s3://chimera-adrs/adrs/by-number/ADR-0042-dynamodb-sessions.md"
}
```

### Discovery API

```typescript
// Find ADRs by resource ARN
async function findADRsByResource(resourceArn: string): Promise<ADR[]> {
  // 1. Get resource tags
  const tags = await getResourceTags(resourceArn);
  const adrId = tags['chimera:adr-id'];

  // 2. Query DynamoDB for ADR metadata
  const adr = await ddb.query({
    TableName: 'chimera-activity-logs',
    IndexName: 'adr-index',
    KeyConditionExpression: 'adrId = :adrId',
    ExpressionAttributeValues: { ':adrId': adrId }
  });

  // 3. Fetch full ADR from S3
  const adrMarkdown = await s3.getObject({
    Bucket: 'chimera-adrs-123456789012',
    Key: adr.Items[0].s3Location
  });

  return parseADR(adrMarkdown.Body.toString());
}

// Find all active ADRs for tenant
async function getActiveADRs(tenantId: string): Promise<ADR[]> {
  return await ddb.query({
    TableName: 'chimera-activity-logs',
    KeyConditionExpression: 'PK = :tenantId AND begins_with(SK, :prefix)',
    FilterExpression: '#status = :status',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':tenantId': `TENANT#${tenantId}`,
      ':prefix': 'ADR#',
      ':status': 'accepted'
    }
  });
}
```

---

## Query Patterns

### Pattern 1: "Show me all ADRs for this tenant"

```sql
SELECT
  adrId,
  title,
  status,
  createdAt,
  cost.estimatedMonthly
FROM chimera_activities
WHERE tenantId = 'tenant-acme'
  AND activityType = 'adr'
  AND status = 'accepted'
ORDER BY createdAt DESC;
```

### Pattern 2: "Which ADR led to creation of this DynamoDB table?"

```typescript
// 1. Get table tags
const tags = await dynamodb.listTagsOfResource({
  ResourceArn: 'arn:aws:dynamodb:...:table/chimera-sessions'
});

const adrId = tags.Tags.find(t => t.Key === 'chimera:adr-id')?.Value;

// 2. Fetch ADR
const adr = await s3.getObject({
  Bucket: 'chimera-adrs',
  Key: `adrs/by-number/${adrId}.md`
});

console.log(adr.Body.toString());
```

### Pattern 3: "Show me all superseded ADRs"

```sql
SELECT
  adrId,
  title,
  supersededAt,
  supersededBy,
  supersededReason
FROM chimera_activities
WHERE activityType = 'adr'
  AND status = 'superseded'
ORDER BY supersededAt DESC;
```

---

## Code Examples

### ADR Generator

```typescript
import { DecisionLog, ADR } from '@chimera/types';
import { renderTemplate } from './adr-template';

export async function generateADR(decision: DecisionLog): Promise<ADR> {
  // 1. Generate ADR number
  const adrNumber = await getNextADRNumber();

  // 2. Generate rollback plan
  const rollbackPlan = await generateRollbackPlan(decision);

  // 3. Render ADR markdown
  const adrMarkdown = renderTemplate({
    number: adrNumber,
    title: decision.question.replace('Which ', 'Use '),
    status: 'accepted',
    date: new Date().toISOString(),
    decisionId: decision.activityId,
    agentId: decision.agentId,
    tenantId: decision.tenantId,
    context: {
      requirements: decision.context.requirements,
      constraints: decision.context.constraints,
      assumptions: decision.context.assumptions
    },
    decision: decision.selectedOption,
    alternatives: decision.alternatives,
    justification: decision.justification,
    consequences: analyzeConsequences(decision),
    costImpact: decision.costEstimate,
    compliance: decision.wellArchitectedPillars,
    rollbackPlan
  });

  // 4. Save to S3
  const adrId = `ADR-${adrNumber.toString().padStart(4, '0')}`;
  await s3.putObject({
    Bucket: 'chimera-adrs',
    Key: `adrs/by-number/${adrId}.md`,
    Body: adrMarkdown,
    ContentType: 'text/markdown'
  });

  // 5. Save metadata to DynamoDB
  await ddb.putItem({
    TableName: 'chimera-activity-logs',
    Item: {
      PK: `TENANT#${decision.tenantId}`,
      SK: `ADR#${adrId}`,
      adrId,
      title: decision.question,
      status: 'accepted',
      decisionId: decision.activityId,
      createdAt: new Date().toISOString(),
      s3Location: `adrs/by-number/${adrId}.md`,
      activityType: 'adr'
    }
  });

  // 6. Commit to Git
  await commitToGit({
    filePath: `docs/adrs/${adrId}.md`,
    content: adrMarkdown,
    message: `docs: ${adrId} - ${decision.question}`
  });

  return {
    adrId,
    markdown: adrMarkdown,
    s3Location: `s3://chimera-adrs/adrs/by-number/${adrId}.md`
  };
}
```

---

## Key Takeaways

1. **Auto-generation eliminates documentation debt** — ADRs created at decision-time, not weeks later

2. **Complete context captured** — includes all alternatives considered, even those rejected

3. **Rollback plans included** — every ADR has tested rollback procedure

4. **Linked to code and resources** — tags connect ADRs to AWS resources

5. **Queryable like logs** — SQL queries over ADR corpus for analysis

6. **Version control integration** — ADRs committed to git automatically

7. **Supersession tracking** — clear evolution of architectural decisions over time

8. **Cost awareness** — ADRs include cost impact and rollback cost

---

**Next:** [[05-Runbook-Auto-Generation]] — How operational documentation is created as agent builds infrastructure
