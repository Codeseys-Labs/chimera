---
title: Stream 4 — CLI Modernization
status: draft
references: [ADR-029, ADR-030]
priority: P1
estimated_effort: L
---

## Objective

Modernize the `packages/cli/` package to use Bun built-ins instead of Node.js polyfills, migrate all 6 packages from Jest to `bun:test`, wire CLI commands to real API endpoints, unify config on `chimera.toml`, and improve the UX with `--json` output, `chimera doctor`, and `chimera login`. Result: a faster, leaner CLI with zero Jest dependencies and real API integration.

## Background (reference ADRs)

ADR-029 (pending) documents the Bun built-in migration strategy (from Stream 5 audit). ADR-030 (pending) covers the CLI command design for `chimera login`, `chimera chat`, and `chimera doctor`.

Key existing patterns:
- `cli-toml-config-override-pattern` (mulch): All CLI commands load config via `loadWorkspaceConfig()`, override with env vars
- `cli-toml-write-back` (mulch): Commands that write state use `saveWorkspaceConfig({...loadWorkspaceConfig(), settingName: value})`
- `cli-deploy-github-release-default` (mulch): `chimera deploy` auto mode defaults to `github-release`
- `cli-destroy-export-reseed` (mulch): `destroy --retain-data` supports `--export-path`
- `bun-jest-mock-factory-required` (mulch): `jest.mock()` in Bun requires factory parameter always
- `bun-worktree-needs-install` (mulch): Fresh worktrees need `bun install` before tests

## Detailed Changes

### 1. Bun Built-in Replacements (packages/cli/)

**Replace `chalk` with Bun ANSI colors**

Find all `chalk` imports in `packages/cli/src/`:
```bash
grep -r "chalk" packages/cli/src/ --include="*.ts"
```

Create `packages/cli/src/lib/color.ts` — a minimal wrapper using raw ANSI escape codes:
```typescript
// Thin wrapper — no runtime dependency, Bun built-in
export const color = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:   (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow:(s: string) => `\x1b[33m${s}\x1b[0m`,
  bold:  (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:   (s: string) => `\x1b[2m${s}\x1b[0m`,
}
```

Replace all `chalk.X(...)` calls in CLI files with `color.X(...)`. Remove `chalk` and `@types/chalk` from `packages/cli/package.json`.

**Replace subprocess calls with `Bun.$`**

In `packages/cli/src/commands/deploy.ts` and `destroy.ts`, replace `execSync`/`execFileNoThrow` calls that invoke fixed CLI tools with `Bun.$` template literals. For commands with user-controlled arguments, continue using the project's `execFileNoThrow` utility (at `src/utils/execFileNoThrow.ts`) — it uses `execFile` (not `exec`/`shell`) to prevent shell injection:

```typescript
// Fixed args — safe to use Bun.$
await Bun.$`aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE`

// User-controlled args — use execFileNoThrow to prevent shell injection
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
await execFileNoThrow('aws', ['cloudformation', 'deploy', '--stack-name', userProvidedName])
```

**Replace `fs.readFileSync` / `writeFileSync` with `Bun.file()` / `Bun.write()`**

In `packages/cli/src/utils/config.ts`, `source.ts`, `workspace.ts`:
```typescript
// Before:
import { readFileSync, writeFileSync } from 'fs'
const data = JSON.parse(readFileSync(path, 'utf-8'))
writeFileSync(path, JSON.stringify(data, null, 2))

// After:
const data = await Bun.file(path).json()
await Bun.write(path, JSON.stringify(data, null, 2))
```

Update callers to handle `async`. Verify `chimera.toml` parsing uses `bun:toml` (already available via `Bun.TOML`).

### 2. Jest to bun:test Migration (all 6 packages)

Packages: `packages/cli`, `packages/core`, `packages/shared`, `packages/chat-gateway`, `packages/agents` (if applicable), `packages/web` (new from Stream 3).

For each package:

**a) Remove Jest dependencies from `package.json`:**
```json
// Remove from dependencies and devDependencies:
"jest", "ts-jest", "@types/jest", "jest-environment-node", "jest-environment-jsdom"
```

**b) Delete Jest config files:**
```bash
rm -f jest.config.js jest.config.ts jest.config.mjs
```

**c) Update test script in `package.json`:**
```json
// Before:
"test": "jest"
// After:
"test": "bun test"
```

**d) Update test file imports:**
```typescript
// Before:
import { describe, it, expect, jest } from '@jest/globals'

// After:
import { describe, it, expect, mock, beforeAll, afterEach } from 'bun:test'
```

