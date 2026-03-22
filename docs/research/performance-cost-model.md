# Chimera Performance & Cost Model

> **Document Type:** Research & Cost Analysis
> **Version:** 1.0
> **Date:** 2026-03-22
> **Status:** Draft
> **Purpose:** Performance benchmarking plan and detailed cost estimation for Chimera deployment at scale

---

## Executive Summary

This document provides a comprehensive performance benchmarking strategy and cost estimation model for the Chimera multi-tenant agent platform. Based on actual CDK infrastructure configurations and AWS pricing (March 2026, us-east-1), it analyzes deployment costs at three scales: 10 tenants (startup), 100 tenants (growth), and 1,000 tenants (scale).

**Key Findings:**
- **Cost Drivers:** LLM tokens (60-75%), AgentCore Runtime (15-25%), DynamoDB (5-10%), ECS Fargate (3-5%)
- **Performance Target:** 1000 concurrent sessions with <10s p95 latency and 90%+ success rate
- **Optimization Impact:** Prompt caching + model routing saves 50-60% on LLM costs
- **Scale Economics:** Infrastructure costs per tenant decrease from $40/mo at 10 tenants to $11/mo at 1000 tenants

---

## Table of Contents

1. [Infrastructure Architecture](#infrastructure-architecture)
2. [Performance Benchmarking Strategy](#performance-benchmarking-strategy)
3. [Cost Model by Scale](#cost-model-by-scale)
4. [Deployment Cost Breakdown](#deployment-cost-breakdown)
5. [Performance Optimization Strategies](#performance-optimization-strategies)
6. [Cost Optimization Recommendations](#cost-optimization-recommendations)
7. [Load Testing Configuration](#load-testing-configuration)

---

## Infrastructure Architecture

### Deployed CDK Stacks

Chimera consists of 8 core CDK stacks (Phase 0 complete):

| Stack | Purpose | Key Resources |
|-------|---------|---------------|
| **NetworkStack** | VPC foundation | 3 AZ, 1-2 NAT, 7 VPC endpoints |
| **DataStack** | Persistent storage | 6 DynamoDB tables (PAY_PER_REQUEST), 3 S3 buckets |
| **SecurityStack** | Identity & WAF | Cognito user pool, WAF WebACL, KMS keys |
| **ApiStack** | API Gateway | REST API (JWT auth) + WebSocket API |
| **ChatStack** | ECS Fargate gateway | Express/Fastify, SSE streaming bridge |
| **ObservabilityStack** | CloudWatch logs/metrics/alarms | Log groups, dashboards, SNS |
| **PipelineStack** | CI/CD | CodePipeline, CodeBuild, canary deployment |
| **TenantOnboardingStack** | Tenant provisioning | Step Functions workflow |

### Infrastructure Sizing

**Production (envName: prod):**
```typescript
ECS Fargate:
- Task size: 1 vCPU, 2 GB RAM
- Desired count: 2 (HA across AZs)
- Auto-scaling: 2-10 tasks (CPU 70%, Memory 80%)

DynamoDB:
- Billing mode: PAY_PER_REQUEST (on-demand)
- 6 tables: tenants, sessions, skills, rate-limits, cost-tracking, audit
- Point-in-time recovery: enabled
- TTL: sessions (24h), rate-limits (5min)

API Gateway:
- REST API throttle: 10,000 req/sec, 5,000 burst
- WebSocket throttle: 1,000 req/sec, 500 burst

VPC:
- NAT Gateways: 2 (one per AZ for HA)
- Interface VPC endpoints: 7 (Bedrock, Secrets, ECR, Logs, Monitoring)
```

**Development (envName: dev):**
```typescript
ECS Fargate:
- Task size: 0.5 vCPU, 1 GB RAM
- Desired count: 1
- Auto-scaling: 1-3 tasks

VPC:
- NAT Gateways: 1 (cost savings)
```

---

## Performance Benchmarking Strategy

### Benchmark Objectives

| Objective | Metric | Target (Prod) | Notes |
|-----------|--------|---------------|-------|
| **Latency** | p50 response time | < 5s | Interactive chat sessions |
| | p95 response time | < 10s | Acceptable tail latency |
| | p99 response time | < 30s | Extreme outliers |
| **Throughput** | Concurrent sessions | 1,000+ | Scale target |
| | Requests per second | 10+ | Sustained load |
| **Reliability** | Success rate | > 90% | At 1000 concurrent sessions |
| | Error rate | < 5% | Under normal load |
| **Cold Start** | p50 first response | < 5s | AgentCore MicroVM boot |
| | p99 first response | < 10s | Worst-case cold start |

### Benchmark Scenarios

#### 1. Baseline Performance (Single Client)
- **Setup:** 1 client, 10 sequential requests
- **Purpose:** Establish baseline latency without contention
- **Expected:** p50 < 3s, p99 < 10s

#### 2. Concurrent Sessions (10 clients)
- **Setup:** 10 concurrent clients, 5 requests each
- **Purpose:** Test basic concurrency handling
- **Expected:** p95 < 15s, success rate > 95%

#### 3. Sustained Load (100 requests)
- **Setup:** 5 clients, 20 requests each
- **Purpose:** Measure throughput over time
- **Expected:** Requests/sec > 0.5, avg latency < 20s

#### 4. Burst Traffic (50 clients spike)
- **Setup:** 50 concurrent clients, 2 requests each
- **Purpose:** Test auto-scaling responsiveness
- **Expected:** p99 < 60s, success rate > 80%

#### 5. Extreme Scale (1000 sessions)
- **Setup:** Multiple patterns to reach 1000 total requests
  - 100 clients × 10 requests
  - 200 clients × 5 requests
  - 1000 clients × 1 request (maximum burst)
- **Purpose:** Validate 1000-session target
- **Expected:** p99 < 90s, success rate > 85%

#### 6. Tool Invocation Under Load
- **Setup:** 5-10 clients, skill-heavy queries (web-search, code-execution)
- **Purpose:** Measure performance with MCP tool calls
- **Expected:** p95 < 20s with tools

#### 7. Streaming Performance
- **Setup:** 10 concurrent streaming sessions (SSE/WebSocket)
- **Purpose:** Test time-to-first-token latency
- **Expected:** p95 first token < 5s

---

## Cost Model by Scale

### Assumptions

**Token Usage Per Session:**
- Input tokens: 3,000-4,000 (system prompt + user message)
- Output tokens: 1,200-2,000 (agent response)
- Model mix varies by scale (see below)

**Session Volume:**
- 10 tenants: 20 sessions/tenant/day × 22 days = 4,400 sessions/month
- 100 tenants: 15 sessions/tenant/day × 22 days = 33,000 sessions/month
- 1,000 tenants: 10 sessions/tenant/day × 30 days = 300,000 sessions/month

### 10 Tenants (Early Startup)

**Monthly Cost Estimate: $409**

| Cost Category | Calculation | Monthly |
|---------------|-------------|---------|
| **ECS Fargate** | 1 task × 0.5 vCPU × 730h × $0.04048 + 1 GB × 730h × $0.004445 | **$18** |
| **DynamoDB (On-Demand)** | 50K WCU × $1.25/M + 200K RCU × $0.25/M | **$113** |
| **S3 Storage + Requests** | 50 GB × $0.023 + requests | **$2** |
| **NAT Gateway** | 1 NAT × 730h × $0.045 + $0.045/GB data | **$35** |
| **VPC Endpoints** | 7 endpoints × 1 AZ × 730h × $0.01 | **$51** |
| **API Gateway REST** | 50K requests × $3.50/M | **$0.18** |
| **API Gateway WebSocket** | 4,400 conn-min × $1/M + 44K msg × $1/M | **$0.05** |
| **Cognito** | 10 MAU (free tier, 50K/mo) | **$0** |
| **CloudWatch Logs** | 5 GB × $0.50 | **$3** |
| **CloudWatch Metrics** | 50 custom × $0.30 | **$15** |
| **Secrets Manager** | 20 secrets × $0.40 | **$8** |
| **LLM Tokens (Sonnet 4.6)** | 4,400 × (4K×$3 + 2K×$15)/1M | **$185** |
| **TOTAL** | | **$409** |

**Cost per tenant per month: $41**

---

### 100 Tenants (Growth Phase)

**Monthly Cost Estimate: $1,844** (without model optimization)
**With optimization: $1,100-1,300**

| Cost Category | Calculation | Monthly |
|---------------|-------------|---------|
| **ECS Fargate** | 2 tasks × 1 vCPU × 730h × $0.04048 + 2 GB × 730h × $0.004445 | **$72** |
| **DynamoDB (Provisioned)** | Switch to provisioned: 200 WCU + 800 RCU base + auto-scaling | **$450** |
| **S3 Storage + Requests** | 500 GB × $0.023 + requests | **$17** |
| **NAT Gateway** | 2 NAT × 730h × $0.045 + data transfer | **$90** |
| **VPC Endpoints** | 7 endpoints × 2 AZ × 730h × $0.01 | **$102** |
| **API Gateway REST** | 500K requests × $3.50/M | **$1.75** |
| **API Gateway WebSocket** | 66K conn-min × $1/M + 330K msg × $1/M | **$0.40** |
| **Cognito** | 100 MAU × $0.0055 | **$0.55** |
| **CloudWatch Logs** | 50 GB × $0.50 | **$26** |
| **CloudWatch Metrics** | 500 custom × $0.30 | **$150** |
| **Secrets Manager** | 200 secrets × $0.40 | **$80** |
| **LLM Tokens (Mixed)** | Sonnet 70%, Haiku 20%, Opus 10% | **$1,016** |
| **TOTAL** | | **$1,844** |

**With prompt caching (-33% LLM cost):** $1,505
**With model routing (-50% LLM cost):** $1,336

**Cost per tenant per month: $13-18**

---

### 1,000 Tenants (Scale Phase)

**Monthly Cost Estimate: $11,463** (with aggressive optimization)

| Cost Category | Calculation | Monthly |
|---------------|-------------|---------|
| **ECS Fargate** | 4 tasks × 2 vCPU × 730h × $0.04048 + 4 GB × 730h × $0.004445 | **$288** |
| **DynamoDB (Provisioned + Reserved)** | 200 WCU + 800 RCU provisioned + auto-scaling + 1yr reserved | **$347** |
| **S3 Storage + Requests** | 5 TB × $0.023 + Intelligent-Tiering | **$165** |
| **NAT Gateway** | 2 NAT × 730h × $0.045 + high data transfer | **$200** |
| **VPC Endpoints** | 7 endpoints × 3 AZ × 730h × $0.01 | **$153** |
| **API Gateway REST** | 5M requests × $3.50/M | **$17.50** |
| **API Gateway WebSocket** | 600K conn-min × $1/M + 3M msg × $1/M | **$3.60** |
| **Cognito** | 1,000 MAU × $0.0055 | **$5.50** |
| **CloudWatch Logs** | 500 GB × $0.50 + EMF optimization | **$265** |
| **CloudWatch Metrics** | 5,000 custom × $0.30 (EMF reduces cardinality) | **$1,500** |
| **Secrets Manager** | 2,000 secrets × $0.40 | **$800** |
| **LLM Tokens (Optimized Mix)** | Haiku 50%, Sonnet 35%, Llama4 10%, Opus 5% + caching | **$6,195** |
| **AgentCore Runtime** | 300K sessions × 20s active × $0.0000249/vCPU-s | **$309** |
| **AgentCore Memory** | 3.45M STM events + 100K LTM records | **$1,060** |
| **AgentCore Gateway** | 1.5M tool calls × $0.005/1K | **$11** |
| **TOTAL** | | **$11,463** |

**Cost per tenant per month: $11.46**

---

## Deployment Cost Breakdown

### One-Time Setup Costs

| Item | Cost | Notes |
|------|------|-------|
| **Domain Registration** | $12/year | Route 53 hosted zone |
| **ACM Certificate** | Free | SSL/TLS for ALB, API Gateway |
| **Initial Data Seeding** | $50 | Global skills, marketplace setup |
| **TOTAL** | **~$62** | Amortized over first year |

### Monthly Fixed Costs (Production)

These costs are independent of tenant count:

| Component | Monthly Cost |
|-----------|--------------|
| NAT Gateway (2 AZ) | $66 (base) + data transfer |
| VPC Endpoints (7 × 2 AZ) | $102 |
| ECS Cluster (min 2 tasks) | $72 |
| CloudWatch Logs (base) | $10 |
| Secrets Manager (platform secrets) | $20 |
| **Fixed Subtotal** | **$270/month** |

### Variable Costs (Per Tenant)

| Component | Per Tenant/Month (at 100 tenants) |
|-----------|-----------------------------------|
| DynamoDB | $4.50 |
| S3 Storage | $0.17 |
| LLM Tokens | $10-15 (depends on usage) |
| AgentCore Runtime | $0.30 |
| AgentCore Memory | $1.20 |
| CloudWatch (proportional) | $1.50 |
| **Variable Subtotal** | **$17.67-22.67** |

**Total cost at 100 tenants:** $270 (fixed) + $1,970 (variable) = **$2,240/month**
**Cost per tenant:** $22.40

---

## Performance Optimization Strategies

### 1. AgentCore MicroVM Cold Start Optimization

**Problem:** 2-5 second cold start for new sessions
**Impact:** Degrades p50/p95 latency for first request

**Solutions:**

| Strategy | Implementation | Cost Impact | Latency Impact |
|----------|----------------|-------------|----------------|
| **Session Reuse** | Keep sessions warm for 15 min idle timeout | +$0.000577/session (Runtime) | -80% cold starts |
| **Predictive Warm-Up** | EventBridge pre-creates sessions before peak hours | +$5/mo (EventBridge) | -50% cold starts |
| **Connection Pooling** | Chat gateway maintains persistent AgentCore connections | Included | -30% cold starts |

**Recommended:** Session reuse + connection pooling (minimal cost, major impact)

---

### 2. ECS Auto-Scaling Tuning

**Current:** CPU 70%, Memory 80% targets
**Issue:** Scale-out takes 60-120s (new task boot time)

**Improvements:**

1. **Step Scaling Policies:**
   ```typescript
   // Scale out fast, scale in slow
   {
     metricAggregationType: 'Average',
     adjustmentType: 'PercentChangeInCapacity',
     scalingAdjustment: 100, // Double capacity
     cooldown: 60,
     metricInterval: { upperBound: 80 } // When CPU > 80%
   }
   ```

2. **Target Tracking on ALB Request Count:**
   ```typescript
   scaling.scaleOnRequestCount('RequestScaling', {
     targetRequestsPerTarget: 500,
     scaleInCooldown: Duration.seconds(180),
     scaleOutCooldown: Duration.seconds(30),
   });
   ```

3. **Pre-Warming for Load Tests:**
   - Manually scale to max capacity 10 minutes before load test
   - Prevents cold-start cascade during ramp-up

---

### 3. DynamoDB Query Optimization

**Hot Spots:**
- `chimera-sessions` table: high write volume during peak hours
- `chimera-skills` GSI queries: frequently accessed skills

**Optimizations:**

1. **Switch to Provisioned Capacity** at 100+ tenants:
   ```typescript
   billingMode: dynamodb.BillingMode.PROVISIONED,
   readCapacity: 800,
   writeCapacity: 200,
   ```
   Savings: 60-70% vs on-demand

2. **DAX Cache** for read-heavy tables (skills):
   - 2-node cluster: $0.30/hour × 730h × 2 = $438/month
   - Reduces DynamoDB RCU by 80%
   - Break-even at ~3,500 RCU/sec

3. **Sparse GSI Indexes:**
   - Only project attributes when GSI attribute is present
   - Reduces storage cost for sessions table (most items don't need GSI)

---

### 4. CloudWatch Cost Reduction

**Problem:** Custom metrics cost $0.30/metric/month
At 1,000 tenants with per-tenant metrics, costs explode to $3,000+/month

**Solution: Embedded Metric Format (EMF)**

Instead of:
```typescript
// Creates 1,000 separate metrics ($300/mo)
cloudwatch.putMetricData({
  MetricName: 'SessionLatency',
  Dimensions: [{ Name: 'TenantId', Value: tenantId }],
  Value: latency,
});
```

Use EMF:
```typescript
// Single metric with high-cardinality dimension (cost: $30/mo)
console.log(JSON.stringify({
  _aws: {
    Timestamp: Date.now(),
    CloudWatchMetrics: [{
      Namespace: 'Chimera',
      Metrics: [{ Name: 'SessionLatency', Unit: 'Milliseconds' }],
      Dimensions: [['TenantId']]
    }]
  },
  TenantId: tenantId,
  SessionLatency: latency
}));
```

**Savings:** $270/month → $30/month (90% reduction)

---

### 5. S3 Lifecycle Optimization

**Current:** All data in S3 Standard
**Issue:** Rarely accessed data costs $0.023/GB/month

**Lifecycle Rules:**

```typescript
{
  id: 'intelligent-tiering',
  transitions: [{
    storageClass: s3.StorageClass.INTELLIGENT_TIERING,
    transitionAfter: cdk.Duration.days(30), // Auto-detects access patterns
  }],
},
{
  id: 'glacier-archive',
  prefix: 'tenants/*/archive/', // Explicitly archived data
  transitions: [{
    storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
    transitionAfter: cdk.Duration.days(90),
  }],
},
{
  id: 'delete-old-versions',
  noncurrentVersionExpiration: cdk.Duration.days(90), // Clean up old versions
}
```

**Savings:** 30-50% on S3 storage costs (from $165/mo to $100/mo at 1,000 tenants)

---

## Cost Optimization Recommendations

### Priority 1: High Impact (>30% savings)

#### 1. Implement Prompt Caching

**Anthropic prompt caching** reduces cached input token costs by 90%:

```typescript
// Without caching: 3K system prompt × $3/M = $0.009/session
// With caching: 3K × $0.30/M = $0.0009/session
// Savings: $0.0081/session × 300K sessions = $2,430/month
```

**Implementation:**
```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const request = {
  modelId: 'us.anthropic.claude-sonnet-4-6-v1:0',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' }, // Cache this
        },
        {
          type: 'text',
          text: userMessage, // Not cached
        },
      ],
    },
  ],
};
```

**ROI:** Implementation time: 2 hours. Monthly savings: $2,400+ at 1,000 tenants.

---

#### 2. Model Routing Classifier

**Use Nova Micro** ($0.035/M input) to route requests:

```typescript
const classifier = await bedrock.invokeModel({
  modelId: 'us.amazon.nova-micro-v1:0',
  body: JSON.stringify({
    messages: [{ role: 'user', content: `Classify complexity: ${userMessage}` }],
    max_tokens: 50,
  }),
});

const complexity = parseComplexity(classifier.body); // 'simple' | 'standard' | 'complex'

const modelMap = {
  simple: 'us.anthropic.claude-haiku-4-5-v1:0',  // $0.009/session
  standard: 'us.anthropic.claude-sonnet-4-6-v1:0', // $0.042/session
  complex: 'us.anthropic.claude-opus-4-6-v1:0',   // $0.175/session
};
```

**Classifier cost:** 300K sessions × 100 tokens × $0.035/M = **$1.05/month**
**Savings:** 40-60% on LLM costs if 50%+ route to Haiku = **$3,000/month**

**ROI:** Implementation time: 8 hours. Monthly savings: $3,000 at 1,000 tenants.

---

#### 3. Switch DynamoDB to Provisioned

At 100+ tenants:

| Billing Mode | Monthly Cost (500K WCU, 2M RCU) |
|--------------|--------------------------------|
| On-Demand | $625 (WCU) + $500 (RCU) = $1,125 |
| Provisioned | $200 × 730h × $0.00065 (WCU) + 800 × 730h × $0.00013 (RCU) = $171 |
| **Savings** | **$954/month (85%)** |

**Auto-scaling config:**
```typescript
const readScaling = table.autoScaleReadCapacity({
  minCapacity: 800,
  maxCapacity: 5000,
});
readScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });

const writeScaling = table.autoScaleWriteCapacity({
  minCapacity: 200,
  maxCapacity: 2000,
});
writeScaling.scaleOnUtilization({ targetUtilizationPercent: 70 });
```

**ROI:** Implementation time: 4 hours. Monthly savings: $954 at 100 tenants.

---

### Priority 2: Medium Impact (10-30% savings)

#### 4. Self-Managed AgentCore Memory

**Built-in LTM:** $0.75/1K records/month
**Self-managed LTM:** $0.25/1K records/month (store in DynamoDB yourself)

**Savings:** 67% on LTM storage. At 100K records (1,000 tenants): $50/month saved.

#### 5. SSM Parameter Store for Non-Rotating Credentials

**Secrets Manager:** $0.40/secret/month
**SSM Parameter Store SecureString:** $0.05/10K API calls (no per-parameter charge)

**Candidate secrets:**
- API keys for read-only services (weather, news APIs)
- Non-critical tenant configuration

**Savings:** 100 secrets × $0.40 = **$40/month** (migrate only non-rotating secrets)

---

### Priority 3: Low Impact but Good Practice

#### 6. Fargate Savings Plans

**Compute Savings Plan:** 20% discount for 1-year no-upfront commitment

**At 1,000 tenants:** $288/month → $230/month = **$58/month saved**

#### 7. Reserved DynamoDB Capacity (1-year)

Once provisioned capacity is stable, commit to 1-year reserved:

**Savings:** Additional 77% off provisioned prices
**At 1,000 tenants:** $347/month → $150/month = **$197/month saved**

---

## Load Testing Configuration

### k6 Load Test Plan

#### Target Profile: 1000 Concurrent Sessions

| Phase | Duration | VUs (Virtual Users) | RPS (Requests/Sec) | Purpose |
|-------|----------|---------------------|-------------------|---------|
| Ramp-up | 10 min | 0 → 1000 | 0 → 20 | Gradual scale-up |
| Sustained | 30 min | 1000 | 20 | Steady-state load |
| Burst | 5 min | 1000 → 2000 | 20 → 40 | Peak traffic simulation |
| Cool-down | 5 min | 2000 → 0 | 40 → 0 | Graceful scale-down |

**Total duration:** 50 minutes
**Total requests:** ~72,000

#### Assertions

```javascript
export const options = {
  thresholds: {
    'http_req_duration': ['p(95)<10000', 'p(99)<30000'], // 95th < 10s, 99th < 30s
    'http_req_failed': ['rate<0.05'],                   // Error rate < 5%
    'http_reqs': ['rate>10'],                            // Throughput > 10 RPS
    'iteration_duration': ['avg<15000'],                // Avg iteration < 15s
  },
};
```

#### Load Test Execution

**Pre-flight Checklist:**
1. Scale ECS service to max capacity (10 tasks)
2. Pre-warm DynamoDB provisioned capacity
3. Create 100 test tenant accounts
4. Clear CloudWatch alarms (or acknowledge expected alarms)

**Run k6 test:**
```bash
k6 run tests/load/k6-load-test.js \
  --env API_URL=https://api.chimera-staging.example.com \
  --env WS_URL=wss://ws.chimera-staging.example.com \
  --env TENANT_ID=load-test-tenant \
  --env AUTH_TOKEN=$JWT_TOKEN \
  --out json=results.json
```

**Post-test Analysis:**
```bash
# Parse k6 JSON results
jq '.metrics.http_req_duration | {p95, p99, avg}' results.json

# CloudWatch Insights: ECS CPU/Memory during test
aws logs tail /chimera/staging/ecs/chat-gateway --since 1h --follow

# DynamoDB throttling events
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name UserErrors \
  --dimensions Name=TableName,Value=chimera-sessions-staging \
  --start-time $(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 \
  --statistics Sum
```

---

## Appendix A: AWS Pricing Reference (us-east-1, March 2026)

| Service | Unit | Price |
|---------|------|-------|
| **Compute** | | |
| ECS Fargate vCPU | per hour | $0.04048 |
| ECS Fargate Memory | GB per hour | $0.004445 |
| **Database** | | |
| DynamoDB On-Demand Write | 1M WCU | $1.25 |
| DynamoDB On-Demand Read | 1M RCU | $0.25 |
| DynamoDB Provisioned Write | WCU-hour | $0.00065 |
| DynamoDB Provisioned Read | RCU-hour | $0.00013 |
| **Storage** | | |
| S3 Standard | GB/month | $0.023 |
| S3 Intelligent-Tiering | GB/month | $0.023 (no retrieval fee) |
| S3 PUT/POST | per 1,000 | $0.005 |
| S3 GET | per 1,000 | $0.0004 |
| **Networking** | | |
| NAT Gateway | per hour | $0.045 |
| NAT Gateway Data | per GB processed | $0.045 |
| VPC Interface Endpoint | per hour per AZ | $0.01 |
| VPC Endpoint Data | per GB processed | $0.01 |
| **API Gateway** | | |
| REST API Requests | per million | $3.50 |
| WebSocket Connection Minutes | per million | $1.00 |
| WebSocket Messages | per million | $1.00 |
| **Security** | | |
| Secrets Manager | per secret/month | $0.40 |
| Cognito MAU | per user | $0.0055 |
| WAF WebACL | per month | $5.00 |
| WAF Rule | per month | $1.00 |
| **Observability** | | |
| CloudWatch Logs Ingestion | per GB | $0.50 |
| CloudWatch Logs Storage | GB/month | $0.03 |
| CloudWatch Custom Metrics | per metric/month | $0.30 |
| CloudWatch Alarms | per alarm/month | $0.10 |
| **LLM Models (Bedrock)** | | |
| Claude Sonnet 4.6 Input | 1M tokens | $3.00 |
| Claude Sonnet 4.6 Output | 1M tokens | $15.00 |
| Claude Sonnet 4.6 Cached Input | 1M tokens | $0.30 |
| Claude Haiku 4.5 Input | 1M tokens | $1.00 |
| Claude Haiku 4.5 Output | 1M tokens | $5.00 |
| Claude Opus 4.6 Input | 1M tokens | $5.00 |
| Claude Opus 4.6 Output | 1M tokens | $25.00 |
| Amazon Nova Micro Input | 1M tokens | $0.035 |
| Amazon Nova Micro Output | 1M tokens | $0.14 |
| **AgentCore** | | |
| Runtime CPU | vCPU-hour | $0.0895 |
| Runtime Memory | GB-hour | $0.00945 |
| Memory STM | 1K events | $0.25 |
| Memory LTM (built-in) | 1K records/month | $0.75 |
| Memory LTM (self-managed) | 1K records/month | $0.25 |
| Gateway Invocations | 1K calls | $0.005 |
| Policy Authorization | per request | $0.000025 |

---

## Appendix B: Test Tenant Configuration

**Load test tenants** (100 created for load testing):

```json
{
  "tenantId": "load-test-001",
  "tier": "premium",
  "config": {
    "maxConcurrentSessions": 50,
    "maxMonthlyBudgetUsd": 500,
    "enabledModels": ["sonnet-4.6", "haiku-4.5"],
    "skills": ["web-search", "code-execution", "document-analysis"],
    "rateLimits": {
      "requestsPerMinute": 100,
      "tokensPerDay": 1000000
    }
  }
}
```

**Monitoring during load test:**

```yaml
Alarms to monitor:
  - ECS CPU > 90% for 2 minutes
  - ECS Memory > 95% for 2 minutes
  - API Gateway 5XX errors > 1%
  - DynamoDB throttled requests > 0
  - ALB target unhealthy count > 0
  - AgentCore session creation failures > 5%

Dashboards to observe:
  - ECS service metrics (CPU, memory, task count)
  - DynamoDB table metrics (consumed capacity, throttles)
  - ALB metrics (request count, target response time, error rate)
  - Custom application metrics (session latency p50/p95/p99)
```

---

**Document Version:** 1.0
**Last Updated:** 2026-03-22
**Next Review:** After Phase 1 deployment (PlatformRuntimeStack + ObservabilityStack complete)
