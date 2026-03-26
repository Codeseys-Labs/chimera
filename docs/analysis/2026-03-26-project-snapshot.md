# Chimera Project Snapshot — 2026-03-26

> **Comprehensive codebase & UX survey** synthesizing documentation review, codebase exploration, git cleanup, and CLI UX analysis from the 2026-03-26 research session.

---

## Executive Summary

Chimera is an **Agent-as-a-Service (AaaS) platform** giving AI agents first-class AWS account access. The codebase spans **~134,500 LOC** across **12 CDK stacks** and **6 application packages**. Heritage: AWS-native rebuild of OpenClaw (Anthropic) + NemoClaw (NVIDIA) + OpenFang (RightNow AI). Three-tier SaaS model:

| Tier | Target Price |
|------|-------------|
| Basic | ~$13/mo |
| Advanced | ~$35/mo |
| Premium | ~$97/mo |

---

## 1. Project Health Dashboard

### Codebase Metrics

| Metric | Value |
|--------|-------|
| Total LOC | ~134,500 |
| CDK Stacks | 12 (all production-quality) |
| Application Packages | 6 |
| ADRs | 23 |
| Research Documents | 123+ |
| Test Files | 79+ (44 core + 11 gateway + 4 CLI + 20 root) |
| Test Status | 860 passing / 82 failing / 20 errors |
| Git Status | Clean (committed dc59605) |

### Package Breakdown

| Package | Lines | Language | Status |
|---------|-------|----------|--------|
| `@chimera/core` | ~90,400 | TypeScript | ✅ 20+ modules, DI patterns |
| `@chimera/chat-gateway` | ~9,857 | TypeScript | ✅ Hono HTTP server, 5 platform adapters |
| `packages/agents` | ~7,017 | Python | ✅ Strands agent, ~90 AWS tools |
| `@chimera/cli` | ~3,601 | TypeScript | ⚠️ Infra commands real, runtime commands mocked |
| `@chimera/sse-bridge` | ~2,224 | TypeScript | ✅ Ship-ready, 26 tests |
| `@chimera/shared` | ~1,081 | TypeScript | ✅ Canonical DynamoDB types |
| `infra/` | ~15,364 | TypeScript (CDK) | ✅ 12 stacks, production-quality |

---

## 2. Infrastructure Status

### CDK Stacks (12)

| # | Stack | Purpose | Status |
|---|-------|---------|--------|
| 1 | **NetworkStack** | VPC (3-AZ, 3-tier), 7 VPC endpoints, 4 security groups | ✅ Complete |
| 2 | **DataStack** | 6 DynamoDB tables, 3 S3 buckets, DAX cluster, CMK | ✅ Complete |
| 3 | **SecurityStack** | Cognito, WAF WebACL, KMS | ✅ Complete |
| 4 | **ObservabilityStack** | 4 dashboards, 4 SNS topics, X-Ray, 10+ alarms | ✅ Complete |
| 5 | **ApiStack** | REST API + WebSocket API | ⚠️ Mock integrations (501) |
| 6 | **PipelineStack** | CodePipeline (5-stage), 2 ECR repos, 4 CodeBuild projects | ✅ Complete |
| 7 | **SkillPipelineStack** | 7-stage Step Functions, 8 Lambda functions | ✅ Complete |
| 8 | **ChatStack** | ECS Fargate, ALB, CloudFront, auto-scaling | ✅ Complete |
| 9 | **OrchestrationStack** | EventBridge, SQS, 3 Step Functions, 7 rules | ✅ Complete |
| 10 | **EvolutionStack** | 6 Lambdas, 4 Step Functions pipelines | ⚠️ Lambda stubs (4/6 TODO) |
| 11 | **TenantOnboardingStack** | Cedar policy store, 13 Lambdas, 2 SFN workflows | ✅ Complete |
| 12 | **EmailStack** | SES, S3, SQS, Lambda, EventBridge | ✅ Complete |

**Deployment status**: No stack has been deployed to any AWS environment yet.

---

## 3. Architecture Decisions Summary (23 ADRs)

### Core (ADR-001–005)

- **ADR-001**: 6-table DynamoDB — independent TTL/encryption/capacity per concern
- **ADR-002**: Cedar policy engine — AWS-native, formal verification, sub-ms eval
- **ADR-003**: Strands agent framework — AWS-native, 20MB footprint, MicroVM-optimized
- **ADR-004**: Vercel AI SDK + SSE Bridge — 23+ platform adapters, streaming-first
- **ADR-005**: AWS CDK — type-safe TypeScript, agent-friendly code generation

### Patterns (ADR-006–010)

- **ADR-006**: Monorepo with Bun workspaces
- **ADR-007**: AgentCore MicroVM isolation — <800ms cold start
- **ADR-008**: EventBridge as nervous system
- **ADR-009**: Universal Skill Adapter — SKILL.md v2
- **ADR-010**: S3 + EFS hybrid storage

### Operations (ADR-011–018)

