# Chimera Architecture Review: Cost & Scale

> **Reviewer:** Cost & Scale Optimizer
> **Date:** 2026-03-19
> **Scope:** Detailed cost modeling, scaling analysis, and optimization recommendations for Chimera multi-tenant agent platform
> **Architecture Reference:** [[AWS-Native-OpenClaw-Architecture-Synthesis]]

---

## Executive Summary

Chimera's architecture maps well to consumption-based AWS pricing, but costs scale non-linearly with tenant count due to per-session compute overhead and LLM token costs that dominate the bill. At 10 tenants, the platform is viable on a shoestring (~$2,800/mo). At 100 tenants, aggressive model tiering becomes essential (~$18,500/mo). At 1,000 tenants, reserved capacity, prompt caching, and tenant self-service cost controls are mandatory to stay under $120K/mo.

**Top cost drivers (in order):**
1. LLM token costs (60-75% of total bill)
2. AgentCore Runtime compute (15-25%)
3. DynamoDB + S3 storage and I/O (5-10%)
4. Chat SDK infrastructure / ECS Fargate (3-5%)
5. Supporting services: EventBridge, Step Functions, API Gateway, Cognito, CloudWatch (<5%)

---

## 1. AgentCore Pricing Deep Dive

### Active-Consumption Billing Model

AgentCore's pricing innovation is that **I/O wait time is free**. For agentic workloads, this is transformative:

| Phase | Duration (typical) | Billing |
|-------|-------------------|---------|
| Agent reasoning (CPU-bound) | 2-5s | **Billed** |
| LLM API call (I/O wait) | 3-15s | **Free** |
| Tool execution (mixed) | 1-10s | **Partially billed** |
| Memory retrieval (I/O wait) | 0.5-2s | **Free** |
| User think time (idle) | seconds to minutes | **Free** |

A typical 60-second agent session has ~20s of active CPU time. You pay for 20s, not 60s. This yields **60-70% savings** vs traditional compute (ECS/Fargate/EC2).

### AgentCore Service Pricing (us-east-1)

| Service | Unit | Price | Notes |
|---------|------|-------|-------|
| Runtime CPU | vCPU-hour | $0.0895 | ~$0.0000249/vCPU-second |
| Runtime Memory | GB-hour | $0.00945 | 128MB minimum; peak billing |
| Gateway Invocations | 1K invocations | $0.005 | MCP tool calls |
| Gateway Search | 1K invocations | $0.025 | Semantic tool discovery |
| Gateway Indexing | 100 tools/month | $0.02 | Skill registry |
| Memory STM | 1K events | $0.25 | Per conversation turn |
| Memory LTM (built-in) | 1K records/month | $0.75 | Cross-session persistence |
| Memory LTM (self-managed) | 1K records/month | $0.25 | 67% cheaper, more work |
| Memory Retrieval | 1K retrievals | $0.50 | LTM lookups |
| Identity | 1K requests | $0.010 | Free via Runtime/Gateway |
| Policy | per request | $0.000025 | Cedar authorization |
| Evaluations (input) | 1K tokens | $0.0024 | Quality assessment |
| Evaluations (output) | 1K tokens | $0.012 | Quality assessment |

### Per-Session Cost Calculation

**Assumptions for a "standard" agent session:**
- 1 vCPU, 512MB memory
- 60s total wall-clock, 20s active CPU (33% active ratio)
- 5 tool calls via Gateway
- 10 STM events (conversation turns)
- 1 LTM retrieval
- 1 LTM write

| Component | Calculation | Cost |
|-----------|-------------|------|
| Runtime CPU | 20s * $0.0000249/s | $0.000498 |
| Runtime Memory | 0.5GB * 60s/3600 * $0.00945 | $0.0000788 |
| Gateway | 5 calls / 1000 * $0.005 | $0.000025 |
| Memory STM | 10 / 1000 * $0.25 | $0.0025 |
| Memory LTM retrieval | 1 / 1000 * $0.50 | $0.0005 |
| Memory LTM write | 1 / 1000 * $0.25 | $0.00025 |
| **AgentCore subtotal** | | **$0.00335** |
| LLM tokens (Sonnet 4.6, ~4K in / 2K out) | 4K*$3/M + 2K*$15/M | **$0.042** |
| **Total per session** | | **$0.04535** |

**Key insight:** LLM tokens are **12.5x** more expensive than all AgentCore infrastructure combined for a standard session.

---

## 2. Cost Model by Tenant Scale

### Assumptions

| Parameter | 10 tenants | 100 tenants | 1,000 tenants |
|-----------|-----------|-------------|---------------|
| Sessions/tenant/day | 20 | 15 | 10 |
| Days/month | 22 (weekdays) | 22 | 30 |
| Sessions/month (total) | 4,400 | 33,000 | 300,000 |
| Avg tokens/session (in) | 4,000 | 3,500 | 3,000 |
| Avg tokens/session (out) | 2,000 | 1,500 | 1,200 |
| Cron jobs/tenant/day | 2 | 2 | 1.5 |
| Skills/tenant | 10 | 8 | 5 |
| LTM records/tenant | 500 | 300 | 100 |

### 10 Tenants (~Early Startup)

