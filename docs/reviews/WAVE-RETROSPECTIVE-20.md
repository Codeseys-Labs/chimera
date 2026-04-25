---
title: "Wave 20 Retrospective — Backlog triage + NACL defense-in-depth + ROADMAP refresh"
status: retrospective
date: 2026-04-25
wave: 20
previous: WAVE-RETROSPECTIVE-19.md
---

# Wave 20 Retrospective

**Dates:** 2026-04-25
**Outcome:** 3 commits landed on `main`. Wave-20 was a small "cleanup
between pushes" wave — no new findings, no deploy-blocking items. Closed
one Backlog-priority seeds issue (chimera-982e NACL) and re-grounded
the backlog docs against reality. Unblocked the strands-agents migration
path with research rather than implementation (SDK still in RC).

## Commits this wave (3)

1. `7a62367` chore(wave-20): untrack tsbuildinfo + document strands-agents migration path
2. `00585e7` fix(network): add defense-in-depth NACL on isolated subnet tier (chimera-982e)
3. `d7225ce` docs(roadmap): refresh for v0.6.3 state + Wave-20 closures

## Backlog delta

| Category | Wave 19 end | Wave 20 end | Δ |
|----------|-------------|-------------|-----|
| Seeds open | 11 | 10 | -1 (chimera-982e) |
| Tracked tsbuildinfo files | 2 | 0 | -2 |
| Stale ROADMAP line-items | 6 | 0 | -6 (replaced with current state) |
| Wave-20 new findings | — | 0 | 0 |

## Work done

### chimera-982e — VPC NACL defense-in-depth

Added a named NACL (`chimera-isolated-nacl-${env}`) covering the
`PRIVATE_ISOLATED` subnet tier only. Rules allow TCP ports 1-65535 to/from
the VPC CIDR; the CDK-provided default deny handles the rest.

Scope decision: **only the isolated tier**, not public/private. NACLs
are stateless — restricting public/private to VPC-CIDR-only would
require explicit ephemeral-port allowance (1024-65535) for return
traffic, and a misconfiguration there would take down NAT gateway
egress, API calls, and health checks. Security groups on those tiers
already do stateful filtering. The isolated tier is the right target:
no internet path, high blast radius if future DB/cache resources were
misconfigured, and no ephemeral-port complexity because nothing inside
initiates to the internet.

Tests added: 4 assertions in network-stack.test.ts (exactly 1 NACL,
named with env; ingress ALLOW TCP 1-65535; egress ALLOW TCP 1-65535;
one SubnetNetworkAclAssociation per isolated subnet).

### chimera-b7af — Reframed (not executed)

Subagent research (web + npm) confirmed `@strands-agents/sdk@1.0.0-rc.5`
is now published (AWS Labs, github.com/strands-agents/sdk-typescript,
last published 2 days ago). The "waiting on npm publish" blocker is
cleared, but the shim's Zod-based `ToolConfig` API does not match the
official SDK's JSON-Schema-based tool builder.

Decision: **do not execute in Wave 20**. The SDK is still release-candidate
(1.0.0-rc.5); pinning vs RC churn is a judgment call worth deferring
to 1.0.0 GA. Instead, updated:
- The shim's header comment with the full migration plan (Zod→JSON-Schema
  adapter via `zod-to-json-schema`, per-call-site rewrite, SDK tool
  builder adoption).
- Seeds issue title: "Remove shim when package published" → "Migrate
  shim → @strands-agents/sdk (API mismatch: Zod vs JSON Schema)".

This makes the future work unambiguous and tracked, without the risk of
attempting an RC-based integration that would need re-work at GA.

### Tsbuildinfo cleanup

Two `.tsbuildinfo` files had been committed in earlier waves before the
gitignore covered them:
- `tsconfig.tsbuildinfo` (root, committed in `c11904d`)
- `packages/shared/tsconfig.tsbuildinfo` (committed in `32c060f`)

