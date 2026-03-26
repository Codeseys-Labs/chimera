---
title: Stream 1 — Gap Fixes
status: draft
references: [ADR-024]
priority: P0
estimated_effort: L
---

## Objective

Close the gap between current codebase state and the documented architecture. This stream fixes tier naming inconsistencies, wires unmounted integration routes, resolves 81 failing tests, and completes evolution Lambda stubs. This is a blocking prerequisite for all other streams.

## Background (reference ADRs)

ADR-024 (pending) documents the gap analysis between the intended architecture and the current implementation. The gaps identified are:

- **Tier naming drift**: The codebase uses `enterprise` and `dedicated` tiers but the canonical model calls for `basic|advanced|premium`. Dedicated deployment is a `deploymentModel` boolean, not a tier.
- **Unmounted routes**: Discord, Teams, and Telegram route handlers exist in `packages/chat-gateway/src/routes/` but are not imported or mounted in `server.ts`.
- **Test failures**: 81 tests fail across 8 categories, mostly due to the Hono migration leaving Express-style test patterns that no longer work.
- **Evolution Lambda stubs**: 4 of 6 Lambda handlers in `infra/lib/evolution-stack.ts` are TODO stubs with no real logic.
- **API Gateway 501s**: REST endpoints return `MockIntegration` — intentional but needs documentation.

## Detailed Changes

### 1. Tier Naming (find-and-replace)

Replace all occurrences of `enterprise` with `premium` and remove `dedicated` as a tier value (it becomes a boolean `deploymentModel` field).

**`packages/shared/src/types/tenant.ts`**
- Change `TenantTier` type from `'basic' | 'advanced' | 'enterprise' | 'dedicated'` to `'basic' | 'advanced' | 'premium'`
- Add `deploymentModel: 'shared' | 'dedicated'` field to `TenantConfig` or `TenantProfile`

**`packages/cli/src/commands/tenant.ts`**
- Lines 22, 43: Change `'enterprise'` → `'premium'`
- Update any help text or validation arrays

**`packages/chat-gateway/src/routes/tenant.ts`**
- Lines 90, 122, 410: Update `validTiers` array to `['basic', 'advanced', 'premium']`
- Remove `'dedicated'` from any validation logic

**`packages/agents/chimera_agent.py`**
- Lines 255, 260, 414, 416, 438, 473: These already use `'premium'` — verify consistency, no change expected

**`packages/core/src/gateway/__tests__/gateway.test.ts`**
- Lines 170-282: Change `'enterprise'` to `'premium'` in test names and assertions

**All other files**: Run `grep -r 'enterprise' packages/` — fix every match. Also run `grep -r "'dedicated'" packages/` and migrate to `deploymentModel` field.

### 2. Unmounted Routes

**`packages/chat-gateway/src/server.ts`**

Add imports (following existing pattern at lines 13-17):
```typescript
import { discordRouter } from './routes/discord'
import { teamsRouter } from './routes/teams'
import { telegramRouter } from './routes/telegram'
```

Mount with middleware following the Slack pattern (lines 39-65):
```typescript
app.use('/discord', extractTenantContext, rateLimitMiddleware, discordRouter)
app.use('/teams', extractTenantContext, rateLimitMiddleware, teamsRouter)
app.use('/telegram', extractTenantContext, rateLimitMiddleware, telegramRouter)
```

Verify that `extractTenantContext` and `rateLimitMiddleware` are already imported. If not, import them from their existing locations.

### 3. Fix 81 Failing Tests (8 categories)

**Category 1: Discord/Teams/Telegram route tests**
- Root cause: Tests use Express-style `supertest(app)` after Hono migration
- Fix: Apply `createAdaptorServer` pattern (see mulch record `hono-test-createAdaptorServer-pattern`)
- Pattern: `const server = createAdaptorServer({ fetch: app.fetch }); supertest(server)`
- Note: `supertest` is not in `chat-gateway/package.json` — add it to devDependencies

**Category 2: TenantOnboardingStack CDK**
- Root cause: Lambda count assertion expects 9, actual count differs
- Fix: Run `npx cdk synth` and count actual Lambdas in the stack, update assertion to match
- Use `beforeAll` not `beforeEach` for stack synthesis (see mulch record `cdk-test-beforeall-pattern`)

