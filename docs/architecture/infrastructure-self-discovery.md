---
title: "Infrastructure Self-Discovery"
version: 1.0.0
status: canonical
last_updated: 2026-03-30
---

# Infrastructure Self-Discovery

How Chimera agents discover and reason about their own AWS infrastructure state
at runtime — without hardcoded ARNs or config files.

---

## Why Self-Discovery Matters

Agents that hardcode infrastructure references (ARNs, endpoint URLs, table names)
become brittle when stacks are redeployed, regions change, or environments
multiply. Self-discovery lets agents operate correctly across `dev`, `staging`,
and `prod` by reading live AWS state instead of config files.

---

## Pattern 1: CloudFormation Stack Outputs (Preferred)

CDK stacks export named values via `CfnOutput`. Agents read these at startup via
`DescribeStacks` to get authoritative, versioned endpoint references.

### Reading outputs programmatically

```typescript
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";

const cfn = new CloudFormationClient({ region: process.env.AWS_REGION });

async function getStackOutputs(stackName: string): Promise<Record<string, string>> {
  const { Stacks } = await cfn.send(new DescribeStacksCommand({ StackName: stackName }));
  const outputs: Record<string, string> = {};
  for (const output of Stacks?.[0]?.Outputs ?? []) {
    if (output.OutputKey && output.OutputValue) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
}

// Example: get the chat endpoint from the ChatStack
const chat = await getStackOutputs("Chimera-dev-Chat");
const chatUrl = chat["ChatAlbDnsName"]; // ECS ALB DNS
```

### Stack naming convention

All Chimera stacks follow the pattern: `Chimera-{env}-{StackName}`

| Stack | Key Outputs |
|-------|-------------|
| `Chimera-{env}-Network` | VPC ID, subnet IDs, security group IDs |
| `Chimera-{env}-Data` | DynamoDB table names, S3 bucket names |
| `Chimera-{env}-Security` | Cognito pool ID, KMS key ARNs |
| `Chimera-{env}-Chat` | ALB DNS, ECS cluster ARN |
| `Chimera-{env}-Api` | API Gateway invoke URL |

### Discovering all deployed Chimera stacks

```typescript
import { CloudFormationClient, ListStacksCommand, StackStatus } from "@aws-sdk/client-cloudformation";

async function listChimeraStacks(env: string): Promise<string[]> {
  const cfn = new CloudFormationClient({ region: process.env.AWS_REGION });
  const { StackSummaries } = await cfn.send(new ListStacksCommand({
    StackStatusFilter: [StackStatus.CREATE_COMPLETE, StackStatus.UPDATE_COMPLETE],
  }));
  return (StackSummaries ?? [])
    .filter(s => s.StackName?.startsWith(`Chimera-${env}-`))
    .map(s => s.StackName!);
}
```

**Tradeoffs:**
- ✅ Source-of-truth — CFN outputs are always in sync with deployed resources
- ✅ No extra infrastructure required
- ✅ Works across environments via stack naming convention
- ⚠️ Requires `cloudformation:DescribeStacks` IAM permission
- ⚠️ Latency: ~200-400ms per DescribeStacks call (cache on startup)

---

## Pattern 2: Resource Tags Query (AWS Resource Explorer)

All Chimera resources carry three tags applied by the CDK `TaggingAspect`:

```
Project=Chimera
Environment=dev|staging|prod
ManagedBy=CDK
```

AWS Resource Explorer (or `resourcegroupstaggingapi`) can enumerate all Chimera
resources in an account/region from these tags.

### Enumerate all tagged Chimera resources

```typescript
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";

async function discoverChimeraResources(env: string) {
  const client = new ResourceGroupsTaggingAPIClient({ region: process.env.AWS_REGION });
  const { ResourceTagMappingList } = await client.send(
    new GetResourcesCommand({
      TagFilters: [
        { Key: "Project", Values: ["Chimera"] },
        { Key: "Environment", Values: [env] },
      ],
    })
  );
  return ResourceTagMappingList ?? [];
}
```

**Tradeoffs:**
- ✅ Works even for resources that don't have CFN outputs
- ✅ Comprehensive — finds DynamoDB, S3, KMS, VPC, Cognito, ECS, etc.
- ✅ Useful for auditing / detecting orphaned resources
- ⚠️ Tag propagation can lag 15-30 seconds after resource creation
- ⚠️ Not all resource types support tagging API (e.g., S3 access log buckets)
- ⚠️ Returns ARNs, not structured data — requires secondary lookups for endpoint URLs

---

## Pattern 3: chimera-infrastructure DDB Table (Future)

For agents that need sub-millisecond infrastructure lookups or that need to
store derived state (not just CFN outputs), a dedicated `chimera-infrastructure`
DDB table can act as a self-describing registry.

