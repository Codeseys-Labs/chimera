# Fresh Gaps Hunt — Post-Phase-1

**Review date:** 2026-04-17
**Method:** code search + cross-reference with existing `docs/reviews/*.md`; only NEW-angle findings.

## Top 10 overlooked gaps

| # | Finding | Severity |
|---|---------|----------|
| 1 | No prompt-injection isolation for untrusted inputs in `system_prompt.py` | MEDIUM/SECURITY |
| 2 | Bedrock model routing lacks explicit cost-per-tenant tier ceiling | HIGH/COST |
| 3 | No per-session cost metric or per-tenant tool success/failure metric | MEDIUM/OPS |
| 4 | Docker base images use unversioned tags (no SHA256 digest) | MEDIUM/SUPPLY-CHAIN |
| 5 | No canary-deployment failure runbook | HIGH/OPS |
| 6 | Audit-table TTL not enforced per tenant tier | MEDIUM/COMPLIANCE |
| 7 | Agent-loop iteration count unbounded; no infinite-loop alarm | HIGH/OPS |
| 8 | Web UI: no root error boundary; inconsistent empty states | MEDIUM/UX |
| 9 | Dead code + stale TODOs (>6mo) in core orchestration | LOW |
| 10 | No Dependabot / Renovate; `bun.lock` lacks SRI hashes | LOW/SUPPLY-CHAIN |

## Cost hotspots at scale

- **NAT Gateway per AZ** (`infra/lib/network-stack.ts:38`) — 3 NAT GWs in prod = ~$32/mo fixed plus data processing.
- **CloudWatch log retention drift** — `chat-stack.ts` uses 6 months prod, `evolution-stack.ts` uses 1 month. No S3 archive lifecycle.
- **DAX cluster** (`data-stack.ts:237-246`) — 3 × `r5.large` nodes ≈ $2,880/mo with no cache-hit-rate monitoring.
- **S3 without intelligent-tiering** on tenant data / skills / artifacts buckets.
- **DDB on-demand vs provisioned** — low-traffic tables (rate-limits with 5m TTL) probably cheaper on `PAY_PER_REQUEST`.
- **Model router defaults** — `packages/core/src/evolution/model-router.ts:36-38` allows Opus for Basic tier if config missing. A Basic tenant running 100 sessions × 100k tokens ≈ $450/mo on Opus vs $90 on Sonnet.

## DR readiness

- **No PITR restore runbook.** Tables have PITR enabled, no written procedure. RTO/RPO undefined.
- **No cross-region replication** on DDB (Global Tables v2 is referenced in comments but not wired) or on S3 buckets (no CRR).
- **Lambda DLQ visibility gap** — `PostConfirmationTrigger` Cognito trigger is sync; DLQ exists but unused by sync invokes. Silent sign-up failures.
- **API Gateway cache-key safeguard** — cache can be configured without `tenantId` as a key, risking cross-tenant cache poisoning.

## Supply chain

- **`bun.lock` has no SRI hashes.** Mitigated by `--frozen-lockfile` but drift or registry compromise not caught.
- **No Dependabot/Renovate.** AWS SDK packages are pinned at `^3.1016.0` — 10+ releases behind April 2026 latest.
- **Docker base images** — `python:3.11-slim` and `debian:bookworm-slim` pulled by tag in both Dockerfiles, no digest pin.
- **SKILL.md signature verification** — TODO in `packages/core/src/skills/scanners/index.ts` for GPG/Sigstore check; currently unsigned skills are accepted.

## Prompt-injection defenses

- **No delimiter between system prompt and user content** — `chimera_agent.py:213-229` concatenates `CHIMERA_SYSTEM_PROMPT`, SOUL/AGENTS.md content, and runtime values without a bounding marker. An attacker-controlled piece of that bundle could masquerade as instruction.
- **Tool-result fallthrough** — `gateway_proxy.py:88` returns `f"Error from gateway tool {name}: {result.get('error', result)}"` without structural escaping; a malicious Lambda could inject instruction tokens via its error field.
- **Payload size/depth guards** — now partially addressed in Phase 3 (`_max_dict_depth`, 5.5 MB cap) but there's still no per-field length cap.

