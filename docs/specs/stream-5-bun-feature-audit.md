---
title: Stream 5 — Bun Feature Audit
status: draft
references: [ADR-029]
priority: P0
estimated_effort: M
---

## Objective

Produce a comprehensive audit document that maps every Node.js/npm dependency in this repo to its Bun built-in equivalent (where one exists), provides before/after migration examples, analyzes the Hono vs `Bun.serve()` trade-off, and inventories future Bun features worth adopting. This document feeds directly into Stream 4 (CLI Modernization) and informs ADR-029.

## Background (reference ADRs)

ADR-029 (pending) will codify the Bun feature adoption strategy. This stream produces the research that ADR-029 is based on.

Relevant existing patterns:
- `bun-default-export-fetch-auto-serve` (mulch): Bun auto-starts HTTP when module has `export default { fetch }` — important nuance for migration
- `bun-jest-mock-factory-required` (mulch): `jest.mock()` requires factory in Bun — a migration gotcha
- `bun-test-supertest-missing` (mulch): `supertest` is not in `chat-gateway/package.json` — must be added before tests can run
- `gh-actions-bun-version-pinning` (mulch): Current pinned version is `BUN_VERSION: 1.3.11`
- `bun-worktree-needs-install` (mulch): Fresh worktrees need `bun install`

## Detailed Changes

This stream produces `docs/specs/stream-5-bun-feature-audit.md` as the deliverable itself, plus:
- `docs/research/bun-migration-guide.md` — detailed migration guide with before/after code examples
- `docs/research/hono-vs-bun-serve.md` — framework trade-off analysis

### 1. Dependency Replacement Map

Audit all `package.json` files in the monorepo. For each dependency that has a Bun built-in replacement, add a row to the table below.

**Run to discover:**
```bash
cat packages/*/package.json | jq '.dependencies, .devDependencies | keys[]' | sort -u
```

**Replacement map** (expand during audit):

| Current Dependency | Bun Built-in | Affected Packages | Migration Effort | Notes |
|---|---|---|---|---|
| `chalk` | ANSI escapes | `packages/cli` | S | Simple find-replace |
| `jest` + `ts-jest` + `@types/jest` | `bun:test` | All 6 packages | M | Config removal + mock pattern changes |
| `child_process` (subprocess spawning) | `Bun.$` | `packages/cli` deploy/destroy | S | Template literals; untrusted-input args still use execFileNoThrow |
| `fs` (readFileSync/writeFileSync) | `Bun.file()` / `Bun.write()` | `packages/cli` config/source | S | Async only |
| `dotenv` | Auto `.env` loading | All | XS | Bun loads `.env` automatically; no import needed |
| `glob` / `fast-glob` | `Bun.Glob` | If used in CLI or scripts | S | API is slightly different — check usage |
| `express` + `@types/express` | REMOVE (leftover after Hono migration) | `packages/chat-gateway` devDeps | XS | Already replaced by Hono; just delete |
| `@types/chalk` | REMOVE | `packages/cli` devDeps | XS | With chalk removal |
| `supertest` | `bun test` + `createAdaptorServer` | `packages/chat-gateway` tests | S | See mulch record `hono-test-createAdaptorServer-pattern` |

Effort scale: XS = < 30 min, S = < 2 hours, M = < 1 day, L = multi-day

### 2. Migration Guides

Document these in `docs/research/bun-migration-guide.md`:

**Jest → bun:test**

Before (Jest):
```typescript
import { describe, it, expect } from '@jest/globals'
jest.mock('../module', () => ({ fn: jest.fn() }))
const spy = jest.spyOn(obj, 'method')
expect(spy).toHaveBeenCalledWith('arg')
```

After (bun:test):
```typescript
import { describe, it, expect, mock, spyOn } from 'bun:test'
// Factory parameter is REQUIRED in Bun:
mock.module('../module', () => ({ fn: mock(() => undefined) }))
const spy = spyOn(obj, 'method')
expect(spy).toHaveBeenCalledWith('arg')
```

Key differences to document:
- `jest.fn()` → `mock(() => ...)` (factory required — see mulch record `bun-jest-mock-factory-required`)
- `jest.spyOn` → `spyOn` from `bun:test`
- `jest.clearAllMocks()` → `mock.restore()` (or per-mock `.mockReset()`)
- Snapshot files location: `__snapshots__/` → same dir as test file with `.snap` extension
- `jest.config.js` → deleted entirely (Bun auto-discovers `*.test.ts`)
- Config equivalent: `bunfig.toml` `[test]` section for timeout, preload, etc.

**Subprocess spawning → Bun.$**

Before (Node subprocess APIs):
```typescript
const output = spawnSync('aws', ['sts', 'get-caller-identity']).stdout.toString()
```

After (Bun.$):
```typescript
// Fixed args — safe as template literal
const output = await Bun.$`aws sts get-caller-identity`.text()

// Untrusted/user-supplied args — still use execFileNoThrow to prevent injection:
import { execFileNoThrow } from '../utils/execFileNoThrow.js'
const result = await execFileNoThrow('aws', ['cloudformation', 'deploy', '--stack-name', userProvidedName])
```

Key differences:
- `Bun.$` is async (must `await`)
- Error: throws `ShellError` with `.stderr` and `.exitCode` properties
- Capturing output: `.text()`, `.json()`, `.blob()`
- Quiet mode: `.quiet()` suppresses stdout
- Environment: `.env({ KEY: 'val' })`
- Use `execFileNoThrow` from `src/utils/execFileNoThrow.ts` for any argument derived from user input

**fs → Bun.file/write**

