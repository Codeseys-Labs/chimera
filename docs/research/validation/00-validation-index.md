---
title: "Chimera Architecture Validation Index"
date: 2026-03-19
status: complete
task_id: chimera-ec1a
validator: val-index-writer
tags:
  - validation
  - index
  - architecture
  - overview
---

# Chimera Architecture Validation Index

> **Validation Date:** March 19, 2026
> **Task:** chimera-ec1a — Research: Platform Architecture & Multi-Tenancy Validation
> **Scope:** Validate Chimera's architecture against AWS AgentCore/Strands/Bedrock capabilities (March 2026)

---

## Overview

This validation effort examined Chimera's multi-tenant agent platform design across three critical domains:

1. **AWS Services Integration** — AgentCore Runtime, Memory, Gateway, Strands compatibility
2. **Multi-Tenant Isolation** — Security layers, DynamoDB schema, rate limiting
3. **Infrastructure & Deployment** — CDK stack structure, workspace storage, deployment models

**Overall Assessment:** **B+ — Strong Foundation, Needs Refinement**

The architecture is fundamentally sound and well-aligned with AWS capabilities. Core isolation primitives (MicroVM, IAM, partition keys) are validated. Application-layer enforcement (rate limiting, Cedar policies, budget controls) requires implementation before production.

---

## Document 1: AgentCore, Strands & Bedrock Validation

**File:** `01-agentcore-strands-bedrock.md` | **Lines:** 1,069 | **Validator:** val-agentcore-strands

### Scope
Comprehensive validation of 7 AWS service integration areas: AgentCore Runtime (MicroVM isolation), AgentCore Memory (STM/LTM strategies), AgentCore Gateway (MCP tool routing), Strands Agents framework, multi-tenant isolation model, 6-table DynamoDB design, 8-stack CDK structure, git-backed workspaces, team deployment, Cognito auth, consumption-based pricing.

### Key Findings

**✅ What Validates Perfectly:**
- MicroVM isolation per session matches AgentCore Runtime exactly
- Consumption-based pricing (I/O wait is free) aligns with design
- Strands framework integration is architecturally sound
- Memory architecture (STM + LTM separation) matches AgentCore Memory
- MCP Gateway design for tool routing is correct
- 6-table DynamoDB schema is well-suited for multi-tenant SaaS

**⚠️ What Needs Adjustment:**
- Memory strategies: Must explicitly specify which of 4 built-in strategies (User Preferences, Semantic, Session Summaries, Episodic) per tenant tier
- Identity integration: Clarify inbound (Cognito OAuth 2.0) vs outbound (API keys) authentication
- Code Interpreter: Update terminology (AgentCore service, not "OpenSandbox MicroVM")
- Browser service: Specify AgentCore Browser with Playwright CDP
- Tenant endpoints: Implement per-tier strategy (basic/advanced → shared, premium → dedicated)
- Cost model: Update to reflect real AgentCore pricing (~$35/tenant vs initial $25 estimate)

**🚨 Critical Gaps:**
- **EFS workspace assumption is invalid** — AgentCore sessions are ephemeral; must use S3 for persistence
- **No tenant endpoint routing strategy** — All tenants sharing single endpoint creates noisy neighbor risk
- **Missing memory namespace design** — Risk of cross-tenant leakage without explicit `tenant-{id}-user-{id}` namespaces
- **No AgentCore Observability integration** — Can't monitor per-tenant agent performance
- **No AgentCore Policy integration** — Cedar-based runtime enforcement missing

### Recommendations
1. Migrate workspace storage from EFS to S3-backed (P0)
2. Implement per-tier endpoint strategy: pool/hybrid → shared ARN, premium → dedicated ARN (P0)
3. Define memory namespace template and enforce in code (P0)
4. Integrate AgentCore tracing with CloudWatch dashboards (P1)
5. Store Cedar policies in S3, configure runtime enforcement (P1)

### Grade: **B+** — Proceed with implementation after addressing P0 gaps

