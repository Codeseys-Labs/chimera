---
title: "Chimera Agent Architecture"
version: 1.0.0
status: canonical
last_updated: 2026-03-21
task: chimera-29c6
---

# Chimera Agent Architecture

**Purpose:** Definitive architecture for Chimera core agent — Strands-based, AgentCore-hosted, multi-tenant AI agent treating the AWS account as its execution environment.

**Design Principles:** (1) AWS-native not computer-native, (2) Multi-tenant from day one, (3) Model-driven execution via Strands, (4) Safe self-evolution within Cedar bounds, (5) OpenClaw-compatible SKILL.md format.

**Key Insight:** OpenClaw treats local computer as execution environment. Chimera treats the AWS account as execution environment.

---

## Section 1: Agent Execution Loop

### Full Execution Flow

User Message -> [1] API Gateway WebSocket/REST -> [2] Tenant Router Lambda (extract tenantId/userId/tier from Cognito JWT, load config from DynamoDB, resolve AgentCore endpoint pool/silo, check rate limits) -> [3] AgentCore Runtime MicroVM (session hydrated, JWT claims via context.auth.claims) -> [4] Chimera Agent Entrypoint (extract tenant context, load tier-gated tools + custom skills, configure memory namespace tenant-{id}-user-{id}, build system prompt, create Strands Agent) -> [5] Strands ReAct Loop (FM decides respond or call tools, Cedar policy check per call, max 20 iterations) -> [6] Response Streaming SSE/WebSocket -> [7] Post-Turn async (STM persist, LTM extract, cost track, audit log).

### Session Serialization

AgentCore Runtime guarantees concurrent invocations for same runtimeSessionId are serialized — replaces OpenClaw Lane Queue. Session ID: tenant-{tenantId}-user-{userId}-{uuid}. Context: Strands max_iterations(20), AgentCore STM window (Basic=10, Advanced=50, Premium=200), LTM SUMMARY compression.

---

## Section 2: AWS Account Tool System

### Fundamental Shift

OpenClaw exec -> AWS SDK calls. read/write/edit -> S3 operations. Docker sandbox -> MicroVM + Cedar. Node system -> AWS Organizations.

### Tool Tiers

Tier 1 (all tiers): EC2, Lambda, S3, DynamoDB, ECS. Tier 2 (advanced+): VPC, IAM, CloudFront, Route53, WAF. Tier 3 (advanced+): RDS, Redshift, Glue, Athena, OpenSearch. Tier 4 (premium): CodeCommit, CodePipeline, CodeBuild, Bedrock, SageMaker.

Tools are Strands @tool decorated functions wrapping boto3 SDK calls. Loading pipeline: base tools -> AWS tools (25, tier-gated) -> custom skills -> MCP tools -> Cedar filter -> schema cleanup -> budget guard.

### Permission Model

Tier gating -> Cedar policy eval -> IAM role (STS AssumeRole with ExternalId for confused deputy prevention). Tier roles: Basic=read-only T1, Advanced=read+write T1-3, Premium=full T1-4.

---

## Section 3: Skill Execution Runtime

### SKILL.md v2

OpenClaw-compatible fields plus: category (fixed taxonomy), permissions (Cedar), trust_level (0=system to 4=user-uploaded), sandbox_required, max_execution_seconds, cost_estimate.

Loading precedence: system -> tenant -> marketplace -> user-uploaded -> MCP external.

Registration: S3 upload -> 7-stage security pipeline (static analysis, dependency audit, policy compliance, sandbox test, resource limits, cost estimation, manual review) -> DynamoDB register -> Gateway target -> available.

Execution modes: Inline (@tool, trusted), Sandbox (Code Interpreter, untrusted), MCP (AgentCore Gateway), Lambda (compute-intensive).

---

## Section 4: Self-Evolution Engine

Six dimensions under Evolution Safety Harness: prompt optimization (A/B test, max 3/week), skill generation (pattern detection, min 3 occurrences), infra modification (allowed: scale/env/secrets vs dangerous: delete/modify-iam always human approval), model routing (Thompson sampling), subagent creation, memory evolution.