Before:
```typescript
import { readFileSync, writeFileSync, existsSync } from 'fs'
const content = readFileSync(path, 'utf-8')
writeFileSync(path, data, 'utf-8')
const exists = existsSync(path)
```

After:
```typescript
const content = await Bun.file(path).text()        // or .json() for JSON files
await Bun.write(path, data)
const exists = await Bun.file(path).exists()       // boolean
```

Key differences:
- All async
- `Bun.file(path).json()` handles JSON parse in one call
- `Bun.write` creates parent directories automatically (verify or use `mkdir -p` if not)

**chalk → ANSI escapes**

Before:
```typescript
import chalk from 'chalk'
console.log(chalk.green.bold('Success!'))
console.log(chalk.red('Error: ' + message))
```

After (using `packages/cli/src/lib/color.ts` wrapper):
```typescript
import { color } from './lib/color.js'
console.log(color.bold(color.green('Success!')))
console.log(color.red('Error: ' + message))
```

Note: `Bun.color('green', 'ansi')` is the official API but returns hex by default; for terminal output, raw ANSI escapes or a minimal wrapper is cleaner.

**dotenv → auto loading**

Before:
```typescript
import * as dotenv from 'dotenv'
dotenv.config()
```

After: Delete the import entirely. Bun automatically loads `.env`, `.env.local`, `.env.{NODE_ENV}` files. No code change required — just remove the import and uninstall the package.

**glob → Bun.Glob**

Before:
```typescript
import { glob } from 'glob'
const files = await glob('src/**/*.ts')
```

After:
```typescript
const g = new Bun.Glob('src/**/*.ts')
const files = Array.from(g.scanSync('.'))  // sync
// or async:
const files = []
for await (const file of g.scan('.')) files.push(file)
```

### 3. Hono vs Bun.serve() Analysis

Document in `docs/research/hono-vs-bun-serve.md`:

**Feature comparison table:**

| Feature | Hono | Bun.serve() |
|---|---|---|
| Routing | Built-in, declarative | Manual (URL.pathname switch) |
| Middleware | Middleware chain (.use()) | Manual composition |
| Request validation | @hono/zod-validator | Manual |
| WebSocket | hono/ws adapter | Native Bun.serve({ websocket }) |
| Testing | createAdaptorServer + supertest | Direct fetch(server.url, ...) |
| Bundle size | ~13kB minified | 0 (built-in) |
| TypeScript | First-class types | No dedicated types |
| Portability | Works on Node, Bun, CF Workers, Deno | Bun only |
| SSE | streamSSE helper | Manual ReadableStream |
| OpenAPI/docs | @hono/swagger-ui | Manual |

**Performance**: Hono on Bun has negligible overhead vs raw Bun.serve() for typical API payloads. Reference Hono's own benchmarks if available.

**Recommendation**: **Keep Hono**. The middleware ecosystem, TypeScript ergonomics, and portability (run under Node in CI if needed) outweigh the marginal performance gain of raw Bun.serve(). Document `Bun.serve()` as a future option if we ever need WebSocket-heavy features (Hono's WS adapter adds overhead).

### 4. Future Bun Feature Opportunities

Document in the audit with effort estimate and recommended timeline:

| Feature | Bun API | Use Case | Effort | When |
|---|---|---|---|---|
| SQLite local state | `bun:sqlite` | CLI session history cache, skill catalog cache | S | Stream 4 |
| Password hashing | `Bun.password` | Future: local credential storage hardening | XS | Future |
| Semver comparison | `Bun.semver` | Skill version management (>=1.2.0 constraints) | XS | Future |
| S3 client | `Bun.S3` | Direct S3 operations in CLI (deploy, sync) | M | After AWS SDK v3 audit |
| Redis client | `Bun.redis` | Caching layer if we add Redis to the stack | M | Future |

### 5. Cleanup Items

During the audit, identify and remove unused dependencies:

**`packages/chat-gateway/package.json`**:
- Verify `express` and `@types/express` are still in devDeps after Hono migration
- Remove if present (Hono replaced Express; see ADR-019)

**`packages/cli/package.json`**:
- Remove `@types/chalk` when chalk is removed

**All packages**: Run `bunx depcheck` to find unused dependencies (add to audit findings).

Document total dependency reduction count (before vs after).

## Acceptance Criteria

- [ ] `docs/research/bun-migration-guide.md` exists with before/after examples for: jest→bun:test, subprocess→Bun.$, fs→Bun.file/write, chalk→ANSI, dotenv→auto
- [ ] `docs/research/hono-vs-bun-serve.md` exists with feature comparison table and recommendation
- [ ] Dependency replacement map table covers all packages (confirmed via `jq` audit of package.json files)
- [ ] `express` and `@types/express` are removed from `packages/chat-gateway/package.json`
- [ ] Net dependency reduction count is documented
- [ ] Future Bun opportunities table has at least 4 entries with effort estimates

## Test Requirements

This stream is documentation-only. No code tests required.

Quality check: Run the before/after code examples through `bunx tsc --noEmit` (TypeScript type check) to verify they are syntactically correct. Document any that don't typecheck (version-specific APIs).

## Dependencies on Other Streams

- **None** — pure research/documentation. Can start immediately and should run in parallel with Stream 1.
- Stream 4 depends on this stream's output for the complete replacement map.

## Risk Assessment

- **Low**: Documentation-only stream — no production code changes
- **Low**: Some Bun APIs are version-specific — verify against pinned `BUN_VERSION: 1.3.11` (see mulch record `gh-actions-bun-version-pinning`)
- **Note**: `Bun.color`, `Bun.S3`, `Bun.redis` availability depends on Bun version — verify each API exists in 1.3.11 before recommending it as immediate-term
