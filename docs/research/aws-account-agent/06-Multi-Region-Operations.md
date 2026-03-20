# Multi-Region Operations for Chimera Agents

---
**Date:** 2026-03-20
**Purpose:** Design patterns for deploying Chimera agents across multiple AWS regions for latency, compliance, and high availability
**Scope:** Cross-region infrastructure, data replication, routing, cost implications, and data residency requirements
**Related:** [[05-IAM-Scoping-Least-Privilege]], [[01-AWS-Services-Audit]], [[06-AWS-Services-Agent-Infrastructure]]
---

## Executive Summary

Multi-region deployment enables Chimera to:

1. **Reduce latency** — Users in EU access agents in `eu-west-1` instead of `us-east-1`
2. **Meet compliance requirements** — GDPR requires EU data stays in EU, HIPAA needs US-only
3. **Increase availability** — Regional failures don't take down the entire platform
4. **Scale globally** — Support 10K+ concurrent agents across continents

This document covers:
- **Regional architecture** — Which services are global vs regional
- **Cross-region data replication** — DynamoDB Global Tables, S3 CRR, Aurora Global Database
- **Routing and failover** — Route 53, CloudFront, API Gateway multi-region endpoints
- **Bedrock cross-region inference** — Global inference profiles for low-latency model access
- **Cost implications** — Data transfer, replication, and regional pricing differences
- **Data residency enforcement** — IAM SCPs, resource tagging, and compliance validation

---

## 1. Regional Architecture Overview

### 1.1 Global vs Regional Services

| Service | Scope | Deployment Strategy |
|---------|-------|---------------------|
| **Cognito** | Regional | Replicate user pools per region |
| **DynamoDB** | Regional | Use Global Tables for cross-region sync |
| **S3** | Regional | Cross-Region Replication (CRR) |
| **Lambda** | Regional | Deploy functions to each region |
| **ECS/Fargate** | Regional | Deploy clusters per region |
| **Bedrock** | Regional | Use cross-region inference profiles |
| **API Gateway** | Regional | Multi-region endpoints with Route 53 |
| **CloudFront** | Global | Single distribution with regional origins |
| **Route 53** | Global | Single hosted zone, multi-region records |
| **IAM** | Global | Roles work across all regions |
| **Secrets Manager** | Regional | Replicate secrets per region |

**Key insight:** IAM roles are global, but assumed role sessions are region-specific. An agent in `eu-west-1` can assume a role defined in `us-east-1`, but the temporary credentials are issued by the regional STS endpoint.

### 1.2 Chimera Multi-Region Deployment Model

```
┌─────────────────────────────────────────────────────────────────┐
│                         Global Layer                             │
│  • Route 53 (DNS routing)                                       │
│  • CloudFront (CDN, SSL termination)                            │
│  • IAM (roles, policies)                                        │
└─────────────────────────────────────────────────────────────────┘
           │                    │                    │
           ▼                    ▼                    ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   us-east-1      │  │   eu-west-1      │  │   ap-south-1     │
│                  │  │                  │  │                  │
│  • API Gateway   │  │  • API Gateway   │  │  • API Gateway   │
│  • ECS/Fargate   │  │  • ECS/Fargate   │  │  • ECS/Fargate   │
│  • Lambda        │  │  • Lambda        │  │  • Lambda        │
│  • DynamoDB      │◄─┼─►• DynamoDB      │◄─┼─►• DynamoDB      │
│  • S3 (CRR)      │◄─┼─►• S3 (CRR)      │◄─┼─►• S3 (CRR)      │
│  • Bedrock       │  │  • Bedrock       │  │  • Bedrock       │
│  • Cognito       │  │  • Cognito       │  │  • Cognito       │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

**Traffic flow:**
1. User requests `https://api.chimera.ai/agents/invoke`
2. Route 53 resolves to nearest CloudFront edge
3. CloudFront routes to nearest API Gateway regional endpoint
4. API Gateway invokes Lambda/ECS in that region
5. Agent accesses DynamoDB Global Table (local read, cross-region replication)
6. Agent calls Bedrock using cross-region inference profile

---

## 2. Cross-Region Data Replication

### 2.1 DynamoDB Global Tables

**Purpose:** Replicate tenant data across regions with automatic conflict resolution.

