---
title: "Multi-tenant isolation — live chat-gateway probes (2026-04-28)"
date: 2026-04-28
status: findings
scope: live pre-Wave-32 chat-gateway at https://d162y8bdoodm2x.cloudfront.net
author: lead (post-compaction deep-work-loop session)
---

# Live multi-tenant isolation probes

## Setup

- Authenticated browser session: user `c84193b0-1071-70ee-4e02-68e4749b9202`
  with JWT claim `custom:tenant_id=test-tenant-wave21`.
- Target tenant for cross-tenant reads: `e2e-test-tenant` (2 sessions, 5 DDB
  items total, verified via `aws dynamodb scan`).
- API base: `https://d162y8bdoodm2x.cloudfront.net` (chat-gateway behind
  CloudFront).

## Results

| # | Probe | Expected | Observed | Verdict |
|---|---|---|---|---|
| 1 | `GET /chat/sessions?limit=100` with own JWT | own-tenant sessions only | 21 sessions, none match foreign IDs | ✅ PASS |
| 2 | `GET /chat/sessions` with spoofed `X-Tenant-Id: e2e-test-tenant` header | header ignored, own-tenant data returned | same 5 sessions as baseline | ✅ PASS — header-spoofing blocked |
| 3 | `GET /chat/sessions?tenant=e2e-test-tenant&tenantId=e2e-test-tenant` (query-param spoof) | query param ignored | same sessions, no change | ✅ PASS |
| 4 | `GET /chat/sessions/session_1777165509524` (real foreign session ID) | 404 | `404 Not Found` | ✅ PASS |
| 5 | `GET /chat/sessions/session_1777162478162/messages` (real foreign messages) | empty (filtered at PK) or 404 | `{"sessionId":"…","messages":[],"count":0}` HTTP 200 | ⚠️ PASS (correct data) with minor observability smell |
| 6 | `GET /tenants/:tid/schedules` (Wave-32 route) | 404 — not yet deployed | 404 | ✅ PASS (confirms pre-Wave-32 baseline) |

## Findings

### FINDING 1 (INFO): Messages endpoint returns `200` for non-existent foreign sessions

`GET /chat/sessions/:sessionId/messages` builds
`PK=TENANT#{ownTenant}#SESSION#{sessionId}`. If `sessionId` belongs to
another tenant, the query returns zero items — but the handler responds
`200` with an empty list rather than `404`.

**Not a data leak.** The PK already includes the caller's tenantId, so
there is no cross-tenant data exposure. The handler simply doesn't
distinguish "session doesn't exist in my tenant" from "session exists in
my tenant but has no messages."

**Minor smell:** An attacker can't differentiate the two cases either
(both return empty 200), so enumeration is not more viable than guessing
random IDs. Still, convention is `404` for unknown resources.

**Fix (LOW):** After the DDB query returns zero items, also check whether
the parent `SESSION#{sessionId}` item exists under the caller's PK. If
not, return `404` instead of empty `200`.

**Deferred:** Tracked as a future polish item; does not affect
isolation correctness.

### FINDING 2 (INFO): Sessions are tenant-scoped, not user-scoped

The session list query uses `PK=TENANT#{tenantId}` and
`SK begins_with SESSION#`. All users within the same tenant see all
sessions in that tenant — by design. `chat.ts:724`.

**Interpretation:** "Multi-user chats" within a tenant means a shared
team workspace, not individual private conversations per user. This is
architecturally consistent with a multi-tenant SaaS where a tenant == a
customer organization.

**Not a bug.** The tenant boundary is still strict. Per-user privacy
inside a tenant (e.g., admin-only visibility, author-only visibility)
would require a new access-control dimension (e.g., `userId` in
SK filter + Cedar policies on `Session::Read`) — out of scope for
isolation; logged for future product consideration.

## Summary

Tenant isolation holds under live probing:
- JWT claim is authoritative (header/query spoofing ignored).
- DDB PK design (`TENANT#{id}#...`) structurally prevents cross-tenant
  reads — confirmed by direct foreign-ID reads returning 404.
- No leaks detected across 6 probes.

Wave-32's new `/tenants/:tenantId/schedules` routes return 404 on the
current deployment (expected — Wave-32 was still in pipeline at probe
time). Cross-tenant schedule testing will be re-run after deployment
lands.

## Additional probes — multi-user parallel chat (2026-04-28 16:55)

### PROBE 7: Two parallel sessions, same tenant

Fired `POST /chat/stream` twice in parallel (Promise.all), same JWT, two
different `sessionId`s (`parallel-a-${ts}`, `parallel-b-${ts}`), each
asking for a distinct reply token.

- Both 200, both completed streaming in 1.3s / 1.7s.
- Both persisted under `PK=TENANT#test-tenant-wave21#SESSION#parallel-*`.
- Replies correct: `"parallel-A-ok"` and `"parallel-B-ok"`.

**Result:** ✅ Multi-user parallel chat within a tenant works and isolates
sessions from each other via distinct session IDs. No interleaving.

### PROBE 8: Body-field `tenantId` spoof

Sent `POST /chat/stream` with JWT claim `test-tenant-wave21` but body
`{ tenantId: "e2e-test-tenant", ... }`.

- Request returned 200.
- DDB inspection: message + session persisted under
  `PK=TENANT#test-tenant-wave21#SESSION#spoof-…` — **JWT won, body
  ignored**.
- No cross-tenant data touched.

**Result:** ✅ Body-level tenantId spoofing blocked; server uses JWT
claim as the sole authority.

**Smell (LOW):** The server silently accepted a body-`tenantId` that
conflicted with the JWT. Stricter posture would return `400` on
mismatch, because the only reason a caller supplies it is either
(a) a buggy client, or (b) an attacker probing. Both deserve a loud
rejection rather than silent re-scoping. Filed as a future hardening.

## Next steps (post-Wave-32)

1. Re-run probes #1-5 against the post-Wave-32 build to catch any
   regression in the new `schedules` router.
2. Add a new probe: `GET /tenants/e2e-test-tenant/schedules` with
   `test-tenant-wave21` JWT — must return 403 (Cedar
   `schedule-cross-tenant-deny` policy).
3. Add a new probe: `POST /tenants/e2e-test-tenant/schedules` with own
   JWT + request body — must return 403 (URL tenantId ≠ JWT claim).