### Proposed schema

```
PK: INFRA#{environment}              SK: STACK#{stackName}
  stackName: "Chimera-dev-Chat"
  status: "deployed"
  deployedAt: "2026-03-27T19:09:29Z"
  outputs: { chatUrl: "...", clusterArn: "..." }

PK: INFRA#{environment}              SK: RESOURCE#{resourceType}#{name}
  type: "dynamodb-table"
  name: "chimera-tenants-dev"
  arn: "arn:aws:dynamodb:us-west-2:386931836011:table/chimera-tenants-dev"
  stack: "Chimera-dev-Data"
```

### Population mechanism

A post-deploy Lambda or CDK Custom Resource writes to this table after each
successful stack deployment. The `chimera deploy` CLI command triggers this
after `cdk deploy` completes (extends the zero-touch deploy flow).

**Tradeoffs:**
- ✅ Sub-millisecond reads — no CFN API call overhead
- ✅ Can store computed/derived state that CFN outputs don't capture
- ✅ Queryable — find all resources of a given type, all stacks in an env
- ⚠️ Requires keeping the table in sync (stale on failed deploys)
- ⚠️ Adds infrastructure dependency (the table must exist before agents start)
- ⚠️ Not recommended until multiple stacks are deployed and CFN lookups become a bottleneck

---

## Recommendation

**Use Pattern 1 (CFN outputs) today.** It requires no extra infrastructure,
is always consistent, and sufficient for the current deployment footprint
(3–4 stacks). Cache the outputs in memory at agent startup.

Introduce Pattern 3 (DDB registry) when the stack count exceeds 6 and agents
make >100 infrastructure lookups per request.

---

## Current Infrastructure State (as of 2026-03-30)

Audited in us-west-2, account `386931836011`:

### Active Stacks

| Stack | Status | Deployed |
|-------|--------|----------|
| `Chimera-dev-Network` | CREATE_COMPLETE | 2026-03-27 |
| `Chimera-dev-Data` | CREATE_COMPLETE | 2026-03-27 |
| `Chimera-dev-Frontend` | CREATE_COMPLETE | 2026-03-27 |

### Cleaned Up (this session)

| Resource | Type | Reason |
|----------|------|--------|
| `Chimera-dev-Evolution` | CloudFormation stack | DELETE_FAILED — orphaned from previous deploy cycle |
| `chimera-dev-evolution-evolutionartifactsbucketacce-toqozfgywyse` | S3 bucket | Access logs bucket blocking Evolution stack delete; emptied and deleted |
| `chimera-evolution-state-dev` | DynamoDB table | Empty GlobalTable blocking Evolution stack delete; deleted |
| `Chimera-dev-Api-ApiCloudWatchRole73EC6FC4-LiCXyS1ydbU2` | IAM Role | Orphaned from Api stack deploy 2026-03-23 |
| `Chimera-dev-Api-ApiCloudWatchRole73EC6FC4-lXoiFqeSgJLf` | IAM Role | Orphaned from Api stack deploy 2026-03-26 |
| `Chimera-dev-Api-ApiCloudWatchRole73EC6FC4-YsgDPe2TwIQx` | IAM Role | Orphaned from Api stack deploy 2026-03-27 |

### Tagging Verification

All active resources have the required tags:

| Tag | Value | Verified On |
|-----|-------|-------------|
| `Project` | `Chimera` | All 3 stacks + all S3 buckets + DDB tables + KMS key + VPC |
| `Environment` | `dev` | All 3 stacks + all S3 buckets + DDB tables + KMS key + VPC |
| `ManagedBy` | `CDK` | All 3 stacks + all S3 buckets + DDB tables + KMS key + VPC |

The CDK `TaggingAspect` is functioning correctly. Resource-level tags confirmed
on: VPC, 6 S3 buckets (including access-log buckets), DynamoDB tables, KMS key.

---

## Orphan Prevention

Orphaned resources accumulate when stacks are deleted but retain non-empty
S3 buckets, DynamoDB tables with deletion protection, or IAM roles that CDK
couldn't fully clean up. The `chimera destroy` command should:

1. Call `chimera destroy` which runs `cdk destroy --all`
2. Additionally delete the CodeCommit repo via SDK (tracked in mulch: `destroy-codecommit-out-of-band`)
3. **Post-destroy check**: list remaining IAM roles matching `Chimera-{env}-*` and delete strays
4. **Post-destroy check**: list remaining S3 buckets matching `chimera-*-{env}-*`, empty and delete any not in current deployment

The `chimera doctor` command could incorporate a lightweight orphan scan
using the tagging API to alert on resources whose stack no longer exists.