- **ADR-011**: Self-modifying IaC via DynamoDB-driven CDK
- **ADR-012**: Well-Architected Framework as decision vocabulary
- **ADR-013**: CodeCommit + CodePipeline for IaC-as-capability
- **ADR-014**: Token bucket rate limiting
- **ADR-015**: Bun + Mise toolchain
- **ADR-016**: AgentCore Memory — STM + LTM
- **ADR-017**: Multi-provider LLM via LiteLLM
- **ADR-018**: SKILL.md v2 format

### Tech Choices (ADR-019–023)

- **ADR-019**: Hono over Express — 4x smaller, native streaming
- **ADR-020**: Two-stage Docker builds — 60% smaller images
- **ADR-021**: `npx` for CDK — Bun breaks CDK `instanceof` checks
- **ADR-022**: `skipLibCheck` for CDK synth — 5.6x faster
- **ADR-023**: Batched `CreateCommit` — 10x faster deploys

---

## 4. Data Model (6 DynamoDB Tables)

All tables use `TENANT#{id}` partition key.

| # | Table | Purpose | Mode | Notes |
|---|-------|---------|------|-------|
| 1 | `chimera-tenants` | Multi-item tenant config (PROFILE, CONFIG, BILLING, QUOTA) | Provisioned | — |
| 2 | `chimera-sessions` | Active agent sessions | On-demand | 24h TTL, DDB Streams |
| 3 | `chimera-skills` | Installed skills + MCP endpoints | On-demand | — |
| 4 | `chimera-rate-limits` | Token bucket state | On-demand | 5min TTL |
| 5 | `chimera-cost-tracking` | Monthly cost accumulation | Provisioned | 2yr TTL |
| 6 | `chimera-audit` | Security events | On-demand | CMK encryption, tier-based TTL (90d–7yr) |

---

## 5. Technology Stack

| Layer | Technology |
|-------|-----------|
| Package Manager | Bun (exclusively, except `npx cdk`) |
| TypeScript Runtime | Bun |
| Python Runtime | Python 3.12 + uv |
| HTTP Framework | Hono v4.7+ |
| Agent Framework | Strands Agents SDK |
| Agent Runtime | AWS Bedrock AgentCore (MicroVM) |
| Chat SDK | Vercel AI SDK |
| IaC | AWS CDK (TypeScript) |
| Policy Engine | AWS Cedar / Verified Permissions |
| Database | DynamoDB (6 tables) |
| Storage | S3 (primary) + EFS (POSIX) |
| LLM Gateway | LiteLLM (17+ providers) |
| CI/CD | CodeCommit + CodePipeline + CodeBuild + GitHub Actions |
| Event Bus | Amazon EventBridge |
| Auth | Cognito (JWT + PKCE) |
| Containers | ECS Fargate |
| Observability | CloudWatch + X-Ray + SNS |
| Dev Tools | Mulch, Seeds, Canopy, Overstory |

---

## 6. CLI & Developer Experience Assessment

### CLI Command Status

| Command | Status | Notes |
|---------|--------|-------|
| `chimera init` | ✅ Real | Interactive wizard, creates `chimera.toml` |
| `chimera deploy` | ✅ Real | Pushes to CodeCommit + bootstraps Pipeline |
| `chimera destroy` | ✅ Real | Tears down CF stacks, data export option |
| `chimera status` | ✅ Real | Colored table of stack health |
| `chimera connect` | ⚠️ Misleading | Fetches CF outputs, doesn't "connect" to agent |
| `chimera sync` | ⚠️ Dangerous | Overwrites local files without confirmation |
| `chimera upgrade` | ✅ Real | Merges GitHub upstream into CodeCommit |
| `chimera cleanup` | ✅ Real | Removes `ROLLBACK_COMPLETE` stacks |
| `chimera redeploy` | ✅ Real | Full CDK deploy bypassing pipeline |
| `chimera tenant *` | 🔴 Mock | Local-only config, no API calls |
| `chimera session *` | 🔴 Mock | Hardcoded data, `setTimeout` delays |
| `chimera skill *` | 🔴 Mock | Hardcoded data, `setTimeout` delays |

### UX Issues (Prioritized)

#### P0 — Fix Before Anyone Else Uses This

1. **Dual config systems**: `chimera.toml` vs `~/.chimera/config.json` used by different commands
2. **`chimera sync` overwrites without confirmation**: No diff, no prompt, silently clobbers local files
3. **Tier naming inconsistent**: `basic`/`advanced`/`enterprise` vs `basic`/`advanced`/`premium` vs `free` — 4+ vocabularies

#### P1 — Essential for Developer Experience