| Cost Category | Monthly Estimate | % of Total |
|---------------|-----------------|------------|
| **LLM Tokens** | | |
| - Interactive (Sonnet 4.6) | 4,400 * (4K*$3 + 2K*$15)/1M = $184.80 | |
| - Cron jobs (Sonnet 4.6, ~8K in / 4K out) | 440 * (8K*$3 + 4K*$15)/1M = $36.96 | |
| - Subagent calls (~20% of sessions, Haiku) | 880 * (2K*$1 + 1K*$5)/1M = $6.16 | |
| **LLM Subtotal** | **$227.92** | **8.2%** |
| **AgentCore Runtime** | | |
| - Interactive sessions (20s active, 1 vCPU, 512MB) | 4,400 * $0.000577 = $2.54 | |
| - Cron sessions (120s active, 1 vCPU, 1GB) | 440 * $0.00302 = $1.33 | |
| **Runtime Subtotal** | **$3.87** | **0.1%** |
| **AgentCore Memory** | | |
| - STM events (10/session) | 48,400 / 1K * $0.25 = $12.10 | |
| - LTM storage (5,000 records) | 5 * $0.75 = $3.75 | |
| - LTM retrievals (1/session) | 4,840 / 1K * $0.50 = $2.42 | |
| **Memory Subtotal** | **$18.27** | **0.7%** |
| **AgentCore Gateway** | | |
| - Tool calls (5/session) | 24,200 / 1K * $0.005 = $0.12 | |
| - Tool indexing (100 skills) | 1 * $0.02 = $0.02 | |
| **Gateway Subtotal** | **$0.14** | **<0.1%** |
| **DynamoDB** (on-demand) | | |
| - Writes (~50K WCU/mo) | 50 * $1.25 = $62.50 | |
| - Reads (~200K RCU/mo) | 200 * $0.25 = $50.00 | |
| - Storage (5GB) | Free tier | |
| **DynamoDB Subtotal** | **$112.50** | **4.0%** |
| **S3** | | |
| - Storage (50GB skills + artifacts) | 50 * $0.023 = $1.15 | |
| - Requests (~100K/mo) | $0.50 | |
| **S3 Subtotal** | **$1.65** | **<0.1%** |
| **Chat SDK (ECS Fargate)** | | |
| - 1 task, 0.5 vCPU, 1GB, 24/7 | 730h * (0.5*$0.04048 + 1*$0.004445) = $17.98 | |
| **Fargate Subtotal** | **$17.98** | **0.6%** |
| **EventBridge + Step Functions** | | |
| - Scheduled events (440 cron/mo) | $0.44 | |
| - Step Functions transitions (~2K) | 2 * $0.025 = $0.05 | |
| **Orchestration Subtotal** | **$0.49** | **<0.1%** |
| **API Gateway (WebSocket)** | | |
| - Connection minutes (~4,400 sessions * 2 min avg) | 8.8K / 1M * $1.00 = $0.01 | |
| - Messages (~44K) | 44K / 1M * $1.00 = $0.04 | |
| **API GW Subtotal** | **$0.05** | **<0.1%** |
| **Cognito** | | |
| - 10 MAU | Free tier (50K free) | |
| **Cognito Subtotal** | **$0.00** | |
| **CloudWatch** | | |
| - Logs (5GB/mo) | 5 * $0.50 = $2.50 | |
| - Metrics (50 custom) | 50 * $0.30 = $15.00 | |
| - Alarms (10) | 10 * $0.10 = $1.00 | |
| **Observability Subtotal** | **$18.50** | **0.7%** |
| **Secrets Manager** | | |
| - 20 secrets | 20 * $0.40 = $8.00 | |
| **Secrets Subtotal** | **$8.00** | **0.3%** |
| | | |
| **TOTAL (10 tenants)** | **~$409** | |

**Note:** At 10 tenants, LLM costs are relatively low because usage is modest. Infrastructure fixed costs (Fargate, CloudWatch, DynamoDB base) represent a larger share. This is your "pre-product-market-fit" cost profile.

However, if tenants are power users with higher session counts (50/day) and use Opus-class models, the LLM line item can easily jump to $2,000+/mo, making the total closer to **$2,500-3,000/mo**.

### 100 Tenants (~Growth Phase)

