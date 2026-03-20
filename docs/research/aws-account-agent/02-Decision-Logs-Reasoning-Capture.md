# AWS Chimera: Decision Logs and Reasoning Capture

> **Research Date:** 2026-03-20
> **Status:** Complete
> **Series:** AWS Account Agent Activity Documentation (2 of 6)
> **See also:** [[01-Activity-Logging-Architecture-Overview]] | [[03-Action-Audit-Trail-Structured-Storage]] | [[04-Auto-Generated-ADRs]]

---

## Table of Contents

- [[#Executive Summary]]
- [[#Why Decision Logs Matter]]
- [[#Decision Log Schema]]
- [[#Well-Architected Framework Integration]]
- [[#Capturing Reasoning at Decision Time]]
- [[#Scoring and Ranking Alternatives]]
- [[#Cost Estimation Integration]]
- [[#Storage and Retrieval]]
- [[#Query Patterns]]
- [[#UI/UX for Decision Review]]
- [[#Code Examples]]
- [[#Key Takeaways]]

---

## Executive Summary

Chimera's **decision logging system** captures agent reasoning at the moment of decision, storing structured records of:
- The question being answered
- All alternatives considered (with pros, cons, scores)
- The selected option and justification
- AWS Well-Architected Framework pillar mapping
- Cost impact estimation
- Confidence level and risk assessment

This enables **post-hoc analysis** ("why did agent choose X?"), **compliance auditing** (decisions mapped to business requirements), and **continuous learning** (analyze decision patterns to improve agent prompts).

**Key Innovation:** Decision logs are captured *before* execution, not reconstructed from logs afterward. This preserves the agent's mental model, including alternatives that were *not* chosen.

---

## Why Decision Logs Matter

### The Problem with "Black Box" Agents

Traditional AI agents make decisions without documentation:

```
User: "Set up a database for user sessions"
Agent: [internal reasoning hidden]
Agent: "I've created an RDS PostgreSQL instance"
```

**Questions operators can't answer:**
- Why PostgreSQL instead of DynamoDB?
- Why RDS instead of Aurora Serverless?
- What was the expected cost?
- Which Well-Architected pillars were prioritized?
- What happens if load increases 10x?

### Chimera's Approach: Document the Mental Model

```
User: "Set up a database for user sessions"
Agent: [logs decision with 4 alternatives, scores, justification]
Agent: "I've selected DynamoDB. See decision log act-2026-03-20-db-001"

Operator queries decision log:
- Question: "Which database for session storage?"
- Alternatives: RDS (7.5), DynamoDB (9.2), ElastiCache (6.8), Aurora (8.0)
- Selected: DynamoDB
- Justification: "Session access pattern is key-value. DynamoDB provides
  single-digit ms latency at 70% lower cost than RDS."
- Well-Architected: Performance ✓, Cost Optimization ✓, Reliability ✓
```

**Benefits:**
1. **Transparency** — operator understands *why* agent chose DynamoDB
2. **Auditability** — compliance team can verify decision aligns with cost policy
3. **Learning** — analyze 100 database decisions to identify patterns
4. **Rollback** — if DynamoDB doesn't work, see what alternative was #2 ranked

---

## Decision Log Schema

### Core Structure

```typescript
interface DecisionLog {
  // Identity
  activityId: string;        // "act-2026-03-20-db-001"
  tenantId: string;          // "tenant-acme"
  timestamp: string;         // ISO 8601
  decisionType: string;      // "infrastructure.database.selection"

  // The Question
  question: string;          // "Which database engine for user session storage?"
  context: {
    requirements: string[];  // ["< 10ms latency", "10K sessions/day"]
    constraints: string[];   // ["Must support multi-tenancy"]
    assumptions: string[];   // ["Session data is key-value"]
  };

  // Alternatives Considered
  alternatives: Alternative[];

  // The Decision
  selectedOption: string;
  justification: string;
  confidence: number;        // 0.0 - 1.0
  riskLevel: "low" | "medium" | "high";

  // Framework Alignment
  wellArchitectedPillars: WellArchitectedMapping;

  // Cost Impact
  costEstimate: CostEstimate;

  // Metadata
  agentId: string;
  model: string;             // "claude-3-5-sonnet-20241022"
  traceId: string;           // X-Ray trace ID
  tags: Record<string, string>;
}

interface Alternative {
  option: string;
  score: number;             // 0.0 - 10.0
  pros: string[];
  cons: string[];
  costEstimate: CostEstimate;
  wellArchitectedPillars: string[];  // Which pillars this option optimizes
  riskFactors: string[];
}

interface WellArchitectedMapping {
  operational_excellence: {
    score: number;
    rationale: string;
  };
  security: {
    score: number;
    rationale: string;
  };
  reliability: {
    score: number;
    rationale: string;
  };
  performance_efficiency: {
    score: number;
    rationale: string;
  };
  cost_optimization: {
    score: number;
    rationale: string;
  };
  sustainability: {
    score: number;
    rationale: string;
  };
}

interface CostEstimate {
  immediate: number;         // One-time cost (USD)
  monthly: number;           // Recurring monthly (USD)
  perTransaction: number;    // Unit cost (USD)
  assumptions: string[];     // ["10K sessions/day", "30-day retention"]
}
```

### Example: Database Selection Decision

```json
{
  "activityId": "act-2026-03-20-db-001",
  "tenantId": "tenant-acme",
  "timestamp": "2026-03-20T14:30:00.000Z",
  "decisionType": "infrastructure.database.selection",

  "question": "Which database engine should be used for user session storage?",
  "context": {
    "requirements": [
      "Read latency < 10ms at p99",
      "Write latency < 10ms at p99",
      "Support 10,000 sessions per day",
      "30-day session retention",
      "Multi-tenant data isolation"
    ],
    "constraints": [
      "Must use AWS managed service",
      "Must support encryption at rest",
      "Monthly budget: $500"
    ],
    "assumptions": [
      "Session access pattern is key-value lookups by sessionId",
      "No complex queries required",
      "Eventual consistency acceptable for non-auth flows"
    ]
  },

  "alternatives": [
    {
      "option": "Amazon DynamoDB",
      "score": 9.2,
      "pros": [
        "Single-digit millisecond latency guaranteed",
        "Serverless scaling with no capacity planning",
        "Built-in multi-tenancy via partition keys",
        "Cost-effective at projected scale ($45/month)",
        "Multi-AZ replication by default"
      ],
      "cons": [
        "Eventual consistency default (mitigated with ConsistentRead)",
        "Limited query flexibility (not needed for sessions)",
        "Learning curve for developers familiar with SQL"
      ],
      "costEstimate": {
        "immediate": 0.00,
        "monthly": 45.00,
        "perTransaction": 0.0000045,
        "assumptions": ["10K sessions/day", "2 reads + 1 write per session"]
      },
      "wellArchitectedPillars": [
        "performance_efficiency",
        "cost_optimization",
        "reliability"
      ],
      "riskFactors": [
        "Team unfamiliar with DynamoDB best practices"
      ]
    },
    {
      "option": "Amazon RDS PostgreSQL",
      "score": 8.5,
      "pros": [
        "Team already familiar with PostgreSQL",
        "ACID compliance for all transactions",
        "Flexible SQL queries for analytics",
        "JSON/JSONB support for session metadata"
      ],
      "cons": [
        "Higher cost at scale ($300/month)",
        "Requires capacity planning (db.t3.medium minimum)",
        "Cold start latency after failover (30-60s)",
        "Manual multi-AZ setup needed for HA"
      ],
      "costEstimate": {
        "immediate": 0.00,
        "monthly": 300.00,
        "perTransaction": 0.00003,
        "assumptions": ["db.t3.medium", "100 GB storage", "Multi-AZ"]
      },
      "wellArchitectedPillars": [
        "reliability",
        "operational_excellence"
      ],
      "riskFactors": [
        "Cost grows linearly with load",
        "Requires manual scaling for traffic spikes"
      ]
    },
    {
      "option": "Amazon ElastiCache Redis",
      "score": 7.0,
      "pros": [
        "Sub-millisecond latency",
        "Simple key-value API",
        "Team familiar with Redis"
      ],
      "cons": [
        "Not durable by default (requires AOF/snapshots)",
        "Cluster management overhead",
        "Higher cost than DynamoDB ($120/month for cache.t3.small)",
        "No native multi-tenancy support"
      ],
      "costEstimate": {
        "immediate": 0.00,
        "monthly": 120.00,
        "perTransaction": 0.000012,
        "assumptions": ["cache.t3.small", "Multi-AZ replication"]
      },
      "wellArchitectedPillars": [
        "performance_efficiency"
      ],
      "riskFactors": [
        "Data loss if cluster fails before snapshot",
        "Manual partition management for multi-tenancy"
      ]
    },
    {
      "option": "Amazon Aurora Serverless v2",
      "score": 8.0,
      "pros": [
        "PostgreSQL-compatible SQL",
        "Auto-scaling with serverless",
        "Multi-AZ by default",
        "Fast failover (< 30s)"
      ],
      "cons": [
        "Cost unpredictable with auto-scaling ($150-400/month)",
        "Cold start latency (5-30s on first request)",
        "Minimum ACU charge even at idle"
      ],
      "costEstimate": {
        "immediate": 0.00,
        "monthly": 250.00,
        "perTransaction": 0.000025,
        "assumptions": ["Min 1 ACU, max 4 ACU"]
      },
      "wellArchitectedPillars": [
        "reliability",
        "performance_efficiency"
      ],
      "riskFactors": [
        "Cost spikes during load testing",
        "ACU scaling lag during traffic spikes"
      ]
    }
  ],

  "selectedOption": "Amazon DynamoDB",
  "justification": "Session data access pattern is key-value lookups by sessionId with no complex query requirements. DynamoDB provides guaranteed single-digit millisecond latency at p99, automatic multi-AZ replication, and built-in multi-tenancy via partition keys (TENANT#{id}). Cost at projected 10K sessions/day is $45/month, 70% lower than RDS PostgreSQL. Eventual consistency is acceptable for session data outside of authentication flows (where we will use ConsistentRead=true). The team's unfamiliarity with DynamoDB is mitigated by comprehensive documentation and Well-Architected best practices.",

  "confidence": 0.92,
  "riskLevel": "low",

  "wellArchitectedPillars": {
    "operational_excellence": {
      "score": 8,
      "rationale": "Fully managed service, no capacity planning, CloudWatch metrics built-in"
    },
    "security": {
      "score": 9,
      "rationale": "Encryption at rest with AWS-managed keys, IAM-based access control, VPC endpoints available"
    },
    "reliability": {
      "score": 10,
      "rationale": "Multi-AZ replication by default, 99.99% SLA, automatic backups with PITR"
    },
    "performance_efficiency": {
      "score": 10,
      "rationale": "Single-digit millisecond latency at any scale, auto-scaling with on-demand mode"
    },
    "cost_optimization": {
      "score": 9,
      "rationale": "70% cost reduction vs RDS, pay-per-request pricing aligns with usage"
    },
    "sustainability": {
      "score": 8,
      "rationale": "Serverless architecture minimizes idle resource consumption"
    }
  },

  "costEstimate": {
    "immediate": 0.00,
    "monthly": 45.00,
    "perTransaction": 0.0000045,
    "assumptions": [
      "10,000 sessions created per day",
      "2 reads per session (auth + activity check)",
      "1 write per session (create)",
      "30-day retention with TTL",
      "On-demand billing mode"
    ]
  },

  "agentId": "agent-claude-3-5",
  "model": "claude-3-5-sonnet-20241022",
  "traceId": "1-5e1c6f5a-3d8e9f0a1b2c3d4e5f6a7b8c",
  "tags": {
    "decision-category": "infrastructure",
    "resource-type": "database",
    "impact-level": "high",
    "requires-approval": "false"
  }
}
```

---

## Well-Architected Framework Integration

### Mapping Decisions to Pillars

Every decision includes explicit mapping to AWS Well-Architected Framework pillars:

1. **Operational Excellence** — How well can this be operated and monitored?
2. **Security** — Does this meet security and compliance requirements?
3. **Reliability** — Will this be highly available and fault-tolerant?
4. **Performance Efficiency** — Does this meet latency and throughput requirements?
5. **Cost Optimization** — Is this cost-effective at projected scale?
6. **Sustainability** — Does this minimize environmental impact?

### Scoring Rubric

Each pillar scored 0-10:

| Score | Meaning | Example |
|-------|---------|---------|
| 0-3 | **Poor** — Does not meet pillar requirements | RDS without Multi-AZ for reliability |
| 4-6 | **Acceptable** — Meets minimum requirements | Single-AZ RDS with automated backups |
| 7-8 | **Good** — Exceeds requirements | Multi-AZ RDS with PITR |
| 9-10 | **Excellent** — Best practice implementation | DynamoDB with global tables |

### Example: Comparing Database Options

| Option | Reliability | Performance | Cost | Total |
|--------|------------|-------------|------|-------|
| **DynamoDB** | 10 (Multi-AZ default) | 10 (< 10ms p99) | 9 ($45/mo) | **29/30** |
| **RDS PostgreSQL** | 7 (Multi-AZ manual) | 8 (< 50ms p99) | 6 ($300/mo) | **21/30** |
| **ElastiCache** | 5 (Snapshot lag) | 10 (< 1ms p99) | 7 ($120/mo) | **22/30** |
| **Aurora Serverless** | 9 (Fast failover) | 8 (Cold start lag) | 7 ($250/mo) | **24/30** |

**Decision:** DynamoDB scores highest on combined Reliability, Performance, Cost pillars.

---

## Capturing Reasoning at Decision Time

### Agent Prompt Engineering

Chimera agents use structured prompts that enforce decision logging:

```xml
<decision_required>
You need to select a database for user session storage.

REQUIREMENTS:
- Read/write latency < 10ms at p99
- Support 10K sessions per day
- Multi-tenant isolation

Before executing any action, you MUST:
1. Identify 3-5 alternative approaches
2. Score each alternative (0-10) based on requirements
3. List pros/cons for each alternative
4. Map each alternative to Well-Architected pillars
5. Estimate cost for each alternative
6. Select the best option with justification
7. Call log_decision() with structured data

Only after logging the decision may you proceed to create resources.
</decision_required>
```

### log_decision() Tool

Agents have access to a `log_decision()` tool:

```typescript
{
  name: "log_decision",
  description: "Log a decision with alternatives, justification, and Well-Architected mapping",
  input_schema: {
    type: "object",
    properties: {
      question: { type: "string" },
      alternatives: {
        type: "array",
        items: {
          type: "object",
          properties: {
            option: { type: "string" },
            score: { type: "number", minimum: 0, maximum: 10 },
            pros: { type: "array", items: { type: "string" } },
            cons: { type: "array", items: { type: "string" } },
            wellArchitectedPillars: { type: "array", items: { type: "string" } }
          }
        },
        minItems: 2
      },
      selectedOption: { type: "string" },
      justification: { type: "string", minLength: 100 },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["question", "alternatives", "selectedOption", "justification"]
  }
}
```

**Enforcement:** Agent runtime blocks infrastructure actions until `log_decision()` has been called for the current decision context.

---

## Scoring and Ranking Alternatives

### Multi-Criteria Decision Analysis (MCDA)

Chimera uses weighted scoring across pillars:

```typescript
function calculateScore(alternative: Alternative, weights: PillarWeights): number {
  const pillarScores = {
    operational_excellence: alternative.wellArchitectedPillars.includes('operational_excellence') ? 8 : 5,
    security: alternative.wellArchitectedPillars.includes('security') ? 9 : 6,
    reliability: alternative.wellArchitectedPillars.includes('reliability') ? 9 : 6,
    performance: alternative.wellArchitectedPillars.includes('performance_efficiency') ? 10 : 5,
    cost: alternative.wellArchitectedPillars.includes('cost_optimization') ? 9 : 4,
    sustainability: alternative.wellArchitectedPillars.includes('sustainability') ? 7 : 5
  };

  const weightedScore =
    pillarScores.operational_excellence * weights.operational_excellence +
    pillarScores.security * weights.security +
    pillarScores.reliability * weights.reliability +
    pillarScores.performance * weights.performance +
    pillarScores.cost * weights.cost +
    pillarScores.sustainability * weights.sustainability;

  return weightedScore / (
    weights.operational_excellence +
    weights.security +
    weights.reliability +
    weights.performance +
    weights.cost +
    weights.sustainability
  );
}

// Example: Cost-conscious tenant
const costOptimizedWeights = {
  operational_excellence: 1.0,
  security: 1.5,
  reliability: 1.0,
  performance: 1.0,
  cost: 3.0,  // 3x weight on cost
  sustainability: 0.5
};

// Example: Reliability-first tenant
const reliabilityWeights = {
  operational_excellence: 1.0,
  security: 2.0,
  reliability: 3.0,  // 3x weight on reliability
  performance: 1.5,
  cost: 1.0,
  sustainability: 0.5
};
```

### Confidence Calculation

Confidence score (0.0-1.0) reflects how certain the agent is about the decision:

```typescript
function calculateConfidence(
  selectedScore: number,
  runnerUpScore: number,
  alternativeCount: number
): number {
  // High confidence: selected option significantly better than #2
  const scoreGap = selectedScore - runnerUpScore;
  const gapConfidence = Math.min(scoreGap / 2.0, 1.0);  // 2+ point gap = 100% confidence

  // Higher confidence with more alternatives considered
  const diversityBonus = Math.min(alternativeCount / 5.0, 1.0);

  return (gapConfidence + diversityBonus) / 2.0;
}

// Example:
// DynamoDB: 9.2, RDS: 8.5, ElastiCache: 7.0, Aurora: 8.0
// scoreGap = 9.2 - 8.5 = 0.7
// gapConfidence = 0.7 / 2.0 = 0.35
// diversityBonus = 4 / 5.0 = 0.8
// confidence = (0.35 + 0.8) / 2.0 = 0.575 (moderate confidence)
```

---

## Cost Estimation Integration

### AWS Pricing API Integration

Decision logger automatically fetches cost estimates:

```typescript
async function estimateCost(alternative: Alternative): Promise<CostEstimate> {
  switch (alternative.resourceType) {
    case 'dynamodb':
      return estimateDynamoDBCost(alternative.config);
    case 'rds':
      return estimateRDSCost(alternative.config);
    case 'elasticache':
      return estimateElastiCacheCost(alternative.config);
  }
}

async function estimateDynamoDBCost(config: DynamoDBConfig): Promise<CostEstimate> {
  const { sessionsPerDay, readsPerSession, writesPerSession, retentionDays } = config;

  // Calculate RCU/WCU per month
  const readsPerMonth = sessionsPerDay * readsPerSession * 30;
  const writesPerMonth = sessionsPerDay * writesPerSession * 30;

  // On-demand pricing
  const readCost = (readsPerMonth / 1000000) * 0.25;  // $0.25 per million reads
  const writeCost = (writesPerMonth / 1000000) * 1.25; // $1.25 per million writes

  // Storage cost
  const avgSessionSize = 1;  // 1 KB per session
  const storageGB = (sessionsPerDay * retentionDays * avgSessionSize) / (1024 * 1024);
  const storageCost = storageGB * 0.25;  // $0.25 per GB-month

  return {
    immediate: 0.00,
    monthly: readCost + writeCost + storageCost,
    perTransaction: (readCost + writeCost) / (readsPerMonth + writesPerMonth),
    assumptions: [
      `${sessionsPerDay} sessions per day`,
      `${readsPerSession} reads per session`,
      `${writesPerSession} writes per session`,
      `${retentionDays}-day retention`
    ]
  };
}
```

### Cost Alerts

Decision logger triggers alerts for high-cost decisions:

```typescript
if (costEstimate.monthly > 500) {
  await sendAlert({
    type: 'high-cost-decision',
    activityId: decisionLog.activityId,
    estimatedCost: costEstimate.monthly,
    justification: decisionLog.justification,
    alternatives: decisionLog.alternatives.map(a => ({
      option: a.option,
      cost: a.costEstimate.monthly
    }))
  });
}
```

---

## Storage and Retrieval

### DynamoDB Storage

```typescript
await ddb.putItem({
  TableName: 'chimera-activity-logs',
  Item: {
    PK: `TENANT#${tenantId}`,
    SK: `ACTIVITY#${timestamp}#${activityId}`,
    activityType: 'decision',
    decisionLog: decisionLogJSON,
    searchableText: `${question} ${selectedOption} ${justification}`,
    ttl: Math.floor(Date.now() / 1000) + (90 * 24 * 60 * 60)  // 90 days
  }
});
```

### S3 Archival

Every 5 minutes, Lambda function archives decision logs to S3:

```typescript
const logs = await queryRecentDecisions(lastArchiveTime);
const ndjson = logs.map(log => JSON.stringify(log)).join('\n');
const gzipped = gzipSync(ndjson);

await s3.putObject({
  Bucket: 'chimera-activity-archive',
  Key: `decisions/year=2026/month=03/day=20/hour=14/decisions-${timestamp}.json.gz`,
  Body: gzipped,
  ContentType: 'application/json',
  ContentEncoding: 'gzip'
});
```

---

## Query Patterns

### Pattern 1: "Why did agent choose X?"

```typescript
const decision = await ddb.query({
  TableName: 'chimera-activity-logs',
  IndexName: 'resource-activity-index',
  KeyConditionExpression: 'resourceArn = :arn',
  FilterExpression: 'activityType = :type',
  ExpressionAttributeValues: {
    ':arn': 'arn:aws:dynamodb:us-west-2:123456789012:table/chimera-sessions',
    ':type': 'decision'
  }
});

console.log(`Question: ${decision.Items[0].decisionLog.question}`);
console.log(`Selected: ${decision.Items[0].decisionLog.selectedOption}`);
console.log(`Justification: ${decision.Items[0].decisionLog.justification}`);
console.log(`Alternatives:`, decision.Items[0].decisionLog.alternatives);
```

### Pattern 2: "Show me all cost-optimization decisions"

```sql
-- Athena query on S3 archive
SELECT
  decisionLog.question,
  decisionLog.selectedOption,
  decisionLog.costEstimate.monthly AS estimated_monthly_cost,
  decisionLog.wellArchitectedPillars.cost_optimization.score AS cost_score,
  timestamp
FROM chimera_activities
WHERE activityType = 'decision'
  AND decisionLog.wellArchitectedPillars.cost_optimization.score >= 8
  AND year = 2026
  AND month = 3
ORDER BY decisionLog.costEstimate.monthly DESC;
```

### Pattern 3: "Find decisions with low confidence"

```typescript
const lowConfidenceDecisions = await ddb.query({
  TableName: 'chimera-activity-logs',
  IndexName: 'activity-type-index',
  KeyConditionExpression: 'activityType = :type',
  FilterExpression: 'decisionLog.confidence < :threshold',
  ExpressionAttributeValues: {
    ':type': 'decision',
    ':threshold': 0.7
  }
});

// These decisions may warrant human review
```

---

## UI/UX for Decision Review

### Decision Timeline View

```
┌────────────────────────────────────────────────────────────┐
│  Decision Timeline (Last 7 Days)                           │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  🗄️  Database Selection                     14:30:00 UTC  │
│     Selected: DynamoDB                                     │
│     Confidence: 92%          Cost Impact: $45/month       │
│     [View Details] [View Alternatives]                     │
│                                                            │
│  🚀  Compute Platform Selection             12:15:00 UTC  │
│     Selected: AWS Lambda                                   │
│     Confidence: 88%          Cost Impact: $120/month      │
│     [View Details] [View Alternatives]                     │
│                                                            │
│  📊  Monitoring Solution Selection          09:45:00 UTC  │
│     Selected: CloudWatch                                   │
│     Confidence: 95%          Cost Impact: $25/month       │
│     [View Details] [View Alternatives]                     │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Decision Detail View

```
┌────────────────────────────────────────────────────────────┐
│  Decision: Database Selection                              │
│  ID: act-2026-03-20-db-001                                │
│  Time: 2026-03-20 14:30:00 UTC                            │
│  Agent: claude-3-5-sonnet                                 │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  QUESTION                                                  │
│  Which database engine should be used for user session     │
│  storage?                                                  │
│                                                            │
│  SELECTED OPTION: Amazon DynamoDB                          │
│  Confidence: 92%                                           │
│                                                            │
│  JUSTIFICATION                                             │
│  Session data access pattern is key-value lookups by       │
│  sessionId with no complex query requirements. DynamoDB    │
│  provides guaranteed single-digit millisecond latency...   │
│                                                            │
│  ┌──────────────────────────────────────────────────────┐ │
│  │  ALTERNATIVES CONSIDERED                             │ │
│  ├──────────────────────────────────────────────────────┤ │
│  │  1. DynamoDB          9.2/10  [$45/mo]   ✓ SELECTED │ │
│  │     ✓ Single-digit ms latency                        │ │
│  │     ✓ Serverless scaling                             │ │
│  │     ✓ 70% cost reduction                             │ │
│  │     ⚠ Eventual consistency (mitigated)               │ │
│  │                                                       │ │
│  │  2. RDS PostgreSQL    8.5/10  [$300/mo]             │ │
│  │     ✓ Team familiar with PostgreSQL                  │ │
│  │     ✓ ACID compliance                                │ │
│  │     ✗ 6x higher cost                                 │ │
│  │     ✗ Manual capacity planning                       │ │
│  │                                                       │ │
│  │  3. Aurora Serverless 8.0/10  [$250/mo]             │ │
│  │  4. ElastiCache Redis 7.0/10  [$120/mo]             │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  WELL-ARCHITECTED FRAMEWORK                                │
│  ┌────────────────────────────────────────────┐           │
│  │  Performance Efficiency      ██████████ 10 │           │
│  │  Reliability                ██████████ 10 │           │
│  │  Cost Optimization          █████████░  9 │           │
│  │  Security                   █████████░  9 │           │
│  │  Operational Excellence     ████████░░  8 │           │
│  │  Sustainability             ████████░░  8 │           │
│  └────────────────────────────────────────────┘           │
│                                                            │
│  COST IMPACT                                               │
│  Immediate: $0         Monthly: $45                        │
│  Per Transaction: $0.0000045                               │
│                                                            │
│  [View Linked Actions] [View ADR] [Export Decision]       │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

## Code Examples

### Agent Implementation

```typescript
import { Strands, tool } from '@strands/sdk';
import { logDecision } from './decision-logger';

const agent = new Strands({
  model: 'claude-3-5-sonnet-20241022',
  tools: [
    tool({
      name: 'setup_database',
      description: 'Set up database for the application',
      input_schema: {
        type: 'object',
        properties: {
          purpose: { type: 'string' },
          requirements: { type: 'array', items: { type: 'string' } }
        }
      },
      execute: async ({ purpose, requirements }) => {
        // BEFORE creating resources, log decision
        const decision = await agent.makeDecision({
          question: `Which database engine for ${purpose}?`,
          requirements,
          alternatives: [
            { option: 'DynamoDB', ...},
            { option: 'RDS PostgreSQL', ...},
            { option: 'ElastiCache', ...}
          ]
        });

        // Log decision to DynamoDB
        await logDecision(decision);

        // NOW create the resource
        const result = await createDatabase(decision.selectedOption);

        return {
          decisionId: decision.activityId,
          resource: result
        };
      }
    })
  ]
});
```

### Decision Query API

```typescript
// Express endpoint for querying decisions
app.get('/api/decisions', async (req, res) => {
  const { tenantId, startDate, endDate, minConfidence } = req.query;

  const decisions = await ddb.query({
    TableName: 'chimera-activity-logs',
    KeyConditionExpression: 'PK = :tenantId AND SK BETWEEN :start AND :end',
    FilterExpression: 'activityType = :type AND decisionLog.confidence >= :conf',
    ExpressionAttributeValues: {
      ':tenantId': `TENANT#${tenantId}`,
      ':start': `ACTIVITY#${startDate}`,
      ':end': `ACTIVITY#${endDate}`,
      ':type': 'decision',
      ':conf': parseFloat(minConfidence) || 0.0
    }
  });

  res.json({
    decisions: decisions.Items.map(item => ({
      id: item.activityId,
      timestamp: item.timestamp,
      question: item.decisionLog.question,
      selected: item.decisionLog.selectedOption,
      justification: item.decisionLog.justification,
      confidence: item.decisionLog.confidence,
      costImpact: item.decisionLog.costEstimate.monthly
    }))
  });
});
```

---

## Key Takeaways

1. **Document reasoning at decision time** — captures agent's mental model, including alternatives not chosen

2. **Structure enables queryability** — "show me all database decisions" is a SQL query, not log parsing

3. **Well-Architected integration** — every decision explicitly maps to AWS pillars, enabling compliance audits

4. **Cost transparency** — estimated cost captured alongside technical justification

5. **Confidence scoring** — low-confidence decisions can trigger human review

6. **Multi-criteria decision analysis** — weighted scoring across pillars produces optimal choice

7. **Operator handoff** — human can understand why agent chose X by reading decision log

8. **Continuous learning** — analyze 100+ decisions to identify patterns and improve agent prompts

---

**Next:** [[03-Action-Audit-Trail-Structured-Storage]] — How every API call, resource creation, and config change is logged with full context