Both regenerate on every `tsc` / `bun run typecheck` run and have been
showing in `git status` as ` M` noise for every wave since at least
Wave 15. Root `.gitignore` already has `*.tsbuildinfo`, so
`git rm --cached` on the two tracked files closes the loop.

### ROADMAP refresh

The previous ROADMAP (`Last Updated: 2026-04-18`) predated:
- v0.6.2 / v0.6.3 releases
- First CDK deploy (14/14 stacks live)
- Waves 15-19 (5 retrospectives)
- DR runbook completion (Wave 18)
- All Wave-17 / Wave-18 security-ops closures

Updated header, current-state timestamp, "What Remains" table (dropped 6
now-closed items, added Wave-20 in-flight entries), and the
"Remaining (Backlog)" list (synced with `sd list` — 10 open items
matching seeds tracker exactly).

## Cross-cutting observations

### Backlog-audit subagent confabulated a file that doesn't exist

The audit subagent referenced `docs/reviews/OPEN-PUNCH-LIST.md` as if it
were authoritative, including an item count ("54 items across 7 waves").
The file does not exist in the repo — and never has per git log. The
audit was otherwise accurate (11 Seeds items matched `sd list`), but
the punch-list fabrication would have propagated into the retrospective
if I hadn't verified.

**Lesson:** Always `ls` or `find` the files a subagent cites before
treating them as ground truth. Subagents are probabilistic — the more
domain-plausible the filename, the more likely a hallucination slips
through.

### Research-first on external dependencies pays off

Two Wave-20 decisions pivoted on research outcomes:
1. Strands SDK **is published** → didn't wait for publish
2. Strands SDK **is RC + API mismatch** → didn't migrate yet

Both decisions were made in minutes with the research subagent. The
cost of attempting migration without checking would have been hours
of rework when the schema mismatch surfaced. Pattern: cheap research
agent before every external-dependency judgment call.

### NACL stateless-semantics gotcha

Initial instinct was "tighten all three tiers" — would have broken NAT
egress immediately. AWS documentation (retrieved via AWS Knowledge MCP)
made it explicit: NACLs have no concept of stateful return traffic, so
ephemeral-port allowance is mandatory for any inbound-restricted tier
with outbound flows. Scoped to the isolated tier only to avoid the
landmine.

## Deploy state

- 14/14 stacks still live in `baladita+Bedrock-Admin`
- 627 infra tests pass (was 623; +4 NACL assertions)
- v0.6.3 tag remains the current release; Wave 20 is cleanup, no new tag
- No production regression in this wave

## Wave 21 candidates

The ROADMAP's Remaining (Backlog) is now 10 items. Of those:

**Blocked on live environment (can't do offline):**
- chimera-0092 (E2E chat validation)
- chimera-2087 / chimera-9035 (CLI E2E integration tests)
- chimera-d123 (pipeline re-push)
- chimera-bbbc (agent system prompt tuning)

**Ready for Wave 21 if user wants to continue:**
- TS `strict: true` + `any` quarantine (793 sites, 2d — genuinely
  executable without live AWS)
- ADR-034 Registry multi-tenancy spike (1 week — scoping doc only,
  no deploy needed)

**Strategic / multi-week (needs product sign-off):**
- Close the GTM loop (signup + Stripe + admin UI CRUD)
- chimera-b7af (strands-agents migration — wait for SDK 1.0.0 GA)

**P2 deferred:**
- chimera-76b9 LLM task decomposer
- chimera-2b2a EventBridge cron
- chimera-59ee webhooks
- chimera-606c DGM evolution

**Recommendation:** Unless the user points to a specific item,
Wave 21 should pause and hand back — the post-deploy loop (d123→0092→bbbc)
needs live-AWS access and is the natural gate for further tactical work.

## References

- `docs/reviews/wave20-backlog-audit.md` — Wave-20 backlog audit
- `docs/ROADMAP.md` — Refreshed roadmap
- Seeds issue `chimera-982e` (closed) — NACL defense-in-depth
- Seeds issue `chimera-b7af` — retitled with migration context