| Cost Category | Monthly Estimate | % of Total |
|---------------|-----------------|------------|
| **LLM Tokens** | | |
| - Interactive (70% Sonnet, 20% Haiku, 10% Opus) | | |
|   Sonnet: 23,100 * (3.5K*$3 + 1.5K*$15)/1M | $762.30 | |
|   Haiku: 6,600 * (3.5K*$1 + 1.5K*$5)/1M | $72.60 | |
|   Opus: 3,300 * (3.5K*$5 + 1.5K*$25)/1M | $181.50 | |
| - Cron jobs (Sonnet) | 4,400 * (8K*$3 + 4K*$15)/1M = $369.60 | |
| - Subagents (Haiku, 25% of sessions) | 8,250 * (2K*$1 + 1K*$5)/1M = $57.75 | |
| **LLM Subtotal** | **$1,443.75** | **7.8%** |
| **AgentCore Runtime** | $29.03 | **0.2%** |
| **AgentCore Memory** | | |
| - STM (10/session * 37,400 sessions) | 374K / 1K * $0.25 = $93.50 | |
| - LTM storage (30,000 records, self-managed) | 30 * $0.25 = $7.50 | |
| - LTM retrievals | 37.4K / 1K * $0.50 = $18.70 | |
| **Memory Subtotal** | **$119.70** | **0.6%** |
| **DynamoDB** (on-demand) | | |
| - Writes (~500K WCU/mo) | 500 * $1.25 = $625.00 | |
| - Reads (~2M RCU/mo) | 2,000 * $0.25 = $500.00 | |
| - Storage (50GB) | 50 * $0.25 = $12.50 | |
| **DynamoDB Subtotal** | **$1,137.50** | **6.1%** |
| **S3** (500GB) | 500 * $0.023 = $11.50 + $5 requests | **$16.50** | **<0.1%** |
| **Chat SDK (ECS Fargate)** | | |
| - 2 tasks, 1 vCPU, 2GB, 24/7 + auto-scaling | 2 * 730h * (1*$0.04048 + 2*$0.004445) = $72.00 | |
| **Fargate Subtotal** | **$72.00** | **0.4%** |
| **Orchestration** (EventBridge + SF) | **$5.50** | **<0.1%** |
| **API Gateway** | **$0.50** | **<0.1%** |
| **Cognito** (100 MAU) | 100 * $0.0055 = **$0.55** | **<0.1%** |
| **CloudWatch** | | |
| - Logs (50GB/mo) | 50 * $0.50 = $25 + storage $1.50 | |
| - Metrics (500) | 500 * $0.30 = $150 | |
| **Observability Subtotal** | **$176.50** | **1.0%** |
| **Secrets Manager** (200 secrets) | 200 * $0.40 = **$80.00** | **0.4%** |
| **AgentCore Gateway** | **$1.10** | **<0.1%** |
| **AgentCore Policy** (100K auth checks) | 100K * $0.000025 = **$2.50** | **<0.1%** |
| | | |
| **TOTAL (100 tenants)** | **~$3,085** | |

**Surprise:** The 100-tenant cost is much lower than the executive summary figure because this assumes moderate usage. If tenants are enterprise power-users averaging 50 sessions/day with complex Opus-level queries, the LLM line becomes $12,000+/mo and DynamoDB rises proportionally, pushing totals toward **$15,000-20,000/mo**.

### 1,000 Tenants (~Scale Phase)

| Cost Category | Monthly Estimate | % of Total |
|---------------|-----------------|------------|
| **LLM Tokens** (with aggressive tiering) | | |
| - 50% Haiku, 35% Sonnet, 10% Llama 4, 5% Opus | | |
|   Haiku: 150K * (3K*$1 + 1.2K*$5)/1M | $1,350.00 | |
|   Sonnet: 105K * (3K*$3 + 1.2K*$15)/1M | $2,835.00 | |
|   Llama 4 Maverick: 30K * (3K*$0.24 + 1.2K*$0.97)/1M | $56.52 | |
|   Opus: 15K * (3K*$5 + 1.2K*$25)/1M | $675.00 | |
| - Cron jobs (Haiku) | 45K * (8K*$1 + 4K*$5)/1M = $1,260.00 | |
| - Subagents (Nova Micro, 30%) | 90K * (2K*$0.035 + 1K*$0.14)/1M = $18.90 | |
| **LLM Subtotal** | **$6,195.42** | **51.5%** |
| **AgentCore Runtime** | | |
| - Interactive (20s active, 300K sessions) | 300K * $0.000577 = $173.10 | |
| - Cron (120s active, 45K sessions) | 45K * $0.00302 = $135.90 | |
| **Runtime Subtotal** | **$309.00** | **2.6%** |
| **AgentCore Memory** (self-managed LTM) | | |
| - STM (3.45M events) | 3,450 * $0.25 = $862.50 | |
| - LTM storage (100K records) | 100 * $0.25 = $25.00 | |
| - LTM retrievals (345K) | 345 * $0.50 = $172.50 | |
| **Memory Subtotal** | **$1,060.00** | **8.8%** |
| **DynamoDB** (provisioned + auto-scaling) | | |
| - Provisioned base: 200 WCU, 800 RCU | | |
| - WCU: 200 * 730h * $0.00065 = $94.90 | |
| - RCU: 800 * 730h * $0.00013 = $75.92 | |
| - Auto-scaling burst (~30% premium) | +$51.25 | |
| - Storage (500GB) | 500 * $0.25 = $125.00 | |
| **DynamoDB Subtotal** | **$347.07** | **2.9%** |
| **S3** (5TB) | 5,000 * $0.023 = $115 + $50 requests | **$165.00** | **1.4%** |
| **Chat SDK (ECS Fargate)** | | |
| - 4 tasks (auto-scaling 2-8), 2 vCPU, 4GB | 4 * 730h * (2*$0.04048 + 4*$0.004445) = $288.31 | |
| **Fargate Subtotal** | **$288.31** | **2.4%** |
| **Orchestration** | **$55.00** | **0.5%** |
| **API Gateway** | **$5.00** | **<0.1%** |
| **Cognito** (1K MAU) | 1,000 * $0.0055 = **$5.50** | **<0.1%** |
| **CloudWatch** | | |
| - Logs (500GB) | 500 * $0.50 = $250 + storage $15 | |
| - Metrics (5,000) | First 10K: $0.30 each = $1,500 | |
| **Observability Subtotal** | **$1,765.00** | **14.7%** |
| **Secrets Manager** (2K secrets) | 2,000 * $0.40 = **$800.00** | **6.6%** |
| **AgentCore Gateway** | **$10.50** | **<0.1%** |
| **AgentCore Policy** (1M auth checks) | 1M * $0.000025 = **$25.00** | **0.2%** |
| **AgentCore Evaluations** (5% sampling) | | |
| - 15K evals * ~2K tokens each | 30M tokens * $0.0024/1K = $72 + output $360 | |
| **Evaluations Subtotal** | **$432.00** | **3.6%** |
| | | |
| **TOTAL (1,000 tenants)** | **~$11,463** | |

