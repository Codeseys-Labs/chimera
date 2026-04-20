# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **ADR-033** — Tenant context injection for Python tools (`ContextVar` + `require_tenant_id()` + `ensure_tenant_filter()`)
- **ADR-034** — AgentCore Registry adoption (partial — Phase 0/1 only)
- Registry adapter code (`packages/core/src/registry/*` — client, feature flags, skill-to-registry mapper, types, tests)
- Registry dual-write scaffolding (flag-gated, default off)
- Registry dual-read scaffolding (flag-gated, default off)
- Registry observability alarms (3 alarms + dashboard panel; INSUFFICIENT_DATA until flags flip)
- Context-gated `RegistryStack` (synthesise with `-c deployRegistry=true`)
- `docs/MIGRATION-registry.md` — operator migration guide
- `docs/research/agentcore-rabbithole/` — 7 operator-grade deep-dive docs (~3,900 lines)
- `packages/agents/tools/tenant_context.py` — canonical tenant-context module with anti-pattern guard test
- `packages/agents/tests/conftest.py` — autouse fixture sets default tenant context for every agents test
- `packages/agents/CONTRIBUTING.md` — Docker supply-chain digest-refresh playbook
- `packages/web/src/components/{error-boundary,empty-state}.tsx` — root error boundary + shared empty state
- `packages/core/src/activity/audit-trail.ts` — `calculateAuditTTL(tier)` + `AUDIT_TTL_DAYS_BY_TIER` (single enforcement point)

### Changed

- Memory namespace format → canonical AgentCore `/strategy/{s}/actor/{a}/session/{s}/`
- Memory strategy identifiers → real SDK names
- Code Interpreter service name: `bedrock-agentcore-runtime` → `bedrock-agentcore`
- 25 Python tool files now enforce tenant context via `require_tenant_id()` (swarm, code_interpreter, evolution, and 21 AWS-service tools)
- DynamoDB query/scan tools auto-inject tenant filter expression (`ensure_tenant_filter()`)
- `chat-gateway` routes validated via Zod schemas (`ChatRequestSchema`) — reject 400 before streaming
- SSE: 15s heartbeat + client-abort via `AbortSignal` + 5s drain watchdog
- Bedrock: `sendWithRetry()` (3 attempts, 500ms base, jitter) on ThrottlingException / 5xx / network errors (never on ValidationException/AccessDenied); tier-ceiling enforcement gate at `buildInput`
- Model router: `MODEL_TIER_ALLOWLIST` + `enforceTierCeiling()` + `cheapestAllowedForTier()`
- CLI: JWT `exp` decode (expired → `ChimeraAuthError`), 5MB file skip WARN (ERROR for IaC under `infra/`), monorepo-aware `findProjectRoot()`
- CDK: WAF → CloudWatch Logs wired; AWS Config managed rule `DYNAMODB_PITR_ENABLED` + composite alarm; dedicated chat-task security group; ALB access-log suppression gated by `isProd`
- Audit TTL enforced per tenant tier (was schema-only) — 90d / 1y / 7y
- Python deps: all upper-bounded in `pyproject.toml`; pytest `integration` marker registered
- CI: Python step split — unit tests fail CI (no `|| echo`), integration tests conditional on real AWS env vars (non-blocking)

### Fixed

- `ConverseStream` `messageStop` race (pending tool blocks previously lost before finish)
- Python `_validate_cdk_code` regex was rejecting valid `class X extends cdk.Stack` code
- Tenant-boundary leaks in Python tool layer (5 `@tool` signatures exposed `tenant_id` as argument; DDB tools had optional filters)
- DAX security-group fallback comment documented (true fix blocked on NetworkStack refactor)
- ALB access-log suppression now gated by `isProd`
- Gateway proxy: 5.5 MB payload cap, iterative stack-safe 32-level depth walker, tool-error envelope with `[TOOL ERROR BEGIN]…[TOOL ERROR END]` truncation
- System prompt: `wrap_untrusted_content()` + delimiter markers around SOUL.md / AGENTS.md / tenant config

### Removed