### Safety Harness (7 steps)

1. Rate limit check (10/day, 3 infra/day, 3 prompts/week)
2. Cedar policy evaluation
3. Cost impact (>$50/mo -> human approval)
4. Pre-change S3 snapshot
5. Execute change
6. Post-health check (drop >10 -> auto-rollback)
7. Audit event

---

## Section 5: UTO Access Control

User-Team-Org hierarchy. Identity: Cognito -> JWT (tenantId, tier, role) -> API Gateway -> Tenant Router -> AgentCore context.auth.claims. Cedar policies control per-user/team/org tool access. IAM: STS AssumeRole per tenant with ExternalId. Audit: chimera-audit with tenantId, action, cedarDecision, tool, cost. 90d TTL, CMK.

---

## Section 6: Memory Architecture

Three layers: STM (AgentCore sliding window, Basic=10/Advanced=50/Premium=200), LTM (3 strategies: SUMMARY all tiers, USER_PREFERENCE advanced+, SEMANTIC_MEMORY premium), Structured State (DynamoDB: sessions 24h TTL, tenants, cost-tracking 2yr, audit 90d CMK).

Namespace isolation: tenant-{tenantId}-user-{userId}, immutable per session. Integration via AgentCoreMemorySessionManager passed as session_manager to Strands Agent.

---

## Section 7: Concurrent Task Model

Foreground (interactive chat, sync ReAct, streaming) vs Background (EventBridge -> Step Functions -> Agent/Lambda). Background dispatch via start_background_task tool -> DDB record -> EventBridge. State machines: PipelineBuild, DataAnalysis, InfrastructureDeploy, SkillGeneration. Status via check_background_task. SQS FIFO per-tenant ordering. Notifications via WebSocket/Slack/email.

---

## Section 8: Self-Reflection Loop

Post-turn: tool success analysis, response quality, cost efficiency, signal routing (thumbs_down->PromptOptimizer, correction->Memory, tool failure->AutoSkillGenerator, cost overrun->ModelRouter). Monthly health score (0-100): quality 25%, completion 20%, cost 15%, corrections 15%, skill reuse 10%, memory hit 10%, rollback 5%. Error recovery: retry+fallback, model degradation, permission explain, budget read-only, self-heal.

---

## Appendix A: OpenClaw to Chimera Mapping

Gateway->API GW+Router+Runtime, Pi->Strands, Lane Queue->session serialization, exec->AWS SDK tools, SKILL.md->v2, ClawHub->chimera-skills+7-stage, Docker->MicroVM, MEMORY.md->LTM, SQLite->SEMANTIC_MEMORY, exec-approvals->Cedar, Nodes->Organizations, subagents->Strands multi-agent, skill-creator->AutoSkillGenerator.

## Appendix B: Key Decisions

1. Strands SDK (ADR-003), 2. AgentCore MicroVM (ADR-007), 3. AgentCore Memory (ADR-016), 4. S3 storage (ADR-010), 5. Cedar (ADR-002), 6. DynamoDB 6-table (ADR-001), 7. EventBridge (ADR-008), 8. SKILL.md v2 (ADR-018), 9. 7-stage pipeline (ADR-009), 10. Vercel AI SDK (ADR-004), 11. Self-modifying IaC (ADR-011), 12. Multi-provider LLM (ADR-017).

## Appendix C: Code References

Agent facade: packages/core/src/agent/agent.ts (scaffold). Evolution types+harness+auto-skill+prompt-optimizer+model-router+iac-modifier: packages/core/src/evolution/ (implemented). Memory types+namespace+client: packages/core/src/memory/ (implemented). Skills registry+validator+trust+mcp+installer: packages/core/src/skills/ (implemented). AWS tools: packages/core/src/aws-tools/ (implemented). Discovery: packages/core/src/discovery/ (implemented). CDK: infra/lib/ (11 stacks).

---
Author: lead-agent-design | Task: chimera-29c6 | Status: Canonical