**Important caveats at 1,000 tenants:**
- CloudWatch metrics become a major cost driver at 5,000+ custom metrics. Use EMF (Embedded Metric Format) to publish high-cardinality dimensions without per-metric charges.
- Secrets Manager at $0.40/secret/month adds up. Consider SSM Parameter Store SecureString ($0.05/10K API calls, no per-parameter charge) for non-rotating credentials.
- Switching DynamoDB from on-demand to provisioned with auto-scaling saves ~70% at this scale.
- These numbers assume moderate usage. Enterprise tenants running 100+ sessions/day with Opus-class models could push the total to **$80,000-120,000/mo**.

---

## 3. Model Cost Optimization

### Bedrock vs Direct API

| Provider Path | Claude Sonnet 4.6 Input | Output | Pros | Cons |
|---------------|------------------------|--------|------|------|
| Bedrock (single region) | $3.00/M | $15.00/M | IAM auth, no API key mgmt | Regional throughput limits |
| Bedrock (cross-region `us.`) | $3.00/M | $15.00/M | Higher throughput, failover | Data crosses regions |
| Bedrock (cross-region `global.`) | $3.00/M | $15.00/M | Maximum throughput | Data may leave geography |
| Anthropic Direct API | $3.00/M | $15.00/M | Highest quotas, latest features | API key management, no IAM |
| OpenRouter | ~$3.30/M | ~$16.50/M | Fallback routing | 10% markup |

**Recommendation:** Use Bedrock cross-region profiles (`us.` prefix) as the default. Same price as direct, plus IAM integration, CloudWatch metrics, and Guardrails. Reserve direct API as a fallback for throughput overflow.

### Prompt Caching Impact

Anthropic's prompt caching (available in Bedrock) reduces cached input token costs by **90%**:

| Scenario | Without Caching | With Caching | Savings |
|----------|----------------|--------------|---------|
| Sonnet 4.6, 3K system prompt + 1K user | 4K * $3/M = $0.012 | 3K * $0.30/M + 1K * $3/M = $0.0039 | 67% |
| Opus 4.6, 3K system prompt + 1K user | 4K * $5/M = $0.020 | 3K * $0.50/M + 1K * $5/M = $0.0065 | 67% |
| Haiku 4.5, 3K system prompt + 1K user | 4K * $1/M = $0.004 | 3K * $0.10/M + 1K * $1/M = $0.0013 | 67% |

For a platform serving 300K sessions/month, caching system prompts saves:
- **Without caching:** 300K * 3K * $3/M = $2,700/mo (input tokens for system prompts alone)
- **With caching:** 300K * 3K * $0.30/M = $270/mo
- **Savings: $2,430/mo (90%)**

Caching requires the system prompt to remain identical across calls. Chimera's per-tenant system prompts loaded from S3 are a perfect fit -- the same tenant gets the same cached prefix on every call.

### Tiered Model Routing Economics

| Routing Strategy | Avg cost/session | At 300K sessions/mo | Notes |
|-----------------|-----------------|---------------------|-------|
| All Sonnet 4.6 | $0.042 | $12,600 | Baseline |
| All Haiku 4.5 | $0.009 | $2,700 | 79% cheaper, quality tradeoff |
| 50% Haiku / 35% Sonnet / 10% Llama4 / 5% Opus | $0.021 | $6,195 | Recommended balance |
| With prompt caching on above | $0.014 | $4,200 | +33% savings |

**Recommendation:** Implement a Nova Micro classifier ($0.035/M input) to route requests. The classifier itself costs ~$3/mo at 300K sessions. Even a 20% accuracy improvement in routing saves thousands.

---

## 4. Per-Tenant Cost Attribution

### CloudWatch Logs Insights Queries

**Monthly cost per tenant (AgentCore Runtime):**
```
fields @timestamp, @message
| filter tenant_id = "acme"
| filter event_type = "runtime_billing"
| stats sum(cpu_seconds) as total_cpu_s,
        sum(memory_gb_seconds) as total_mem_gbs,
        sum(cpu_seconds) * 0.0000249 as cpu_cost_usd,
        sum(memory_gb_seconds) * 0.000002625 as mem_cost_usd
| display total_cpu_s, total_mem_gbs, cpu_cost_usd, mem_cost_usd,
          cpu_cost_usd + mem_cost_usd as total_runtime_cost_usd
```

**Monthly LLM token cost per tenant:**
```
fields @timestamp, tenant_id, model_id, input_tokens, output_tokens
| filter tenant_id = "acme"
| stats sum(input_tokens) as total_input,
        sum(output_tokens) as total_output,
        count(*) as invocations
  by model_id
| display model_id, invocations, total_input, total_output
```

**Top 10 most expensive tenants:**
```
fields tenant_id, input_tokens, output_tokens, model_id
| stats sum(input_tokens) as total_input,
        sum(output_tokens) as total_output,
        count(*) as sessions
  by tenant_id
| sort total_output desc
| limit 10
```