4. **Rename `chimera connect`** → `chimera endpoints` (or auto-run after deploy)
5. **`deploy` vs `sync` vs `upgrade` confusion**: All push to CodeCommit, unclear when to use which
6. **Add `chimera chat`**: Interactive terminal agent session (missing entirely)
7. **Add `chimera login`**: Cognito auth flow for CLI (gateway has it, CLI doesn't)
8. **Wire up unmounted routes**: Discord, Teams, Telegram adapters are complete but not registered in `server.ts`
9. **Fix port default**: `config.ts` says 3000, `server.ts` says 8080

#### P2 — Polish

10. **Mark mock commands**: `session`/`skill`/`tenant` show realistic-looking but fake output
11. **Add `--json` flag**: No command supports machine-parseable output
12. **Add `chimera doctor`**: Port Makefile health checks to CLI
13. **Extract shared `findProjectRoot()`**: Copy-pasted in 4 files
14. **Dynamic version**: Hardcoded `0.1.0` in 3 places

### Missing CLI Features

- `chimera chat` / `chimera agent` — interactive terminal chat
- `chimera login` / `chimera auth` — Cognito authentication
- `chimera logs` — CloudWatch log streaming
- `chimera config show` — dump effective configuration
- `chimera doctor` — pre-flight checks
- `chimera completions` — shell completions
- `--json` / `--dry-run` flags

---

## 7. Documentation vs Reality Assessment

### Previous Audit (2026-03-21) vs Today's Codebase Review

| Area | Docs Claim | 03-21 Audit | 03-26 Codebase Reality |
|------|-----------|-------------|------------------------|
| AWS Tools | 25 built | 4/25 (16%) | 20/25 TS + ~90 Python tools ✅ |
| Multi-Modal | ✅ Built | 0% | MediaProcessor exists ✅ |
| CDK Stacks | 11 stacks | Mostly complete | 12 stacks, all production-quality ✅ |
| Core SDK | ~48K LOC | Not assessed | ~90K LOC, 20+ modules ✅ |
| Evolution Lambdas | ✅ Built | Stubs | 2/6 implemented, 4/6 stubs ⚠️ |
| API Gateway | ✅ Built | Mock integ. | All REST endpoints return 501 ⚠️ |
| Frontend | Not mentioned | No code | No frontend code exists ❌ |

**Key insight**: The 03-21 audit was overly pessimistic. Actual implementation is **~75-80% complete**, not 55%.

### Known Discrepancies (from Vision Catalog)

1. **Tool count**: docs say 25, actual: 20 TS tools + ~90 Python tools
2. **Test count**: docs say 962, last run found variations
3. **LOC**: docs say ~48K core, actual: ~90K core
4. **Stack count**: docs say 11, actual: 12 (EmailStack added)
5. **Phase completion claims** overstate some areas

---

## 8. Security Assessment

### Implemented ✅

- Cognito user pool with MFA, 3 groups, 2 clients
- WAF WebACL with 3 rules
- KMS platform encryption key
- Cedar/Verified Permissions policy store
- DynamoDB partition key tenant isolation
- CMK encryption for audit table
- 7-stage skill security pipeline (infra)

### Gaps ⚠️

- Skill pipeline Lambda handlers are scaffolds (no real scanning logic)
- S3 buckets use S3-managed encryption (should use KMS)
- ECR images unsigned
- Bedrock invoke permission too broad
- No NACL rules
- Webhook routes unauthenticated

---

## 9. Multi-Tenancy Model

### Implemented

- **Pool model** (Basic/Advanced): Shared compute, namespace isolation
- **Silo model** (Premium): Dedicated endpoints
- DynamoDB `TENANT#{id}` partition key
- S3 prefix isolation `/tenants/{tenantId}/`
- Cognito tenant groups with `custom:tenant_id` JWT claim
- Cedar authorization policies
- Token bucket rate limiting per tenant
- Quota management by tier
- Step Functions onboarding + offboarding workflows

### Missing

- Team abstraction (only User/Org exist)
- Tier change workflow
- CLI-to-API connection for tenant management

---

## 10. Critical Path to First Deployment

1. Fix 82 failing tests (mostly missing dependencies)
2. Deploy NetworkStack + DataStack + SecurityStack
3. Deploy PipelineStack + ChatStack
4. Verify Cognito + ALB + ECS health
5. Connect CLI tenant commands to real API
6. First `chimera deploy` from clean `chimera init`

---

## 11. Session Artifacts

### Git Cleanup (commit dc59605)

- `.gitignore` updated: blocked 64MB CLI binary, 328KB conversation dump, Python/Bun/Turbo artifacts
- Committed: `VISION_CATALOG.md`, `SWARM_ANALYSIS.md`, well-architected deep-dive, session-40 directives, seed-data lockfile
- Working tree clean, 6 commits ahead of `origin/main`

### Vision Catalog Summary

169 claims audited across 11 categories from `VISION.md`, `ROADMAP.md`, `README.md`, `AGENTS.md`. 5 known discrepancies documented. Intended for gap-code verification.

### Session 40 Directives Summary

89 directives from the founding 97-hour session covering:

- Chimera vision
- 11-stack CDK architecture
- Bun/npx toolchain mandates
- Leads → Scouts → Builders orchestration
- Deployment via CLI → CodeCommit → CodePipeline
- UTO multi-tenant model
- Self-evolution requirements

7 unresolved questions remain.

---

*Generated 2026-03-26. Next review recommended after first deployment milestone.*
