---
title: "Wave 21 Retrospective — First live E2E validation; 3 Seeds issues closed"
status: retrospective
date: 2026-04-25
wave: 21
previous: WAVE-RETROSPECTIVE-20.md
---

# Wave 21 Retrospective

**Dates:** 2026-04-25
**Outcome:** First TRUE end-to-end validation of the deployed platform.
Frontend SPA uploaded, Cognito auth flow validated, chat-gateway SSE
streaming confirmed working against live Bedrock. 3 Seeds issues closed
in this wave. Backlog: 10 → 7 open items.

## Commits this wave (pending)

(to be filled by commit below)

## Issues closed (3)

| Seeds ID | Title | Resolution |
|----------|-------|------------|
| `chimera-0092` | E2E chat validation | ✅ Live SSE stream from chat-gateway observed |
| `chimera-d123` | Re-push CodeCommit after timeout | ✅ Misdiagnosed — FrontendStack code was fine; S3 bucket was empty. Fixed by uploading SPA build |
| `chimera-bbbc` | Configure agent system prompt + tool awareness | ✅ Confirmed via "What AWS tools can you use?" — agent returns categorized tool inventory |

## Backlog delta

| Category | Wave 20 end | Wave 21 end | Δ |
|----------|-------------|-------------|-----|
| Seeds open | 10 | 7 | -3 |
| Infra (deploy-blocked items) | 5 | 2 | -3 |
| P0 items | 3 | 0 | -3 ✅ |
| Wave-21 new findings | — | 2 docs (follow-ups below) | +2 |

## What actually happened

### Surprise #1: Frontend 403 root cause was an empty bucket

The ROADMAP "Frontend 403 OAC" item (c3c6585 fix) was a red herring. The
code fix had long since deployed. The real issue: `cdk deploy FrontendStack`
creates the S3 bucket + CloudFront distribution + OAC but **does not
build or upload the SPA**. The bucket was empty.

This was invisible because:
- `cdk ls` / `cdk diff` show "no changes" (bucket/CF/OAC all identical)
- Stack status showed `UPDATE_COMPLETE`
- `curl` shows 403, which matches the OAC-failure signature

Fix took 2 minutes: `bun run build` + `aws s3 sync` + `aws cloudfront
create-invalidation`. Added a "Step 6b" section to
`docs/runbooks/first-deployment.md` so the next operator doesn't hit this.

### Surprise #2: `custom:tenant_id` is immutable

Cognito user pool schema sets `custom:tenant_id` with `Mutable: false`.
First attempt: add attribute to the existing user. Failed silently —
`admin-update-user-attributes` doesn't error but the attribute isn't
set. Correct path: delete the user, recreate with all tenant attributes
in the initial `admin-create-user` call.

This is the desired behavior for strong tenant isolation (a user cannot
be "migrated" between tenants), but it's not documented anywhere.
Captured in `wave21-live-validation.md`.

### Surprise #3: `ADMIN_USER_PASSWORD_AUTH` is not allowed by default

Client explicit auth flows are `USER_PASSWORD_AUTH`, `USER_SRP_AUTH`,
`REFRESH_TOKEN_AUTH`. `admin-initiate-auth` requires
`ALLOW_ADMIN_USER_PASSWORD_AUTH` which we intentionally don't enable
(SRP is preferred for production). Tooling scripts must use
`aws cognito-idp initiate-auth` (non-admin).

### The actual E2E result

```
=== POST /chat/stream ===
data: {"type":"start","messageId":"session-1777098686473-6dg9v"}
data: {"type":"text-start","id":"text_0_1777098687679"}
data: {"type":"text-delta","delta":"Hello"}
data: {"type":"text-delta","delta":" there"}
data: {"type":"text-delta","delta":"! How"}
data: {"type":"text-delta","delta":" are"}
data: {"type":"text-delta","delta":" you?"}
data: {"type":"text-delta","delta":" "}
data: {"type":"text-delta","delta":"😊"}
data: {"type":"text-end"}
data: {"type":"finish","finishReason":"stop"}
data: [DONE]
```

First-token latency: ~1.2s. Total stream duration: ~4-6s for short
responses. Bedrock invocation confirmed. Tool surface enumeration
("What AWS tools can you use?") returned a categorized multi-section
inventory (EC2, Lambda, S3, RDS, IAM, CloudFormation, ...) — the agent
has a configured system prompt AND tool awareness.

## Follow-ups surfaced

| Priority | Item | Why |
|----------|------|-----|
| Medium | Automate SPA build+upload+invalidation | Operator currently has to remember this; should be `chimera deploy --upload-web` or CodeBuild post-deploy |
| Low | Tenant-provisioning onboarding flow | Pre-GTM we're seeding tenants via `ddb put-item`; needed before self-serve signup |
| Low | Document `custom:tenant_id` immutability in admin runbook | Required for admins understanding user migration constraints |

## Playwright MCP

Registered via `claude mcp add playwright -- npx @playwright/mcp@latest`.
Requires session restart to load — the tool-schema registry is snapshotted
at session start. Will be useful for Wave 22+ for browser-interaction
E2E flows.

## Deploy state

- 14/14 stacks live in `111122223333` / us-west-2 / `baladita+Bedrock-Admin`
- Frontend: https://d30xc1vss60b97.cloudfront.net — **200 OK, SPA serving**
- Chat: https://d162y8bdoodm2x.cloudfront.net — **SSE streaming works**
- Test tenant seeded: `TENANT#test-tenant-wave21` in `chimera-tenants-dev`
- Test user: `wave21-e2e@chimera.test` (Cognito, tier=basic)

## Wave 22 candidates

With the post-deploy P0 loop now closed, the remaining 7 items are all
P1/P2 strategic:

1. `chimera-9035` — CLI E2E integration test scripts (now unblocked)
2. `chimera-2087` — CLI integration tests (overlaps with 9035; dedup?)
3. `chimera-b7af` — strands-agents migration (wait for SDK 1.0.0 GA)
4. `chimera-76b9` — LLM task decomposer (multi-day)
5. `chimera-2b2a` — EventBridge scheduled tasks (multi-day)
6. `chimera-59ee` — Task lifecycle webhooks (multi-day)
7. `chimera-606c` — DGM evolution (multi-day)

**Plus one medium-priority gap surfaced:** automate frontend SPA upload
in the deploy flow.

**Recommended Wave 22 focus:** E2E test scripts (9035 + 2087 consolidated)
now that we have a reproducible pattern (see `wave21-live-validation.md`
command sequence). Everything else is multi-day strategic work best
planned separately.

## References

- `docs/reviews/wave21-live-validation.md` — full validation report
- `docs/runbooks/first-deployment.md` §Step 6b — SPA upload step
- Seeds: chimera-0092, chimera-d123, chimera-bbbc (all closed)