**e) Update mock calls:**
```typescript
// Before (Jest):
jest.mock('../some-module')

// After (Bun) — factory is REQUIRED (see mulch record bun-jest-mock-factory-required):
mock.module('../some-module', () => ({
  someFunction: mock(() => 'mocked value')
}))
```

**f) Update snapshot handling:**
Bun uses `.snap` files in the same directory as the test file (not `__snapshots__/`). Delete old `__snapshots__/` directories. Run `bun test --update-snapshots` to regenerate.

**g) Root package.json test script:**
```json
"test": "bun test --recursive"
```

Verify this discovers all test files across packages.

### 3. Wire Real API Calls

**Add API base URL config to chimera.toml:**
```toml
[api]
base_url = "https://your-alb-endpoint.example.com"
```

Load via `loadWorkspaceConfig()` in commands.

**`packages/cli/src/commands/tenant.ts`** — replace hardcoded data:
```typescript
// tenant list — replaces any hardcoded arrays
const response = await apiClient.get('/tenants')

// tenant create
const response = await apiClient.post('/tenants', { name, tier, deploymentModel })
```

**`packages/cli/src/commands/session.ts`** (create if not exists):
```typescript
// session list: GET /sessions
// session create: POST /sessions
// session delete: DELETE /sessions/:id
```

**`packages/cli/src/commands/skill.ts`** (wire if stubbed):
```typescript
// skill list: GET /skills
// skill install: POST /skills
// skill uninstall: DELETE /skills/:name
```

Create `packages/cli/src/lib/api-client.ts`:
```typescript
// Reads auth token from ~/.chimera/credentials
// Sets Authorization: Bearer <token> header
// Base URL from chimera.toml [api] section
// Returns typed responses (shared types from @chimera/shared)
// Throws ChimeraAuthError on 401 (triggers re-auth prompt)
```

### 4. New Commands

**`chimera login`** (`packages/cli/src/commands/login.ts`):
- Cognito PKCE auth flow in terminal
- Open browser to Cognito hosted UI, start local redirect listener on `http://localhost:9999/callback`
- Capture authorization code from redirect URL, exchange for tokens via HTTPS POST to Cognito token endpoint
- Store tokens in `~/.chimera/credentials` (JSON: `accessToken`, `idToken`, `refreshToken`, `expiresAt`)
- Print success message with expiry time
- Security: token exchange uses `fetch` over HTTPS (not shell); credentials file has mode `0600`

**`chimera chat`** (`packages/cli/src/commands/chat.ts`):
- Interactive terminal session using `readline` interface or `Bun.stdin` reader
- Send message to `POST /chat/stream` (SSE endpoint)
- Stream response tokens to stdout as they arrive
- Ctrl+C gracefully ends session and closes SSE connection
- `--session-id` flag to resume existing session

**`chimera doctor`** (`packages/cli/src/commands/doctor.ts`):
Pre-flight checks with status for each:
1. AWS credentials: verify `~/.aws/credentials` exists or `AWS_ACCESS_KEY_ID` env set
2. Chimera auth: read `~/.chimera/credentials`, check expiry
3. API connectivity: `GET {api.base_url}/health`
4. Cognito pool: check `userPoolId` in config is non-empty
5. Stack status: check CloudFormation stacks (fixed list of stack names from config)