**Architecture:**
```typescript
// infra/lib/data-stack.ts
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

const tenantsTable = new dynamodb.TableV2(this, 'TenantsTable', {
  tableName: 'chimera-tenants',
  partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
  billing: dynamodb.Billing.onDemand(),
  replicas: [
    { region: 'us-east-1' },
    { region: 'eu-west-1' },
    { region: 'ap-south-1' },
  ],
  pointInTimeRecovery: true,
  deletionProtection: true,
});
```

**Replication behavior:**
- Writes to any region replicate to all others (eventual consistency, typically <1 second)
- Strongly consistent reads only work in the write region
- Agents should use eventually consistent reads (`ConsistentRead=false`) for multi-region

**Conflict resolution:**
- DynamoDB uses "last writer wins" based on timestamp
- For critical operations (e.g., quota decrement), use conditional updates:

```python
import boto3
from botocore.exceptions import ClientError

dynamodb = boto3.client('dynamodb')

def decrement_quota(tenant_id: str, amount: int):
    try:
        response = dynamodb.update_item(
            TableName='chimera-tenants',
            Key={'PK': {'S': f'TENANT#{tenant_id}'}, 'SK': {'S': 'QUOTA#api-requests'}},
            UpdateExpression='SET #current = #current - :amount',
            ConditionExpression='#current >= :amount',  # Prevent negative quotas
            ExpressionAttributeNames={'#current': 'current'},
            ExpressionAttributeValues={':amount': {'N': str(amount)}},
            ReturnValues='UPDATED_NEW'
        )
        return response['Attributes']['current']['N']
    except ClientError as e:
        if e.response['Error']['Code'] == 'ConditionalCheckFailedException':
            raise QuotaExceededException(f'Quota exceeded for tenant {tenant_id}')
        raise
```

**Cost:**
- Global Tables charge for replicated WCUs (write capacity units)
- Writing 1 item = 1 WCU in primary region + 1 WCU per replica region
- 100 writes/sec across 3 regions = 300 WCU/sec = ~$42/day on-demand

**When to use:**
- Tenant configuration (replicate everywhere for local reads)
- Session state (replicate for cross-region failover)

**When NOT to use:**
- Audit logs (append-only, region-specific writes are fine)
- Cost tracking (regional aggregation, then combine)

### 2.2 S3 Cross-Region Replication (CRR)

**Purpose:** Replicate tenant data files across regions for durability and low-latency access.

**Architecture:**
```typescript
// infra/lib/data-stack.ts
import * as s3 from 'aws-cdk-lib/aws-s3';

const tenantBucket = new s3.Bucket(this, 'TenantBucket', {
  bucketName: `chimera-tenants-${envName}`,
  versioned: true, // Required for CRR
  replicationConfiguration: {
    role: replicationRole.roleArn,
    rules: [
      {
        id: 'ReplicateToEU',
        status: 'Enabled',
        priority: 1,
        destination: {
          bucket: 'arn:aws:s3:::chimera-tenants-eu-west-1',
          replicationTime: {
            status: 'Enabled',
            time: { minutes: 15 }, // S3 RTC for <15min replication
          },
          metrics: { status: 'Enabled' },
        },
        filter: { prefix: 'tenants/' },
      },
    ],
  },
});
```

**Replication options:**
- **Standard CRR** — Eventual consistency, typically minutes
- **S3 Replication Time Control (RTC)** — 99.99% of objects replicated in 15 minutes ($0.015/GB)

**Selective replication:**
- Replicate only tenant data (`tenants/*`), not system logs or temp files
- Use S3 object tags to control replication (e.g., `Replicate=true`)

**Cost:**
- Replication request cost: $0.0005 per 1,000 PUT requests
- Data transfer: $0.02/GB from `us-east-1` to `eu-west-1`
- Storage in replica: Same as standard S3 ($0.023/GB/month for S3 Standard)

**Example:** 1TB tenant data replicated from US to EU:
- Transfer: 1000 GB × $0.02 = $20
- Storage in EU: 1000 GB × $0.023 = $23/month
- **Total: $20 one-time + $23/month**

### 2.3 RDS Aurora Global Database

For tenants requiring relational databases (rare in Chimera, but supported for enterprise):