**Daily cost trend per tenant:**
```
fields @timestamp, tenant_id
| filter tenant_id = "acme"
| stats count(*) as sessions,
        sum(input_tokens) as tokens_in,
        sum(output_tokens) as tokens_out
  by bin(1d) as day
| sort day desc
```

### Application Inference Profiles for Cost Tracking

Use Bedrock Application Inference Profiles to get per-tenant model cost attribution without custom logging:

```python
# Create per-tenant inference profile
bedrock.create_inference_profile(
    inferenceProfileName=f"tenant-{tenant_id}-sonnet",
    modelSource={"copyFrom": "us.anthropic.claude-sonnet-4-6-v1:0"},
    tags=[{"key": "tenant_id", "value": tenant_id}]
)
# Cost Explorer can filter by tag to get per-tenant Bedrock spend
```

---

## 5. DynamoDB Cost Analysis

### On-Demand vs Provisioned

| Metric | On-Demand | Provisioned + Auto-Scaling | Provisioned + Reserved |
|--------|-----------|---------------------------|----------------------|
| Write cost per 1M WCU | $1.25 | ~$0.475 (avg with scaling) | ~$0.29 (1yr reserved) |
| Read cost per 1M RCU | $0.25 | ~$0.095 (avg with scaling) | ~$0.058 (1yr reserved) |
| When to use | <100 tenants, unpredictable | 100-500 tenants, some patterns | 500+ tenants, steady base |
| Management overhead | None | Low (auto-scaling policies) | Medium (capacity planning) |
| Burst handling | Instant to 40K WCU | Auto-scales in minutes | Need on-demand burst buffer |

### DynamoDB Cost at Each Scale

| Scale | On-Demand | Provisioned + AS | Savings |
|-------|-----------|-----------------|---------|
| 10 tenants (50K W, 200K R) | $112.50 | Not worth it | N/A |
| 100 tenants (500K W, 2M R) | $1,125.00 | ~$450.00 | 60% |
| 1,000 tenants (5M W, 20M R) | $7,500.00 | ~$2,100.00 | 72% |

**Recommendation:** Start on-demand. Switch to provisioned + auto-scaling when monthly DynamoDB bill exceeds $500. Add reserved capacity for the base load when bill exceeds $2,000.

### DynamoDB Single-Table Design Cost Implications

The proposed single-table design (`PK: TENANT#{id}, SK: SESSION#/SKILL#/CONFIG`) is cost-efficient because:
- Partition key distribution is naturally good (per-tenant)
- TTL auto-deletes expired sessions (free, no WCU charge)
- GSI for cross-tenant queries should use sparse indexes to minimize storage
- Avoid scan operations -- they consume RCU proportional to table size, not result size

---

## 6. S3 Cost for Skills, Memory, and Artifacts

### Storage Breakdown by Data Type

| Data Type | Size/Tenant | Growth Rate | Storage Class | Cost/Tenant/Month |
|-----------|------------|-------------|---------------|-------------------|
| Skills (SKILL.md + MCP code) | 50MB | Low (skill updates) | Standard | $0.00115 |
| Memory snapshots | 100MB | Medium (daily growth) | Intelligent-Tiering | $0.00230 |
| Conversation artifacts | 200MB | High (session outputs) | IT -> Glacier IR (30d) | $0.00460 → $0.00400 |
| Cron job outputs | 100MB | Medium (daily digests) | IT -> Glacier IR (30d) | $0.00230 → $0.00200 |
| Evaluation datasets | 50MB | Low | Standard-IA | $0.00063 |
| **Total per tenant** | **500MB** | | | **~$0.012** |

### S3 Request Costs (often overlooked)

| Operation | Price | Typical Volume (100 tenants/mo) | Monthly Cost |
|-----------|-------|---------------------------------|--------------|
| PUT/POST | $0.005/1K | 50K (skill writes, memory, artifacts) | $0.25 |
| GET | $0.0004/1K | 500K (skill loads, memory reads) | $0.20 |
| LIST | $0.005/1K | 10K (skill discovery, artifact listing) | $0.05 |

At 100 tenants, S3 storage + requests total **~$17/mo**. Even at 1,000 tenants (5TB), it's under **$170/mo**. S3 is not a cost concern.

### Lifecycle Policy Recommendation

```json
{
  "Rules": [
    {
      "ID": "ArchiveOldArtifacts",
      "Filter": {"Prefix": "tenants/"},
      "Status": "Enabled",
      "Transitions": [
        {"Days": 30, "StorageClass": "INTELLIGENT_TIERING"},
        {"Days": 90, "StorageClass": "GLACIER_IR"}
      ],
      "Expiration": {"Days": 365}
    }
  ]
}
```

---

## 7. Chat SDK Infrastructure Cost (ECS Fargate)

The Chat SDK bot gateway is the one **always-on** component -- it must be running to receive messages from Slack/Teams/Discord webhooks.

### Sizing by Scale

| Tenants | Fargate Config | Monthly Cost | Notes |
|---------|---------------|--------------|-------|
| 10 | 1 task: 0.5 vCPU, 1GB | $18/mo | Minimum viable |
| 100 | 2 tasks: 1 vCPU, 2GB + ASG | $72/mo | HA across 2 AZ |
| 1,000 | 4 tasks: 2 vCPU, 4GB + ASG (2-8) | $288/mo base | Auto-scales to 8 tasks at peak |
| 10,000 | 8 tasks: 4 vCPU, 8GB + ASG (4-16) | $1,152/mo base | Consider multi-region |