**`chimera config show`** (add subcommand to existing config command):
- Dump effective config (chimera.toml merged with env var overrides) as JSON or table
- Redact sensitive values (tokens, keys) unless `--show-secrets` flag

### 5. Config Unification

**Remove `loadConfig()` / `saveConfig()`** from `packages/cli/src/utils/config.ts` (these use `~/.chimera/config.json`).

**Migrate all command usages** to `loadWorkspaceConfig()` / `saveWorkspaceConfig()` (these use `chimera.toml`).

**Auth tokens** go in `~/.chimera/credentials` (NOT chimera.toml — credentials are per-user, not per-project).

**After migration**: delete `~/.chimera/config.json` handling entirely. If the file exists on disk, emit a deprecation warning and offer to migrate values to `chimera.toml`.

### 6. UX Improvements

**`--json` flag**: Add to ALL commands. When set, suppress spinner/color output and print a JSON object. Use consistent envelope:
```json
{ "status": "ok", "data": { ... } }
{ "status": "error", "error": "message", "code": "ERROR_CODE" }
```

**`chimera sync` confirmation**: Before overwriting local files, prompt:
```
Sync will overwrite 3 local files. Continue? [y/N]
```
Skip prompt if `--yes` flag is passed.

**Rename `chimera connect` → `chimera endpoints`**: Keep `chimera connect` as a deprecated alias that prints: `"connect" is deprecated, use "endpoints"`.

**Dynamic version**: Read version from `package.json` at runtime using `Bun.file(join(import.meta.dir, '../package.json')).json()` instead of hardcoded `'0.1.0'`.

## Acceptance Criteria

- [ ] `grep -r "jest" packages/*/package.json` returns 0 matches
- [ ] `bun test` from repo root discovers and runs all tests (0 failures)
- [ ] `chimera tenant list` fetches real data from the API (not hardcoded)
- [ ] `chimera login` completes PKCE flow and stores tokens in `~/.chimera/credentials`
- [ ] `chimera doctor` runs 5 pre-flight checks and prints pass/fail for each
- [ ] `chimera.toml` is the sole config file for project settings (no `config.json` reads)
- [ ] `--json` flag works on: `tenant list`, `tenant create`, `session list`, `skill list`
- [ ] `chimera --version` reads version from `package.json` (not hardcoded)

## Test Requirements

**`packages/cli/src/__tests__/commands/login.test.ts`**:
- Mock the PKCE token exchange fetch call
- Verify credentials file is written with correct structure
- Verify expired token detection

**`packages/cli/src/__tests__/commands/doctor.test.ts`**:
- Mock AWS credential check, API health endpoint
- Verify each check produces the right pass/fail output

**`packages/cli/src/__tests__/lib/api-client.test.ts`**:
- Verify auth header is set from credentials file
- Verify base URL is read from config
- Verify 401 response triggers ChimeraAuthError

**`packages/cli/src/__tests__/commands/tenant.test.ts`** (update):
- Replace hardcoded data assertions with API mock assertions

## Dependencies on Other Streams

- **Stream 1** (blocking): Tier naming must use `premium` before CLI commands reference tier values
- **Stream 5** (informs): Bun built-in audit (Stream 5) provides the complete replacement map — implement Stream 5 first to avoid missing replacements
- **Stream 3** (independent): Frontend and CLI are separate packages, no dependency

## Risk Assessment

- **High**: Jest → bun:test migration may surface mock incompatibilities — some Jest matchers (`toMatchObject` deep nesting, custom serializers) behave slightly differently in Bun
- **Medium**: Cognito PKCE in a terminal environment requires a local HTTP redirect server — test on both macOS and Linux
- **Medium**: `Bun.$` is async where sync calls existed — may require refactoring call chains in deploy/destroy commands; use `execFileNoThrow` for user-input arguments to maintain shell injection protection
- **Mitigation**: Migrate one package at a time, run `bun test` after each migration before proceeding