**Category 3: Agent Lifecycle Integration**
- Root cause: Tests need a mock agent backend that doesn't exist
- Fix: Create `packages/core/src/__tests__/fixtures/mock-agent-backend.ts` — implement a stub that satisfies the interface

**Category 4: Chat Flow Integration**
- Root cause: SSE streaming mocks are stale (mock expectations don't match current streaming format)
- Fix: Update mock return values to match `StreamBufferService` output format (see mulch record `stream-buffer-hybrid-ddb`)

**Category 5: Skill Installation Integration**
- Root cause: Tests need a mock skill registry
- Fix: Create `packages/core/src/__tests__/fixtures/mock-skill-registry.ts`

**Category 6: E2E tests**
- Root cause: Require deployed infrastructure
- Fix: Add `test.skip` with a clear TODO comment: `// TODO: requires deployed stack — run with E2E_ENABLED=true`
- Do NOT delete these tests

**Categories 7-8**: Diagnose and fix individually. If a test cannot be fixed in < 30 min, skip with a documented reason.

### 4. Evolution Lambda Stubs

**`infra/lib/evolution-stack.ts`** — Complete the 4 stub Lambda handler bodies. Each handler file lives in `packages/core/src/evolution/` (or create if not present).

**promptEvolution Lambda**:
- Read current prompt versions from DynamoDB
- Generate N variants using LLM API (existing model routing)
- Create A/B test allocation (split traffic by tenantId hash)
- Track variant performance metrics in DynamoDB
- After N sessions, select winning variant, promote to active

**autoSkillGen Lambda**:
- Query mulch records with `confidence >= 0.7` (see mulch record `generateSkill Lambda uses pattern-based SKILL.md synthesis`)
- Filter `top_patterns` by confidence threshold
- Synthesize SKILL.md from pattern descriptions
- Store in skill registry DynamoDB table

**modelRouting Lambda**:
- Read latency/cost/quality metrics from DynamoDB cost-tracking table
- Apply Bayesian optimization to select optimal model for request characteristics
- Update routing weights in DynamoDB

**memoryEvolution Lambda**:
- Scan sessions older than TTL threshold
- Apply summarization/compression to session memories
- Garbage collect expired entries
- Reference existing memory strategy from ADR-016

### 5. API Gateway 501s — Documentation

Add a comment block to `infra/lib/api-stack.ts` near each `MockIntegration`:
```typescript
// INTENTIONAL: This endpoint uses MockIntegration until PlatformRuntimeStack
// wires real Lambda handlers. The chat-gateway (Hono on ECS Fargate) handles
// all real traffic. API Gateway REST endpoints are the management API and
// are lower priority. See ADR-024.
```

No functional change needed.

## Acceptance Criteria

- [ ] `TenantTier` type is `'basic' | 'advanced' | 'premium'` everywhere — `grep -r "enterprise\|dedicated" packages/` returns 0 matches (excluding comments and docs)
- [ ] `server.ts` mounts all 6 platform integration routes: `/slack`, `/discord`, `/teams`, `/telegram`, and at minimum health and auth
- [ ] `bun test` exits 0 — 0 failures across all packages (skipped tests are acceptable with documented reasons)
- [ ] Evolution Lambdas have real handler logic (no `TODO: implement` comments in handler bodies)
- [ ] API Gateway MockIntegrations have explanatory comments

## Test Requirements

- Route mounting: Write a test in `packages/chat-gateway/src/__tests__/server.test.ts` that verifies all routes return non-404 for their root paths
- Tier validation: Add test asserting `TenantTier` rejects `'enterprise'` and `'dedicated'`
- Evolution Lambdas: Unit tests for each handler function (happy path + error case)

## Dependencies on Other Streams

- **None** — this is the blocking prerequisite for all other streams
- Stream 4 (CLI Modernization) depends on the tier naming being fixed first

## Risk Assessment

- **High**: 81 test failures span multiple packages — some may reveal deeper integration issues
- **Medium**: Unmounted routes may expose auth/security gaps — verify middleware applies correctly before merging
- **Low**: Evolution Lambda stubs — business logic is new but isolated Lambda functions
- **Mitigation**: If any test category reveals a systemic issue, create a new seeds task rather than blocking this stream