**Architecture:**
```typescript
import * as rds from 'aws-cdk-lib/aws-rds';

const globalCluster = new rds.DatabaseCluster(this, 'GlobalCluster', {
  engine: rds.DatabaseClusterEngine.auroraPostgres({
    version: rds.AuroraPostgresEngineVersion.VER_15_3,
  }),
  writer: rds.ClusterInstance.provisioned('writer', {
    instanceType: ec2.InstanceType.of(ec2.InstanceClass.R6G, ec2.InstanceSize.XLARGE),
  }),
  readers: [
    rds.ClusterInstance.provisioned('reader-us', { /* ... */ }),
    rds.ClusterInstance.provisioned('reader-eu', { /* ... */ }),
  ],
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
});
```

**Replication:**
- Primary region: `us-east-1` (read-write)
- Secondary region: `eu-west-1` (read-only replica, <1 second lag)
- Failover: Promote secondary to primary if primary fails (<1 minute RTO)

**Cost:**
- Aurora I/O-optimized: $0.20/GB storage + $0.48/hour for r6g.xlarge writer
- Cross-region replication: $0.02/GB data transfer
- **Typical cost:** $350/month for 100GB database with 2 read replicas

---

## 3. Bedrock Cross-Region Inference

### 3.1 Global Inference Profiles

Bedrock **cross-region inference profiles** route model invocations to the nearest region with capacity.

**Why this matters:**
- Agent in `eu-west-1` calling `us-east-1` Bedrock adds 80-100ms latency
- Global inference profile routes to EU model automatically

**Architecture:**
```python
import boto3

bedrock = boto3.client('bedrock-runtime', region_name='eu-west-1')

response = bedrock.invoke_model(
    modelId='us.anthropic.claude-sonnet-4-20250514',  # Cross-region profile
    contentType='application/json',
    accept='application/json',
    body=json.dumps({
        'anthropic_version': 'bedrock-2023-05-31',
        'messages': [{'role': 'user', 'content': 'Explain quantum computing'}],
        'max_tokens': 4096,
    })
)
```

**Profile routing:**
- `us.anthropic.claude-sonnet-*` → Routes to US, EU, or Asia based on caller region
- `anthropic.claude-sonnet-*` → Regional model ID (e.g., `anthropic.claude-sonnet-20250514` only available in `us-east-1`)

**Pricing:**
- Same token pricing regardless of routing (no extra charge for cross-region)
- Example: Claude Sonnet = $0.003/1K input tokens, $0.015/1K output tokens (all regions)

**Implementation:**
```typescript
// packages/core/src/bedrock/inference-client.ts
export class BedrockInferenceClient {
  private client: BedrockRuntimeClient;

  constructor(region: string) {
    // Use cross-region inference profile
    this.client = new BedrockRuntimeClient({ region });
  }

  async invoke(tenantId: string, prompt: string): Promise<string> {
    const tier = await this.getTenantTier(tenantId);
    const modelId = this.getModelForTier(tier);

    const response = await this.client.send(new InvokeModelCommand({
      modelId, // e.g., "us.anthropic.claude-sonnet-4-20250514"
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({/* ... */}),
    }));

    return JSON.parse(new TextDecoder().decode(response.body)).content[0].text;
  }

  private getModelForTier(tier: string): string {
    // Use cross-region profiles (us.* prefix)
    switch (tier) {
      case 'basic': return 'us.anthropic.claude-haiku-4-20250514';
      case 'advanced': return 'us.anthropic.claude-sonnet-4-20250514';
      case 'enterprise': return 'us.anthropic.claude-opus-4-20250514';
      default: return 'us.anthropic.claude-sonnet-4-20250514';
    }
  }
}
```

---

## 4. Routing and Failover

### 4.1 Route 53 Geo-Proximity Routing

Route users to the nearest region:

```typescript
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';

const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
  domainName: 'chimera.ai',
});

// API endpoint in us-east-1
new route53.ARecord(this, 'ApiUsEast1', {
  zone: hostedZone,
  recordName: 'api',
  target: route53.RecordTarget.fromAlias(
    new targets.ApiGatewayDomain(usEast1Domain)
  ),
  geoLocation: route53.GeoLocation.country('US'),
});

// API endpoint in eu-west-1
new route53.ARecord(this, 'ApiEuWest1', {
  zone: hostedZone,
  recordName: 'api',
  target: route53.RecordTarget.fromAlias(
    new targets.ApiGatewayDomain(euWest1Domain)
  ),
  geoLocation: route53.GeoLocation.continent(route53.Continent.EUROPE),
});

// Default fallback to us-east-1
new route53.ARecord(this, 'ApiDefault', {
  zone: hostedZone,
  recordName: 'api',
  target: route53.RecordTarget.fromAlias(
    new targets.ApiGatewayDomain(usEast1Domain)
  ),
  geoLocation: route53.GeoLocation.default_(),
});
```

**Routing behavior:**
- US users → `us-east-1`
- EU users → `eu-west-1`
- Asia users → `ap-south-1`
- Others → default (`us-east-1`)

### 4.2 Route 53 Health Checks and Failover

Automatically fail over to healthy region:

```typescript
// Health check for us-east-1 API
const usHealthCheck = new route53.CfnHealthCheck(this, 'UsHealthCheck', {
  healthCheckConfig: {
    type: 'HTTPS',
    resourcePath: '/health',
    fullyQualifiedDomainName: 'api-us-east-1.chimera.ai',
    port: 443,
    requestInterval: 30,
    failureThreshold: 3,
  },
});

// Failover record set
new route53.ARecord(this, 'ApiFailover', {
  zone: hostedZone,
  recordName: 'api',
  target: route53.RecordTarget.fromAlias(new targets.ApiGatewayDomain(usEast1Domain)),
  setIdentifier: 'us-east-1-primary',
  failover: route53.FailoverType.PRIMARY,
  healthCheck: route53.HealthCheck.fromHealthCheckId(this, 'UsHC', usHealthCheck.attrHealthCheckId),
});

new route53.ARecord(this, 'ApiFailoverSecondary', {
  zone: hostedZone,
  recordName: 'api',
  target: route53.RecordTarget.fromAlias(new targets.ApiGatewayDomain(euWest1Domain)),
  setIdentifier: 'eu-west-1-secondary',
  failover: route53.FailoverType.SECONDARY,
});
```

**Failover behavior:**
- Health check polls `us-east-1` every 30 seconds
- 3 consecutive failures → Route 53 switches DNS to `eu-west-1`
- Recovery: 3 consecutive successes → Route 53 switches back to `us-east-1`

### 4.3 CloudFront Multi-Origin Failover

Use CloudFront with origin groups for automatic failover:

```typescript
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';

const distribution = new cloudfront.Distribution(this, 'ApiDistribution', {
  defaultBehavior: {
    origin: new cloudfront.OriginGroup({
      primaryOrigin: new cloudfront.HttpOrigin('api-us-east-1.chimera.ai'),
      fallbackOrigin: new cloudfront.HttpOrigin('api-eu-west-1.chimera.ai'),
      fallbackStatusCodes: [500, 502, 503, 504],
    }),
    cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // API responses are dynamic
    allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
  },
  domainNames: ['api.chimera.ai'],
  certificate: certificate,
});
```

**Failover logic:**
- Request to `https://api.chimera.ai/agents/invoke`
- CloudFront tries `us-east-1` origin
- If origin returns 500/502/503/504 → CloudFront retries with `eu-west-1`
- Client sees successful response (transparent failover)

---

## 5. Data Residency and Compliance

### 5.1 GDPR: EU Data Must Stay in EU

**Requirement:** Personal data of EU residents cannot be processed outside the EU.

**Architecture:**
- EU tenant data stored in `eu-west-1` S3 bucket and DynamoDB table (no Global Tables)
- AgentCore Runtime sessions for EU tenants run in `eu-west-1` ECS
- Bedrock invocations use EU regional endpoints (no cross-region profiles)

