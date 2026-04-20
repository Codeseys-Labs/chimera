# PR-Readiness Audit

**Audit date:** 2026-04-17
**Verdict:** **Ready to commit.** Zero blockers. 5 non-blocking follow-ups listed.

## Test snapshot

| Suite | Result |
|-------|--------|
| `packages/core/src/agent/__tests__/bedrock-model.test.ts` | ✅ 14/14 pass (includes messageStop flush + ThrottlingException retry) |
| `packages/cli/src/__tests__/lib/api-client.test.ts` | ✅ 27/27 pass (JWT expiry decode + guard) |
| `packages/agents/tests/test_tenant_context.py` | ✅ 11 tests — primitives + spoofing regression + anti-pattern guard |

## Broken-import risks: LOW

- `@chimera/shared` / `@chimera/core` — 40+ imports verified, no renamed-symbol breaks.
- `ChatRequest` retained as both interface and `z.infer` type — no caller broken.
- `tools.tenant_context` — exports are named, importable, used.
- Internal `_check_evolution_rate_limit(tenant_id: str)` / `_validate_evolution_policy(tenant_id: str, ...)` still take `tenant_id` positionally — correct. They're private helpers, called from within tools that have `tenant_id` in scope via `require_tenant_id()`. Not a leak.

## Dead code / unused exports: HEALTHY

- `tenant_context.py` exports are all consumed.
- `TenantContext` dataclass used by entrypoint.
- No orphaned helpers, no dangling `@deprecated`.

## Documentation drift: GOOD

- ADR-033 matches the actual implementation (ContextVar, not decorator; includes grep-based guard test — landed).
- ROADMAP.md reflects Phase 3a/3b completion.
- CLAUDE.md conventions enforced (bun vs `npx cdk`, GSI filter, no `innerHTML`, no `unsafeUnwrap`, `uv` + `pyproject.toml`).

## Commit hygiene: CLEAN

- ~28 modified tracked files + ~8 new (tests, ADR, reviews).
- `bun.lock` modification is expected (added zod).
- No build artifacts, no `node_modules`, no `cdk.out` staged.
- New files live in `tracked/` directories (ADR under `docs/architecture/decisions/`, reviews under `docs/reviews/`).

## Test-coverage matrix

| Feature | File | Test | Status |
|---------|------|------|--------|
| `set/get/require_tenant_id` | `tools/tenant_context.py` | `test_tenant_context.py:32-44` | ✅ |
| `ensure_tenant_filter` idempotency | `tools/tenant_context.py` | `test_tenant_context.py:76-81` | ✅ |
| Prefixed-field false-match regression | — | `test_tenant_context.py:116` | ✅ |
| Anti-pattern guard (boto3 w/o tenant_context) | `tools/` sweep | `test_tenant_context.py:140` | ✅ |
| `chimera_agent.py` finally cleanup | `chimera_agent.py:80` | code review + ADR-033 | ✅ (runtime-test gap noted) |
| Tool signature refactor (swarm / code_interp / evolution) | 3 files | tools call `require_tenant_id()` | ✅ |
| DDB tool filter injection | `dynamodb_tools.py` | implicit via `ensure_tenant_filter` coverage | ✅ |
| Bedrock retry on ThrottlingException | `bedrock-model.ts` | `bedrock-model.test.ts` (new) | ✅ |
| ConverseStream messageStop flush | `bedrock-model.ts` | `bedrock-model.test.ts` (new) | ✅ |
| JWT expiry check | `cli/lib/api-client.ts` | `api-client.test.ts` new tests | ✅ |
| Monorepo root detection | `cli/utils/project.ts` | `upgrade.test.ts` new tests | ✅ |
| 5MB skip + IaC classification | `cli/utils/codecommit.ts` | `codecommit.test.ts` (new) | ✅ |
| SSE heartbeat + abort + drain | `sse-bridge` / `chat.ts` | `sse-bridge`: 43/43 pass | ✅ |
| DAX SG narrowed + ALB logs | `data-stack.ts` / `chat-stack.ts` | CDK synth green | ✅ |
| WAF → CloudWatch Logs | `security-stack.ts` | CDK synth green | ✅ |
| PITR Config managed rule | `observability-stack.ts` | CDK synth green | ✅ |

## CLAUDE.md compliance: CLEAN

No violations surfaced for: bun vs `npx cdk`, GSI `FilterExpression` on tenantId, no `innerHTML`, no `unsafeUnwrap`, `uv` for Python, monorepo-aware `findProjectRoot()`, CLI 5MB batch + digest patterns.

## Open findings from prior review docs

**Closed this session:**
- P0-1, P0-2 (tenant boundary)
- Evolution-tools regression
- Entrypoint context cleanup
- P1-3 (ConverseStream race)
- P1-7 (Python version pins)
- P1-9, P1-10, P1-11 (CLI)

**Still open (P1, non-blocking):**
- KMS/log-group race full test (documented; no dedicated test yet)
- TS global `strict: true` + `any` quarantine (793 sites, multi-day effort)
- Audit TTL per tier (in-flight, wave 3 agent)
- JWT revocation path (multi-day)
- Prompt-injection delimiters (in-flight, wave 3 agent)

## Top blockers before merge

**None.** All P0 items closed; all changes are test-backed or code-review-verified.

## Non-blocking cleanups (follow-up PR)

| # | Item | Effort |
|---|------|--------|
| 1 | Harden `ensure_tenant_filter` idempotency with word-boundary regex + prefixed-field test | already landed (wave 3) |
| 2 | Clarify `_max_dict_depth` off-by-one semantics | ~15 min (wave 3) |
| 3 | Document `tenantId` casing convention in ADR-033 / CLAUDE.md | ~30 min |
| 4 | Integration tests per tool family (ContextVar through real tool call) | ~2h |
| 5 | TS `strict: true` + `any` quarantine | ~2 days (separate PR) |

## Overall

Session landed multi-tenant boundary enforcement at the Python layer, filled SSE robustness gaps, closed a ConverseStream race, hardened the CLI, narrowed a DAX blast radius, and wired WAF logging + PITR compliance. Test coverage is strong where the behavior changed. Documentation is aligned. Commit hygiene is clean.

**Recommendation: merge this session's changes.** Schedule the 5 non-blocking items into a follow-up PR within 1-2 weeks.