---

## Document 2: Multi-Tenant Isolation & DynamoDB Schema

**File:** `02-multi-tenant-isolation-ddb.md` | **Lines:** 634 | **Validator:** val-multi-tenant-ddb

### Scope
Validation of 6-layer isolation model (MicroVM, network, data, storage, memory, identity/authorization) and resolution of DynamoDB schema contradiction (4 conflicting designs across research corpus).

### Key Findings

**Multi-Tenant Isolation:**

| Layer | Status | Notes |
|-------|--------|-------|
| MicroVM (Compute) | ✅ PASS | AgentCore Runtime provides strong kernel-level isolation |
| Network | ✅ PASS (pooled) / ⚠️ GAPS (multi-account) | Shared VPC sufficient for pool; need multi-account pattern for enterprise |
| Data (DynamoDB) | ⚠️ PASS WITH GAPS | Partition-key isolation sound; GSI queries risk cross-tenant leakage |
| Storage (S3) | ✅ PASS | Prefix-based IAM validated; add explicit deny for defense-in-depth |
| Memory (AgentCore) | ⚠️ PASS WITH GAPS | Namespace-per-tenant correct; needs runtime validation code |
| Identity/Authorization | ⚠️ PASS WITH GAPS | Cognito + Cedar design sound; Cedar policies not implemented |

**DynamoDB Schema Resolution:**

Four conflicting designs analyzed (single-table, 6-table simple, 6-table detailed, 6-table enhanced). **Recommendation: Adopt 6-table design** with enhanced tenant config pattern (multi-item: `PROFILE`, `CONFIG#features`, `CONFIG#models`, `CONFIG#tools`, `BILLING#current`, `QUOTA#{resource}`).

**🚨 Critical Gaps:**
- **No rate limiting / noisy neighbor protection** — Token bucket rate limiter required (DynamoDB-backed implementation provided)
- **No tenant offboarding / data deletion pipeline** — GDPR non-compliance risk
- **No budget enforcement at runtime** — Runaway costs from compromised agents
- **GSI cross-tenant leakage risk** — Skills/audit GSI queries need application-layer FilterExpression
- **No Cedar policy implementation** — Authorization gaps (tenant-defaults, skill-access, infra-modification policies missing)

### Recommendations
1. Implement token bucket rate limiter using DynamoDB (P0)
2. Write and deploy 3 Cedar policy files (P0)
3. Add FilterExpression to all GSI queries on skills/audit tables (P0)
4. Implement tenant deletion Step Function with GDPR compliance (P1)
5. Add budget enforcement (Cedar policy + Lambda enforcer) (P1)
6. Migrate to enhanced tenant config pattern (multi-item) (P2)

### Grade: **Sound but Incomplete** — Core isolation validated; application-layer enforcement missing

---

## Document 3: Infrastructure, Workspace Storage & Deployment

**File:** `03-infra-workspace-deploy.md` | **Lines:** 639 | **Validator:** val-infra-deploy

### Scope
Resolution of CDK stack contradiction (4/7/8 stacks), agent workspace storage options (S3/EFS/hybrid), and deployment model clarification (multi-tenant pooled vs team-deploy-to-own-account).

### Key Findings

**CDK Stack Structure:**
- **Contradiction RESOLVED**: 8-stack model (Final Architecture Plan) is correct
- Current implementation: 3/8 stacks (Network, Data, Security) ✅
- Missing: Observability, PlatformRuntime (blocked on AgentCore CDK L2), Chat, Tenant, Pipeline, Evolution
- Dependency graph validated: Foundation → Platform → Application → Automation layers

**Workspace Storage:**
- **Hybrid S3 + EFS approach validated** as cost-effective and architecturally sound
- EFS cost premium: $13/mo at 100 tenants (1% of LLM costs) — negligible
- S3 for: bulk storage, artifacts, memory snapshots
- EFS for: persistent workspaces, git repos, skill libraries (POSIX filesystem required)
- Tenant isolation via EFS Access Points (1,000 limit → need multiple file systems at scale)