**IAM enforcement:**
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyNonEURegions",
    "Effect": "Deny",
    "Action": "*",
    "Resource": "*",
    "Condition": {
      "StringNotEquals": {
        "aws:RequestedRegion": ["eu-west-1", "eu-central-1", "eu-north-1"]
      }
    }
  }]
}
```

**Tenant metadata tagging:**
```python
# Tag tenant with data residency requirement
dynamodb.put_item(
    TableName='chimera-tenants',
    Item={
        'PK': {'S': 'TENANT#eu-tenant-123'},
        'SK': {'S': 'PROFILE'},
        'dataRegion': {'S': 'eu-west-1'},
        'dataResidencyPolicy': {'S': 'GDPR'},  # Prevent cross-region replication
        # ...
    }
)
```

### 5.2 HIPAA: US-Only Processing

**Requirement:** Protected Health Information (PHI) must be processed only in HIPAA-compliant US regions.

**Approved regions:**
- `us-east-1` (N. Virginia)
- `us-west-2` (Oregon)
- `us-gov-west-1` (AWS GovCloud)

**BAA requirement:**
- Tenants storing PHI must have a signed Business Associate Agreement (BAA) with AWS
- Chimera platform must also have a BAA (covered under AWS's HIPAA compliance)

**Implementation:**
```json
{
  "Sid": "RequireUSRegionsForPHI",
  "Effect": "Deny",
  "Action": "*",
  "Resource": "*",
  "Condition": {
    "StringEquals": {
      "aws:ResourceTag/DataClass": "PHI"
    },
    "StringNotEquals": {
      "aws:RequestedRegion": ["us-east-1", "us-west-2"]
    }
  }
}
```

### 5.3 Data Sovereignty Validation

Use AWS Config to audit resource locations:

```typescript
import * as config from 'aws-cdk-lib/aws-config';

// Deny S3 buckets outside approved regions
new config.ManagedRule(this, 'S3RegionCheck', {
  configRuleName: 'chimera-s3-region-compliance',
  identifier: config.ManagedRuleIdentifiers.S3_BUCKET_REGION_COMPLIANCE,
  inputParameters: {
    allowedRegions: 'us-east-1,us-west-2', // HIPAA tenants
  },
});

// Deny DynamoDB tables outside approved regions
new config.ManagedRule(this, 'DynamoDBRegionCheck', {
  configRuleName: 'chimera-dynamodb-region-compliance',
  identifier: config.ManagedRuleIdentifiers.DYNAMODB_TABLE_REGION_COMPLIANCE,
  inputParameters: {
    allowedRegions: 'eu-west-1,eu-central-1', // GDPR tenants
  },
});
```

---

## 6. Regional Deployment Strategy

### 6.1 CDK Multi-Region Deployment

Deploy the same stack to multiple regions:

```typescript
// bin/chimera.ts
import * as cdk from 'aws-cdk-lib';
import { ChimeraStack } from '../lib/chimera-stack';

const app = new cdk.App();

// Deploy to us-east-1
new ChimeraStack(app, 'ChimeraUsEast1', {
  env: { region: 'us-east-1', account: process.env.CDK_DEFAULT_ACCOUNT },
  envName: 'prod',
});

// Deploy to eu-west-1
new ChimeraStack(app, 'ChimeraEuWest1', {
  env: { region: 'eu-west-1', account: process.env.CDK_DEFAULT_ACCOUNT },
  envName: 'prod',
});

// Deploy to ap-south-1
new ChimeraStack(app, 'ChimeraApSouth1', {
  env: { region: 'ap-south-1', account: process.env.CDK_DEFAULT_ACCOUNT },
  envName: 'prod',
});
```

**Deployment order:**
1. Deploy global resources (IAM roles, Route 53 hosted zone)
2. Deploy regional stacks in parallel
3. Configure cross-region replication (DynamoDB Global Tables, S3 CRR)
4. Update Route 53 records to point to all regions

### 6.2 CI/CD Multi-Region Pipeline

```yaml
# .github/workflows/deploy-multi-region.yml
name: Deploy Multi-Region

on:
  push:
    branches: [main]

jobs:
  deploy-us-east-1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: bun install
      - run: bun run build
      - run: npx cdk deploy ChimeraUsEast1 --require-approval never
        env:
          AWS_DEFAULT_REGION: us-east-1

  deploy-eu-west-1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: bun install
      - run: bun run build
      - run: npx cdk deploy ChimeraEuWest1 --require-approval never
        env:
          AWS_DEFAULT_REGION: eu-west-1

  deploy-ap-south-1:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: bun install
      - run: bun run build
      - run: npx cdk deploy ChimeraApSouth1 --require-approval never
        env:
          AWS_DEFAULT_REGION: ap-south-1