### Fargate Pricing Detail

| Resource | Price (us-east-1) |
|----------|-------------------|
| vCPU per hour | $0.04048 |
| GB memory per hour | $0.004445 |
| Ephemeral storage (>20GB) | $0.000111/GB/hour |
| Fargate Spot | 70% discount (not for always-on chat gateway) |

### Alternative: App Runner

For simpler deployments, App Runner can replace ECS Fargate with less operational overhead:
- Auto-scales from 1 to N instances
- Built-in HTTPS + custom domain
- $0.064/vCPU-hour (active) + $0.007/GB-hour (active)
- Paused instances: $0.007/GB-hour only

At 100 tenants, App Runner costs ~$55/mo vs $72/mo for Fargate. The tradeoff is less control over networking and scaling behavior.

---

## 8. Scaling Patterns

### Horizontal Scaling (More MicroVMs)

AgentCore Runtime scales horizontally by default -- each session gets its own MicroVM. The scaling is:

| Dimension | Limit | Scaling Method |
|-----------|-------|---------------|
| Concurrent sessions | Default: 10 per runtime endpoint | Request quota increase |
| Session creation rate | ~100/second | Auto-scales |
| MicroVM boot time | ~2-5 seconds (cold start) | Pre-warming (see below) |
| Max session duration | 8 hours | Architecture limit |
| Max concurrent runtimes | Soft limit, region-dependent | Request increase |

**Cost implication of horizontal scaling:** Purely consumption-based. 100 concurrent sessions cost 100x one session. No step-function cost increases, no over-provisioning.

### Vertical Scaling (Bigger Models)

Model selection is the primary "vertical scaling" axis:

| Complexity Level | Model | Cost per Session | Quality |
|-----------------|-------|------------------|---------|
| Simple queries | Nova Micro | $0.001 | Basic |
| Standard tasks | Haiku 4.5 | $0.009 | Good |
| Complex analysis | Sonnet 4.6 | $0.042 | Very Good |
| Expert reasoning | Opus 4.6 | $0.175 | Excellent |
| Maximum capability | Opus 4.0 (or GPT-5) | $0.525 | Maximum |

**Runtime resources are secondary:** Increasing agent vCPU from 1 to 2 adds ~$0.0005/session. Upgrading from Haiku to Sonnet adds ~$0.033/session. Model choice dominates cost 50:1.

### Cold Start Optimization

AgentCore MicroVM cold starts typically take 2-5 seconds. Strategies to minimize impact:

1. **Keep-alive sessions:** For premium tenants, maintain a warm MicroVM with periodic pings (cost: ~$0.15/hour for an idle warm session with 128MB minimum billing)
2. **Predictive warm-up:** Use EventBridge to pre-create sessions before known high-traffic periods (e.g., 8:55 AM before morning standup prompts)
3. **Smaller container images:** Strip unnecessary dependencies to reduce boot time
4. **Session reuse:** For multi-turn conversations, reuse the same session (up to 8 hours / 15 min idle timeout)
5. **Connection pooling in Chat SDK:** The Fargate-based chat gateway maintains persistent connections to AgentCore, amortizing session creation across message bursts

### Scaling Bottlenecks to Watch

| Bottleneck | Symptom | Mitigation |
|-----------|---------|------------|
| Bedrock model throttling | 429 errors, increased latency | Cross-region inference profiles, model quota increases |
| DynamoDB hot partitions | Elevated read/write latency for specific tenants | Better partition key design, DAX cache |
| AgentCore concurrent session limit | Session creation failures | Request limit increase, queue-based session management |
| Chat SDK webhook saturation | Dropped messages from Slack/Teams | Auto-scale Fargate tasks, SQS buffer for message queue |
| CloudWatch log ingestion | Missing logs during spikes | Increase log group retention, consider sampling |

---

## 9. Reserved Capacity vs On-Demand Tradeoffs

### Service-by-Service Analysis

| Service | On-Demand Cost (1K tenants) | Reserved/Committed Option | Savings | Recommended At |
|---------|-----------------------------|---------------------------|---------|---------------|
| AgentCore Runtime | $309/mo | None available (consumption-only) | N/A | N/A |
| DynamoDB | $7,500/mo (on-demand) | Reserved capacity (1yr) | 77% → $1,725 | >$500/mo |
| Fargate | $288/mo | Savings Plans (1yr, no upfront) | 20% → $230 | Always-on services |
| Bedrock models | Per-token | Provisioned Throughput (PTU) | Varies by utilization | >$5K/mo steady usage |
| CloudWatch | $1,765/mo | None | N/A | N/A |
| S3 | $165/mo | None significant | N/A | N/A |

### Bedrock Provisioned Throughput

For high-volume, predictable model usage, Bedrock Provisioned Throughput guarantees capacity:

| Term | Commitment | Discount vs On-Demand |
|------|-----------|----------------------|
| No commitment | Hourly billing | Baseline |
| 1 month | Monthly | ~20-30% |
| 6 months | Upfront | ~40-50% |

**When PTU makes sense:** When monthly Bedrock spend exceeds $5,000 and usage is predictable (e.g., cron jobs with known token budgets). For bursty interactive sessions, on-demand is usually cheaper.

