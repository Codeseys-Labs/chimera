# Chimera Test Suite

Comprehensive test framework for the AWS Chimera multi-tenant AI agent platform.

## Test Organization

```
tests/
├── helpers/                 # Shared test utilities
│   ├── test-client.ts      # HTTP client wrapper for API testing
│   └── mock-model.ts       # Mock LLM provider for deterministic testing
├── integration/            # Integration tests (AgentCore + AWS services)
│   ├── agent-lifecycle.test.ts
│   ├── skill-install.test.ts
│   └── chat-flow.test.ts
├── e2e/                    # End-to-end user journey tests
│   └── chat-e2e.test.ts
├── load/                   # Load and performance tests
│   └── load-test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Test Categories

### Helpers (`helpers/`)

Reusable utilities for testing:

- **TestClient**: HTTP client wrapper for authenticated API requests with tenant context
  - Session management
  - Message sending (blocking and streaming)
  - Skill operations
  - Cost tracking
- **MockModel**: Deterministic LLM provider for unit testing
  - Pre-configured responses
  - Tool call simulation
  - Call history tracking
  - Assertion helpers

### Integration Tests (`integration/`)

Test individual components against staging AWS services:

- **agent-lifecycle.test.ts**: Session creation, state management, isolation
- **skill-install.test.ts**: Skill discovery, installation, usage, security
- **chat-flow.test.ts**: SSE streaming, multi-turn conversations, error handling

**Requirements:** AgentCore Runtime staging environment, DynamoDB tables

### E2E Tests (`e2e/`)

Test complete user journeys through the full stack:

- **chat-e2e.test.ts**: Onboarding, research workflows, multi-tenant isolation, security

**Requirements:** Full staging environment (all stacks deployed)
**Budget:** < $2.00 per test run

### Load Tests (`load/`)

Test performance and scaling behavior:

- **load-test.ts**: Concurrent sessions, sustained load, burst traffic, cold start benchmarking

**Requirements:** Staging environment
**Budget:** < $5.00 per full load test run

## Running Tests

### Prerequisites

1. **Install dependencies:**
   ```bash
   bun install
   ```

2. **Set environment variables:**
   ```bash
   # Integration tests
   export CHIMERA_TEST_API_URL="https://api.chimera-staging.example.com"
   export CHIMERA_TEST_TENANT_ID="test-integration"
   export CHIMERA_TEST_AUTH_TOKEN="your-jwt-token"

   # E2E tests
   export CHIMERA_E2E_API_URL="https://api.chimera-staging.example.com"
   export CHIMERA_E2E_TENANT_ID="e2e-test-tenant"
   export CHIMERA_E2E_AUTH_TOKEN="your-jwt-token"

   # Optional: second tenant for isolation tests
   export CHIMERA_E2E_TENANT_B_ID="e2e-test-tenant-b"
   export CHIMERA_E2E_TENANT_B_TOKEN="tenant-b-jwt-token"

   # Load tests
   export CHIMERA_LOAD_TEST_API_URL="https://api.chimera-staging.example.com"
   export CHIMERA_LOAD_TEST_TENANT_ID="load-test-tenant"
   export CHIMERA_LOAD_TEST_AUTH_TOKEN="your-jwt-token"
   ```

### Run Tests

```bash
# All tests
bun test

# Integration tests only
bun run test:integration

# E2E tests only
bun run test:e2e

# Load tests only (sequential, not parallel)
bun run test:load

# Specific test file
bun test tests/integration/agent-lifecycle.test.ts

# With coverage
bun test --coverage
```

## Test Strategy

Chimera follows the test pyramid approach:

```
       /  E2E (10%)  \        Real LLMs, real AWS, multi-tenant
      / Integ (25%)   \       AgentCore staging, mocked LLMs
     / Unit (65%)      \      Pure TS, mocked everything
```

### Test Philosophy

1. **Deterministic boundaries**: Mock LLMs at unit test level; test real LLMs only in E2E
2. **Contract-based testing**: Validate schemas, not exact values
3. **Statistical assertions**: E2E tests assert on distributions (>80% pass rate), not single outcomes
4. **Isolation by default**: Every test tenant gets a fresh namespace
5. **Cost-aware testing**: Budget caps on every test suite

## Quality Gates

All tests must pass before merge:

```bash
bun test              # All tests pass
bun run lint          # Zero lint errors
bun run typecheck     # No TypeScript errors
```

## Test Data Management

- Test tenants use prefix: `test-`, `e2e-test-`, `load-test-`
- Sessions auto-expire via DynamoDB TTL (24 hours)
- Cost tracking prevents runaway spending

## Performance Targets

From [docs/research/enhancement/06-Testing-Strategy.md](../docs/research/enhancement/06-Testing-Strategy.md):

| Metric | Target | P50 | P95 | P99 |
|--------|--------|-----|-----|-----|
| Session creation | <2s | <500ms | <1.5s | <3s |
| First token latency | <3s | <1s | <2.5s | <5s |
| Full response (simple) | <10s | <3s | <8s | <15s |
| Tool invocation | <5s | <1s | <3s | <8s |

## Security Testing

Integration and E2E tests include:

- Prompt injection attempts (15+ payloads)
- Cross-tenant data access attempts
- JWT validation (expired, malformed, wrong-tenant)
- Cedar policy enforcement
- Skill security and sandboxing

## Troubleshooting

### Tests timing out

- Increase timeout in test config: `timeout: 120000` (2 minutes)
- Check staging environment health: `aws cloudwatch get-metric-statistics ...`

### Authentication errors

- Verify JWT token is valid: `jwt decode $CHIMERA_TEST_AUTH_TOKEN`
- Check Cognito user pool and tenant configuration

### Rate limiting

- Reduce concurrency in load tests
- Add delays between requests: `await new Promise(resolve => setTimeout(resolve, 1000))`

### Budget exceeded

- Check current spend: `client.getTotalCost()`
- Reduce test load or increase budget cap

## CI/CD Integration

Tests run in CodePipeline/GitHub Actions:

1. **Unit tests** (< 5 min) - Runs on every PR
2. **Integration tests** (< 15 min) - Runs on every PR
3. **Security tests** (< 10 min) - Runs on every PR
4. **E2E tests** (< 30 min) - Runs on merge to main
5. **Load tests** (< 60 min) - Runs weekly

## Related Documentation

- [Testing Strategy](../docs/research/enhancement/06-Testing-Strategy.md) - Comprehensive testing plan
- [Operational Runbook](../docs/research/enhancement/07-Operational-Runbook.md) - Production operations
- [CLAUDE.md](../CLAUDE.md) - Development workflow and quality gates

---

**AWS Chimera** — where agents are forged.