## Observability gaps

- **No per-tenant cost-per-session metric.** Monthly costs are surfaced in `pages/dashboard.tsx:39-42`, but there's no <5min-lag per-session metric.
- **No per-tenant tool success rate.** Type defined in `packages/core/src/evolution/types.ts:460` as `toolSuccessRate` but never emitted.
- **No agent-loop iteration count alarm.** `wait_for_swarm` / `wait_for_evolution_deployment` have 900s caps but no per-tenant alarm when loops chain.
- **No Bedrock throttle-rate alarm** — throttling shows up in logs but there's no explicit alarm for sustained >5% throttle.

## Test coverage blind spots

- **CI excludes `packages/chat-gateway`** tests because of a Bun CJS/ESM issue with `@aws-sdk/lib-dynamodb`. Auth middleware untested in CI.
- **Python tests run with `|| echo`** in CI — failures are swallowed.
- **No E2E for agent-loop timeout** / for the new `max_consecutive_errors` paths added this session.
- **No coverage artifact** published; % unknown.

## Accessibility / UX

- **No root React error boundary.** A runtime error in a chart component crashes the whole dashboard.
- **Inconsistent empty states** on `/admin` and `/settings` (no equivalent of the dashboard's "No sessions yet" pattern).
- **Focus management** on route change — no autofocus on main content after nav click.
- **Icon-only buttons** missing `aria-label` in several places.

## Dead code

- `packages/web/src/lib/sse-client.ts` is `@deprecated` but still imported by its own test.
- `packages/cli/src/commands/connect.ts` marked deprecated.
- `packages/core/src/runtime/agentcore-runtime.ts` has 15+ TODOs still open.
- `packages/core/src/swarm/task-decomposer.ts:72-95` and `packages/core/src/orchestration/workflow.ts:280-290` have stub comments.
- `packages/core/src/tools/skill-registry.ts:150-155` — in-memory only, persistence TODO.

## Self-evolution safety

- **Kill switch fails open** (`evolution_tools.py:532-548`). If SSM param is missing, evolution runs. Should fail closed.
- **Rate limit** works (5/day) but isn't tier-differentiated.
- **Cedar policy validation is optional** — skipped if `CEDAR_POLICY_STORE_ID` env var is unset. Acceptable in dev, not in prod.
- **No HITL gate** on CDK commits. Agent-generated code → CodeCommit → pipeline → prod with no human review.
- **No automatic rollback** on pipeline failure.

## CI/CD gaps

- `chat-gateway` tests excluded (Bun CJS/ESM).
- Python tests don't fail the job.
- CDK infra tests in `infra/test/` not run in CI.
- No staging environment between dev and prod.
- No canary for frontend rollout (100% traffic at once).
- No post-deploy validation Lambda.

## Prioritized punch list

| Item | Severity | Effort |
|------|----------|--------|
| Prompt delimiter + tool-result escaping | CRITICAL | 0.5d |
| DDB PITR restore runbook + quarterly drill | CRITICAL | 1d |
| Don't swallow Python test failures in CI | HIGH | 1d |
| Per-tenant/per-tier tool-success + cost-per-session metrics | HIGH | 2d |
| Pin Docker base images by SHA256 digest | HIGH | 0.5d |
| Enforce per-tier model ceiling at invoke time | HIGH | 1.5d |
| React root error boundary + consistent empty states | MEDIUM | 1d |
| Tier-enforced audit TTL | MEDIUM | 1d |
| Remove or implement AgentCore Runtime stubs | MEDIUM | 2d |
| Dependabot + patch auto-merge | LOW | 0.5d |
| Sigstore-verified skill publish (phase 2) | LOW | 3d |

**Total:** ~17d of engineering effort across ~6 sprints.
**No GA blockers.** Recommend addressing Criticals + the HIGH cluster (model ceiling, metrics, Python CI) before scaling past ~100k tenant-sessions/day.