- `packages/core/src/runtime/agentcore-runtime.ts` (370 LOC dead code — every method TODO-stubbed or reinventing AgentCore primitives)
- `packages/core/src/runtime/__tests__/runtime.test.ts` (tests for the deleted module)

### Security

- All flag-gated migration paths require `assertFlagsConsistent()` at boot — misconfigured env now fails fast at Lambda init instead of silent-skipping (Registry bootstrap fail-fast)
- Grep-based anti-pattern test: every tool importing `boto3` must also import `tenant_context` (`test_no_tool_imports_boto3_without_tenant_context`)
- Cross-tenant data leakage: Python layer closes the gap left by CDK/TS-only enforcement — `ContextVar`-based 3-layer model (CDK + TypeScript Cedar + Python `require_tenant_id()`)

## [0.5.1] - 2026-04-14

### Security

- Full PII/secrets scrub via git filter-repo (25 patterns across 1,805 commits)
- Author identity anonymized to Chimera Team
- Removed hardcoded passwords, emails, AWS account IDs, CloudFront URLs from all files and git history
- chimera.toml gitignored with chimera.toml.example template
- E2E tests require env vars (no PII fallback defaults)

### Changed

- Transferred repo to Codeseys-Labs organization, made public
- Migrated all GitHub Actions to Blacksmith runners (2x faster)
- Sized runners per workload: 4vcpu for heavy, 2vcpu for light, 6vcpu-macos for darwin

### Fixed

- Destroy monitoring: always show progress (was silent without --monitor)
- Poll intervals reduced 15s to 10s, timeouts tightened

## [0.5.0] - 2026-04-10

### Added

- CodeBuild-delegated destroy lifecycle (ADR-032): Phase 1 CodeBuild cdk destroy, Phase 2 Pipeline delete, Phase 3 CodeCommit delete
- buildspec-destroy.yml with DDB protection disable + S3 emptying
- Real boto3 Gateway Tool Lambda handlers (25 AWS services across 4 tiers)
- Real AWS SDK v3 Discovery module implementations (config-scanner, resource-explorer, stack-inventory, tag-organizer)
- 196 orchestration module tests (agent-orchestrator, agent-swarm, workflow-engine, group-chat, cron-scheduler)
- Playwright config + auth setup + 11 E2E spec tests + e2e.yml workflow
- Python agent test step in CI
- Security scans on PRs (was weekly-only)

### Fixed

- Removed `|| true` from buildspec (test failures now block deployment)
- Added packages/web, chat-gateway, tests/unit/email to CI targets
- ESLint `checkLoops:false` for streaming `while(true)` patterns
- Various CDK deploy fixes for fresh account scenarios

## [0.4.0] - 2026-04-10

### Added

- True token-level streaming via ConverseStreamCommand (replaces buffered ConverseCommand)
- Bedrock Mantle support: MantleModel class for OpenAI-compatible Chat Completions API
- Session tracking: GET /chat/sessions endpoint + persistent session metadata
- Model selector UI in Settings page (Converse + Mantle backends)
- ALB idle timeout 300s for long-lived SSE connections
- 168 new tests across all packages
- ADR-032 documentation
- cli-lifecycle.md v2.0.0 with deploy + destroy sequence diagrams
- system-architecture.md v2.0.0 updates

### Fixed

- SSE bridge finish event v5 schema compliance (removed messageId)
- VITE_API_BASE_URL pointed to API Gateway instead of Chat CloudFront
- CodeBuild IAM for Chat stack CloudFormation outputs
- AI SDK v5 message parts format in web adapter
- maxTokens 200000 reduced to 4096 (exceeded Bedrock model limit)

## [0.3.0] - 2026-04-10

### Added

- Vercel AI SDK v5 frontend integration (@ai-sdk/react v2 useChat + DefaultChatTransport)
- Centralized AuthProvider + useAuth hook
- Gateway X-Session-Id header for session tracking
- ai package upgraded v4 to v5

### Fixed

- KMS key mismatch in CodeBuild S3 uploads
- Missing Cognito config in production bundle
- Wrong CloudFormation output key (UserPoolClientId to WebClientId)
