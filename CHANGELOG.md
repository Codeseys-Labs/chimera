# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