```

### 6.3 Blue-Green Deployment Across Regions

Roll out updates region-by-region to minimize blast radius:

1. Deploy to `us-east-1` (canary region)
2. Monitor metrics for 1 hour
3. If healthy → deploy to `eu-west-1`
4. Monitor for 1 hour
5. If healthy → deploy to `ap-south-1`

**Implementation:**
```bash
#!/bin/bash
# scripts/multi-region-deploy.sh

REGIONS=("us-east-1" "eu-west-1" "ap-south-1")

for region in "${REGIONS[@]}"; do
  echo "Deploying to $region..."
  npx cdk deploy ChimeraStack-$region --require-approval never

  echo "Waiting for health check..."
  sleep 3600  # 1 hour monitoring window

  # Check CloudWatch alarms
  alarms=$(aws cloudwatch describe-alarms --region $region --state-value ALARM --query 'MetricAlarms[].AlarmName' --output text)

  if [ -n "$alarms" ]; then
    echo "❌ Alarms triggered in $region: $alarms"
    echo "Rolling back..."
    npx cdk deploy ChimeraStack-$region --rollback
    exit 1
  fi

  echo "✅ $region deployment successful"
done
```

---

## 7. Cost Model for Multi-Region

### 7.1 Data Transfer Costs

| Route | Cost per GB | Notes |
|-------|-------------|-------|
| **Same region** | $0 | Free |
| **Cross-region (US to US)** | $0.01 | us-east-1 → us-west-2 |
| **Cross-region (US to EU)** | $0.02 | us-east-1 → eu-west-1 |
| **Cross-region (US to Asia)** | $0.08 | us-east-1 → ap-south-1 |
| **Internet egress** | $0.09 | us-east-1 → internet |

**Example:** 100GB/day replicated from US to EU + Asia:
- US → EU: 100 GB × $0.02 = $2/day
- US → Asia: 100 GB × $0.08 = $8/day
- **Total: $10/day = $300/month**

### 7.2 Regional Pricing Differences

| Service | us-east-1 | eu-west-1 | ap-south-1 |
|---------|-----------|-----------|------------|
| **Lambda (per 1M requests)** | $0.20 | $0.22 | $0.25 |
| **DynamoDB (per WCU/month)** | $0.47 | $0.52 | $0.58 |
| **S3 Standard (per GB/month)** | $0.023 | $0.025 | $0.028 |
| **ECS Fargate (per vCPU-hour)** | $0.04048 | $0.04456 | $0.0506 |

**Cost optimization:**
- Run non-latency-sensitive workloads in `us-east-1` (cheapest)
- Use `eu-west-1` only for EU tenants (compliance + latency)
- Use `ap-south-1` for high-value Asia tenants

### 7.3 Total Multi-Region Cost Estimate

**Scenario:** 1000 tenants, 50% US, 30% EU, 20% Asia

| Category | Monthly Cost |
|----------|--------------|
| **Compute (ECS Fargate)** | $15,000 |
| **Data storage (DynamoDB + S3)** | $8,000 |
| **Data transfer (cross-region)** | $2,500 |
| **Bedrock inference** | $25,000 |
| **Networking (API Gateway, Route 53)** | $1,500 |
| **Total** | **$52,000/month** |

**Compared to single-region:** ~30% higher cost for multi-region, offset by better UX (lower latency) and compliance.

---

## 8. Monitoring Multi-Region Deployments

### 8.1 Cross-Region CloudWatch Dashboard

```typescript
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

const dashboard = new cloudwatch.Dashboard(this, 'MultiRegionDashboard', {
  dashboardName: 'chimera-multi-region',
  widgets: [
    [
      new cloudwatch.GraphWidget({
        title: 'Request Latency by Region',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiName: 'chimera-api-us-east-1' },
            statistic: 'p99',
            region: 'us-east-1',
            label: 'US East',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiName: 'chimera-api-eu-west-1' },
            statistic: 'p99',
            region: 'eu-west-1',
            label: 'EU West',
          }),
        ],
      }),
    ],
    [
      new cloudwatch.GraphWidget({
        title: 'Cross-Region Replication Lag (DynamoDB)',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ReplicationLatency',
            dimensionsMap: {
              TableName: 'chimera-tenants',
              ReceivingRegion: 'eu-west-1',
            },
            statistic: 'Average',
            region: 'us-east-1',
          }),
        ],
      }),
    ],
  ],
});
```

### 8.2 X-Ray Distributed Tracing

Track requests across regions:

```python
from aws_xray_sdk.core import xray_recorder

