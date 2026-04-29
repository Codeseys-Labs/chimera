---
title: "Wave-32 deploy recovery — post-compaction session"
date: 2026-04-29
status: in-progress
scope: EventBridge Scheduler shipped in f5b3c975, deploy path rescued through 5 iterations
---

# Wave-32 deploy recovery

## Context
Wave-32 (EventBridge Scheduler) was committed pre-compaction in `f5b3c975`
but its first deploy through the `chimera-deploy-dev` pipeline uncovered
**four independent blockers** that had to be fixed sequentially, plus
proved out the multi-tenant isolation on the live deployment.

## Commit chain (this session)

| SHA | Stage | Why |
|-----|-------|-----|
| `106f5525` | seeds close marker | chimera-2b2a closed post-Wave-32 |
| `b92bffa0` | fix(orchestration) | Resolved 2 DependencyCycles: Network↔Orchestration via `albSg.addIngressRule` (L2→L1 CfnIngress) + Security↔Orchestration via `grantRead()` appending role ARN to platformKey policy (split to stack-local `ScheduleSigningKmsKey`). |
| `b9d53ca7` | fix(orchestration) | SG description: `->` → `to` (EC2 charset rejects `>`). |
| `25f7f3f9` | fix(orchestration) | ChimeraTable default `deletionProtection: true` caused orphan-loop on partial rollback. Added opt-in override; dev schedules table uses `isProd ? true : false`. |
| `92ebf43e` | fix(orchestration) | Same EC2 charset issue on SG *ingress rule* descriptions (2 of them). Renamed `->` to `to`. |

## Deploy attempts (failure taxonomy)

| # | execution | SHA | Failed stage | Root cause |
|---|-----------|-----|--------------|------------|
| 1 | c3fe9210 | 106f5525 | Build/Build_Package | DependencyCycle (SG ingress + KMS grantRead) |
| 2 | ad6f6236 | b92bffa0 | Deploy/Cdk_Deploy | SG description charset + orphan schedules table (from partial prior rollback attempt) |
| 3 | 5863fdeb | b92bffa0 retrigger | Build/Docker_Build | ECR immutable tag — short SHA already present from prior attempt |
| 4 | af8386e3 | b92bffa0 retrigger | Build/Docker_Build | Same, different repo (agent-runtime) |
| 5 | 47b1e39c | b92bffa0 retrigger | Deploy/Cdk_Deploy | SG description `->`, SchedulesTable deletion protection left orphan |
| 6 | 67069113 | 25f7f3f9 | Deploy/Cdk_Deploy | SG *ingress rule* descriptions also had `->` |
| 7 | 5e634c74 | 92ebf43e | (in progress at time of doc) | — |

## Multi-tenant isolation — validated live (pre-Wave-32)

Two-user manual test via Playwright:
- Logged in as tenant `test-tenant-wave21`: 21 sessions visible.
- Logged in as tenant `e2e-test-tenant`: 2 sessions visible. **Zero bleed.**
- Chat streaming as tenant B: agent replies correctly and persists under
  `PK=TENANT#e2e-test-tenant#SESSION#…`.

Programmatic probes (all ✅):
- JWT-claim authority (header/query/body `X-Tenant-Id` spoofs ignored)
- Session list is PK-scoped by tenantId
- Foreign session IDs return 404
- Parallel concurrent chats within same tenant work

Details: `docs/reviews/multi-tenant-isolation-live-probes-2026-04-28.md`.

## Memory isolation — audit findings

Subagent deep-dive at `docs/reviews/memory-isolation-audit-2026-04-29.md`.

| Layer | Strength | Risk |
|-------|----------|------|
| Session transcripts (DDB) | **Structural** (PK includes tenantId) | LOW |
| STM / LTM (AgentCore) | **Structural** (namespace + IAM) | LOW (LTM TS client is a stub — MED until implemented) |
| **Semantic skill search (Bedrock KB)** | **Application filter MISSING** | **CRITICAL** if enabled |
| Keyword skill search | Application filter (correct) | LOW |
| Session messages on foreign sessionId | PK structurally safe, but 200 empty (not 404) | INFO polish |
| Body-level `tenantId` | Silently ignored (JWT wins) | INFO polish |

**UTO (Unified Tenant Organization):** NOT implemented. No
`organizationId`/parent-tenant concept in schema, claims, Cedar, or
docs. Enabling it is a Wave-34+ initiative (~8–12 eng days).

## Backlog after this session

### Open (pre-existing)
- chimera-59ee — Webhooks Phase 2
- chimera-606c — DGM composite fitness Phase 2
- chimera-b7af — strands-agents 1.0 GA migration (blocked on release)
- chimera-8681 — ChimeraBench Phase 2

### New (discovered this session)
- **SEC-1 CRITICAL**: Wire tenant filter into `semanticSearch()` before
  shipping semantic search (file: `packages/core/src/skills/discovery.ts:113`)
- **CLI-1 MED**: `chimera logs --json` reports `executionStatus: Succeeded`
  when action list is all green but pipeline as a whole is `InProgress`
  (later stages unseen). Root cause: derives status from ListActionExecutions
  instead of GetPipelineExecution.
- **POLISH-1 LOW**: Body `tenantId` should 400 on mismatch instead of
  silent-ignore.
- **POLISH-2 LOW**: `/chat/sessions/:id/messages` should return 404 when
  the session doesn't exist in caller's tenant.
- **DESIGN-1**: Decide UTO direction — if shared cross-tenant context is
  a product goal, sketch design doc for Wave-34.