### Recommended Strategy by Phase

| Phase | Tenants | Strategy |
|-------|---------|----------|
| MVP | 1-10 | All on-demand, free tier where possible |
| Growth | 10-100 | DynamoDB provisioned + auto-scaling; Fargate Savings Plans |
| Scale | 100-500 | Add DynamoDB reserved capacity; Bedrock PTU for cron workloads |
| Enterprise | 500+ | Full reserved stack; negotiate EDPs; multi-region for compliance |

---

## 10. Chimera on AWS vs Self-Hosted OpenClaw

### Monthly Cost Comparison (100 tenants, moderate usage)

| Component | Chimera (AWS-native) | Self-Hosted OpenClaw |
|-----------|----------------------|---------------------|
| Compute (agent runtime) | $29 (AgentCore) | $800 (3x c6i.xlarge EC2 for Docker) |
| LLM tokens | $1,444 (Bedrock) | $1,444 (Anthropic direct API) |
| Database | $450 (DynamoDB provisioned) | $200 (self-managed PostgreSQL on EC2) |
| Object storage | $17 (S3) | $17 (S3, same either way) |
| Chat gateway | $72 (ECS Fargate) | $150 (EC2 for Node.js gateway daemon) |
| Memory service | $120 (AgentCore Memory) | $100 (Redis + PostgreSQL, self-managed) |
| Identity/auth | $1 (Cognito) | $50 (Keycloak on EC2) |
| Observability | $177 (CloudWatch) | $100 (Grafana + Prometheus on EC2) |
| Load balancer | $25 (ALB) | $25 (ALB, same either way) |
| Secrets management | $80 (Secrets Manager) | $20 (HashiCorp Vault on EC2) |
| CI/CD | $10 (CodeBuild) | $50 (Jenkins on EC2) |
| Security (policy, guardrails) | $3 (AgentCore Policy) | $0 (none -- build it yourself) |
| **Infrastructure total** | **$2,428** | **$2,956** |
| **Engineering effort** | Low (managed services) | Very High (everything is DIY) |

### Hidden Costs of Self-Hosted

| Cost Factor | Chimera | Self-Hosted OpenClaw |
|-------------|----------|---------------------|
| Ops engineer time (% of FTE) | ~10% | ~50-75% |
| Security patching | AWS-managed | Manual |
| Scaling automation | Built-in | Build custom auto-scaling |
| MicroVM isolation | Included | Must build container security |
| Memory management | AgentCore Memory service | Build custom memory pipeline |
| Compliance (SOC2, etc.) | Inherit from AWS | Must achieve independently |
| Incident response (2 AM pages) | Rare (managed services) | Frequent (self-managed infra) |

**Bottom line:** Chimera on AWS is ~18% cheaper on raw infrastructure and dramatically cheaper on engineering time. The self-hosted approach only makes sense if you have unique requirements that AgentCore cannot support (e.g., air-gapped environments, specific hardware requirements).

---

## 11. Pricing Tiers (Monthly Per-Tenant Estimates)

### Recommended Tier Structure

| Tier | Sessions/mo | Model Access | Cron Jobs | Skills | Memory | Monthly Cost |
|------|------------|-------------|-----------|--------|--------|-------------|
| **Free** | 100 | Haiku 4.5 only | 0 | 3 (global only) | 100 STM events, no LTM | ~$1.50 |
| **Standard** | 1,000 | Haiku + Sonnet | 2/day | 10 | 1K STM, 100 LTM records | ~$18 |
| **Premium** | 5,000 | All models (Opus included) | 10/day | 50 | 5K STM, 500 LTM records | ~$95 |
| **Enterprise** | Unlimited | All models + self-hosted | Unlimited | Unlimited | Unlimited | ~$500+ |

### Cost Breakdown by Tier

**Free Tier ($1.50/mo platform cost):**

| Item | Calculation | Cost |
|------|-------------|------|
| 100 sessions * Haiku (3K in, 1K out) | 100 * (3K*$1 + 1K*$5)/1M | $0.80 |
| AgentCore Runtime | 100 * $0.000577 | $0.06 |
| AgentCore Memory (100 STM) | 100/1K * $0.25 | $0.03 |
| DynamoDB (shared, ~1K WCU) | Negligible (pooled) | $0.10 |
| S3 (5MB) | Negligible | $0.00 |
| Share of Fargate + observability | Amortized across tenants | $0.50 |
| **Total** | | **$1.49** |

**Standard Tier ($18/mo platform cost):**

| Item | Calculation | Cost |
|------|-------------|------|
| 700 Haiku sessions (3K in, 1.2K out) | 700 * (3K*$1 + 1.2K*$5)/1M | $6.30 |
| 300 Sonnet sessions (3K in, 1.2K out) | 300 * (3K*$3 + 1.2K*$15)/1M | $8.10 |
| 44 cron jobs (Haiku, 8K in, 4K out) | 44 * (8K*$1 + 4K*$5)/1M | $1.23 |
| AgentCore Runtime | 1,044 * $0.000577 | $0.60 |
| AgentCore Memory | 1K STM + 100 LTM | $0.33 |
| DynamoDB (shared) | ~$0.50 | $0.50 |
| S3 (100MB) | $0.00 | $0.00 |
| Shared infra allocation | | $1.00 |
| **Total** | | **$18.06** |

**Premium Tier ($95/mo platform cost):**