@xray_recorder.capture('invoke_agent')
def invoke_agent(tenant_id: str, prompt: str):
    # Trace starts in us-east-1
    xray_recorder.put_annotation('tenant_id', tenant_id)
    xray_recorder.put_annotation('region', os.environ['AWS_REGION'])

    # Cross-region DynamoDB call (traced automatically)
    tenant_config = dynamodb.get_item(
        TableName='chimera-tenants',
        Key={'PK': {'S': f'TENANT#{tenant_id}'}, 'SK': {'S': 'PROFILE'}}
    )

    # Bedrock inference (traced)
    response = bedrock.invoke_model(modelId='us.anthropic.claude-sonnet-4-20250514', ...)

    return response
```

**X-Ray trace map shows:**
- Request starts in `us-east-1` API Gateway
- Lambda in `us-east-1` calls DynamoDB Global Table
- DynamoDB read latency: 15ms (local)
- Bedrock cross-region inference: 45ms (routed to `eu-west-1`)

---

## 9. High Availability Patterns

### 9.1 Active-Active Multi-Region

All regions handle traffic simultaneously:

```
┌────────────────┐   ┌────────────────┐   ┌────────────────┐
│   us-east-1    │   │   eu-west-1    │   │   ap-south-1   │
│  (50% traffic) │   │  (30% traffic) │   │  (20% traffic) │
│                │   │                │   │                │
│  Healthy ✓     │   │  Healthy ✓     │   │  Healthy ✓     │
└────────────────┘   └────────────────┘   └────────────────┘
```

**Benefits:**
- No idle capacity (cost-efficient)
- Low latency for all users
- Gradual failover (Route 53 health checks)

**Drawbacks:**
- Complex data consistency (eventual consistency for Global Tables)
- Higher data transfer costs (cross-region replication)

### 9.2 Active-Passive Multi-Region

Primary region handles all traffic, secondary is standby:

```
┌────────────────┐                      ┌────────────────┐
│   us-east-1    │                      │   eu-west-1    │
│  (100% traffic)│                      │  (standby)     │
│                │                      │                │
│  Healthy ✓     │  ──────failure────►  │  Failover ⚠️    │
└────────────────┘                      └────────────────┘
```

**Benefits:**
- Simpler data consistency (no concurrent writes)
- Lower data transfer costs (one-way replication)

**Drawbacks:**
- Higher latency for non-US users
- Idle capacity in secondary region (wasted cost)
- Manual or semi-automated failover

---

## 10. Implementation Checklist

- [ ] Enable DynamoDB Global Tables for tenant/session data
- [ ] Configure S3 Cross-Region Replication for tenant files
- [ ] Deploy CDK stacks to all target regions
- [ ] Set up Route 53 geo-proximity routing
- [ ] Configure CloudFront with multi-origin failover
- [ ] Implement Bedrock cross-region inference profiles
- [ ] Create cross-region health checks and alarms
- [ ] Deploy X-Ray for distributed tracing
- [ ] Set up cross-region CloudWatch dashboard
- [ ] Configure IAM SCPs for data residency compliance
- [ ] Test failover scenarios (simulate regional outage)
- [ ] Document regional deployment procedures
- [ ] Create runbook for cross-region incident response

---

## 11. References

- [DynamoDB Global Tables](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GlobalTables.html)
- [S3 Cross-Region Replication](https://docs.aws.amazon.com/AmazonS3/latest/userguide/replication.html)
- [Route 53 Routing Policies](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html)
- [Aurora Global Database](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-global-database.html)
- [Bedrock Inference Profiles](https://docs.aws.amazon.com/bedrock/latest/userguide/inference-profiles.html)
- [AWS Multi-Region Architecture](https://aws.amazon.com/solutions/implementations/multi-region-application-architecture/)

**Related Chimera Documentation:**
- `infra/lib/data-stack.ts` — DynamoDB and S3 configuration
- `infra/lib/network-stack.ts` — VPC and routing setup
- `docs/research/architecture-reviews/Chimera-Definitive-Architecture.md` — Overall system design