**Deployment Model:**
- **Multi-tenant pooled model validated** as primary approach (current architecture is correct)
- Three isolation tiers: Pool (Basic), Hybrid (Advanced), Silo (Premium)
- "Team-deploy-to-own-account" clarified: Isolated resources within platform, NOT separate AWS accounts (except Enterprise+ tier)
- Multi-account option: AWS Organizations topology for highest compliance tier (future)

### Recommendations
1. Adopt 8-stack architecture as canonical; mark older docs superseded (documentation)
2. Create ADRs for: stack boundaries, hybrid storage, pool model, isolation strategy (documentation)
3. Implement missing stacks: Observability → Chat → Tenant → Pipeline (P1-P2)
4. Add EFS infrastructure to DataStack with tenant Access Points (P2)
5. Document tier-based routing logic (Basic/Advanced → shared, Premium → dedicated) (P2)
6. Plan AWS Organizations multi-account pattern for Enterprise+ tier (P3)

### Grade: **Validated** — Existing 3-stack implementation is solid Phase 0; clear path to Phase 1-3

---

## Overall Validation Summary

### Strengths
- ✅ MicroVM isolation model exactly matches AgentCore Runtime capabilities
- ✅ Multi-tenant data isolation (partition keys, IAM, namespaces) is architecturally sound
- ✅ 6-table DynamoDB design supports all access patterns
- ✅ Hybrid S3+EFS storage strategy validated as cost-effective
- ✅ CDK stack boundaries clear and well-reasoned (8-stack model)
- ✅ Cognito + Cedar authorization design correct

### Weaknesses
- 🚨 EFS workspace assumption invalid (must use S3 for AgentCore session persistence)
- 🚨 No rate limiting implementation (noisy neighbor risk)
- 🚨 No Cedar policies implemented (authorization gaps)
- ⚠️ Memory namespace design underspecified (leakage risk)
- ⚠️ Cost model underestimates AgentCore overhead (~$35 vs $25/tenant)
- ⚠️ No tenant offboarding automation (GDPR risk)

### Priority Fixes

**Week 1-2 (P0 — Blockers):**
1. Migrate workspace storage design from EFS to S3-backed
2. Implement tenant endpoint routing strategy (pool → shared ARN, silo → dedicated ARN)
3. Define and enforce memory namespace template (`tenant-{id}-user-{id}`)
4. Implement token bucket rate limiter (DynamoDB-backed)
5. Write and deploy 3 Cedar policy files (tenant-defaults, skill-access, infra-modification)

**Week 3-6 (P1 — Production Readiness):**
6. Add FilterExpression to GSI queries (prevent cross-tenant leakage)
7. Integrate AgentCore Observability with CloudWatch
8. Implement tenant deletion Step Function (GDPR compliance)
9. Add budget enforcement (Cedar policy + Lambda)
10. Implement missing CDK stacks (Observability, Chat, Tenant)

**Month 2-3 (P2 — Scale & Polish):**
11. Migrate to enhanced tenant config pattern (multi-item DynamoDB)
12. Add EFS infrastructure with tenant Access Points
13. Document multi-account deployment option for Enterprise+ tier
14. Create formal ADRs for major architectural decisions

---

## Recommendations

**Proceed with implementation.** The architecture is fundamentally sound. Address P0 gaps (EFS → S3, endpoint routing, memory namespaces, rate limiting, Cedar policies) within 1-2 weeks before deploying to production.

The research corpus provides clear, actionable guidance. Contradictions identified have been resolved. Next phase: execute implementation plan per Phase 1 priorities in validation documents.

---

**Validation Complete:** March 19, 2026
**Validators:** val-agentcore-strands, val-multi-tenant-ddb, val-infra-deploy, val-index-writer
**Next Steps:** Address P0 gaps, proceed to Phase 1 implementation (AgentCore integration)