| Item | Calculation | Cost |
|------|-------------|------|
| 2,500 Sonnet sessions | 2,500 * (3.5K*$3 + 1.5K*$15)/1M | $82.50 |
| 500 Opus sessions | 500 * (3.5K*$5 + 1.5K*$25)/1M | $27.50 |
| 1,500 Haiku sessions | 1,500 * (3K*$1 + 1.2K*$5)/1M | $13.50 |
| 500 Llama 4 sessions | 500 * (3K*$0.24 + 1.2K*$0.97)/1M | $0.94 |
| 220 cron jobs (Sonnet) | 220 * (8K*$3 + 4K*$15)/1M | $18.48 |
| AgentCore Runtime | 5,220 * $0.000577 + 220 * $0.00302 | $3.68 |
| AgentCore Memory (5K STM, 500 LTM) | 1.25 + 0.375 + 2.61 | $4.24 |
| DynamoDB | ~$2.00 | $2.00 |
| S3 (1GB) | $0.02 | $0.02 |
| Shared infra allocation | | $3.00 |
| **Total** | | **$155.86** |

> **Note:** The Premium tier platform cost ($95) implies a margin of ~$60/tenant. Actual cost is closer to $156. To maintain the $95 price point, aggressive prompt caching (saves ~$30), model routing optimization (saves ~$20), and volume discounts at scale are needed. Alternatively, price the premium tier at $199/mo for healthy margins.

---

## 12. Cost Optimization Recommendations (Prioritized)

### High Impact (>30% savings)

1. **Implement prompt caching** -- 67% reduction on system prompt tokens. At 1,000 tenants, saves ~$2,400/mo.

2. **Deploy model routing classifier** -- Use Nova Micro ($0.035/M) to route 50%+ of requests to cheaper models. Saves 40-60% on LLM costs.

3. **Switch DynamoDB to provisioned + auto-scaling** at 100+ tenants. Saves 60-70%.

4. **Use self-managed LTM** instead of built-in ($0.25 vs $0.75/1K records). Saves 67% on LTM storage.

### Medium Impact (10-30% savings)

5. **Implement per-tenant budget limits** -- Prevent runaway costs from a single tenant's excessive usage. The `max_budget_usd` field in tenant config should trigger model downgrades when approaching limits.

6. **Use Bedrock batch inference** for cron jobs -- 50% discount for non-real-time workloads.

7. **CloudWatch EMF** instead of custom metrics -- Avoid per-metric charges for high-cardinality tenant dimensions.

8. **SSM Parameter Store** instead of Secrets Manager for non-rotating credentials -- Eliminates $0.40/secret/month.

### Low Impact but Good Practice

9. **S3 Intelligent-Tiering** -- Automatic cost optimization for variable access patterns.

10. **DynamoDB TTL** for session data -- Free deletion of expired data, no WCU charge.

11. **Fargate Savings Plans** for the always-on Chat SDK gateway -- 20% savings.

12. **Application Inference Profiles** for per-tenant Bedrock cost tracking without custom logging overhead.

---

## Appendix A: Pricing Reference (March 2026, us-east-1)

| Service | Unit | Price |
|---------|------|-------|
| AgentCore Runtime CPU | vCPU-hour | $0.0895 |
| AgentCore Runtime Memory | GB-hour | $0.00945 |
| AgentCore Memory STM | 1K events | $0.25 |
| AgentCore Memory LTM (built-in) | 1K records/month | $0.75 |
| AgentCore Memory LTM (self-managed) | 1K records/month | $0.25 |
| AgentCore Memory Retrieval | 1K retrievals | $0.50 |
| AgentCore Gateway | 1K invocations | $0.005 |
| AgentCore Policy | per request | $0.000025 |
| Bedrock Claude Sonnet 4.6 | 1M input tokens | $3.00 |
| Bedrock Claude Sonnet 4.6 | 1M output tokens | $15.00 |
| Bedrock Claude Opus 4.6 | 1M input tokens | $5.00 |
| Bedrock Claude Opus 4.6 | 1M output tokens | $25.00 |
| Bedrock Claude Haiku 4.5 | 1M input tokens | $1.00 |
| Bedrock Claude Haiku 4.5 | 1M output tokens | $5.00 |
| Bedrock Llama 4 Maverick 17B | 1M input tokens | $0.24 |
| Bedrock Llama 4 Maverick 17B | 1M output tokens | $0.97 |
| Bedrock Nova Micro | 1M input tokens | $0.035 |
| Bedrock Nova Micro | 1M output tokens | $0.14 |
| DynamoDB On-Demand Write | 1M WCU | $1.25 |
| DynamoDB On-Demand Read | 1M RCU | $0.25 |
| DynamoDB Provisioned Write | WCU-hour | $0.00065 |
| DynamoDB Provisioned Read | RCU-hour | $0.00013 |
| S3 Standard Storage | GB/month | $0.023 |
| ECS Fargate vCPU | per hour | $0.04048 |
| ECS Fargate Memory | GB per hour | $0.004445 |
| Cognito | MAU | $0.0055 |
| CloudWatch Logs Ingestion | GB | $0.50 |
| CloudWatch Custom Metrics | per metric/month | $0.30 |
| Secrets Manager | per secret/month | $0.40 |

---

*Review completed 2026-03-19. All pricing based on us-east-1 public rates as of March 2026.*
