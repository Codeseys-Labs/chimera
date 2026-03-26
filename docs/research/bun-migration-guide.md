---
title: "Bun Migration Guide: Node.js APIs to Bun Built-ins"
status: canonical
version: 1.0.0
last_updated: 2026-03-26
references: [ADR-029]
---

# Bun Migration Guide: Node.js APIs to Bun Built-ins

> **Audience:** Chimera engineers migrating CLI and gateway code from Node.js stdlib + npm packages to Bun built-in equivalents.
> **Bun version:** 1.3.11 (pinned via `BUN_VERSION` in all CI workflows)
> **Status:** Research document — see `docs/specs/stream-5-bun-feature-audit.md` for the full replacement map.

---

## Dependency Replacement Map

| Current Dependency | Bun Built-in | Affected Packages | Effort | Status |
|---|---|---|---|---|
| `chalk` | ANSI escape codes | `packages/cli` | S | Future — code exists, planned removal |
| `jest` + `ts-jest` + `@types/jest` | `bun:test` | All packages | M | Future — test runner migration |
| `child_process` (subprocess) | `Bun.$` | `packages/cli` | S | Future — deploy/destroy commands |
| `fs` (readFileSync/writeFileSync) | `Bun.file()` / `Bun.write()` | `packages/cli` | S | Future — config/source utilities |
| `dotenv` | Auto `.env` loading | All | XS | Not present (never installed) |
| `glob` / `fast-glob` | `Bun.Glob` | None found | — | Not currently used |
| `express` + `@types/express` | REMOVED (Hono migration complete) | `packages/chat-gateway` | XS | **Done** — removed this stream |
| `@types/chalk` | REMOVED (with chalk removal) | `packages/cli` | XS | **Done** — removed this stream |
| `supertest` | `bun test` + `createAdaptorServer` | `packages/chat-gateway` | S | Partial — supertest kept; bun:test migration future |

Effort scale: XS = < 30 min, S = < 2 hours, M = < 1 day, L = multi-day

---

## 1. Jest to bun:test

### Before (Jest)

```typescript
// jest.config.js (delete this file entirely when migrating)
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
};

// In test files:
import { describe, it, expect } from '@jest/globals';
import { jest } from '@jest/globals';

jest.mock('../module', () => ({ fn: jest.fn() }));
const spy = jest.spyOn(obj, 'method');
jest.clearAllMocks();
```

### After (bun:test)

```typescript
// No config file needed — Bun auto-discovers *.test.ts files.
// For custom config, add to bunfig.toml:
// [test]
// timeout = 30000
// preload = ["./tests/setup.ts"]

// In test files:
import { describe, it, expect, mock, spyOn } from 'bun:test';

// GOTCHA: factory parameter is REQUIRED in Bun
mock.module('../module', () => ({ fn: mock(() => undefined) }));
const spy = spyOn(obj, 'method');
mock.restore(); // Replaces jest.clearAllMocks()
```

### Key Differences

| Jest | bun:test | Notes |
|---|---|---|
| `jest.fn()` | `mock(() => ...)` | Factory arg required in Bun (see below) |
| `jest.spyOn(obj, 'method')` | `spyOn(obj, 'method')` | Same API, different import |
| `jest.clearAllMocks()` | `mock.restore()` | Or `.mockReset()` per-mock |
| `jest.mock(path)` | `mock.module(path, factory)` | Factory is required |
| `jest.resetModules()` | Not needed | Bun reloads modules fresh per test file |
| `__snapshots__/` dir | Same dir as test file | `.snap` extension preserved |
| `jest.config.js` | Delete | Bun auto-discovers tests |

### Critical Gotcha: Mock Factory Required

In Jest, `jest.mock('../path')` auto-mocks a module. **In Bun, `mock.module()` requires an explicit factory function** — auto-mocking is not supported.

```typescript
// Fails in Bun (missing factory)
mock.module('../aws-client');

// Correct
mock.module('../aws-client', () => ({
  DynamoDBClient: mock(() => ({
    send: mock(() => Promise.resolve({ Items: [] })),
  })),
}));
```

### Running Tests

```bash
# Jest (before)
npx jest
npx jest --watch
npx jest --coverage

# bun:test (after)
bun test
bun test --watch
bun test --coverage
bun test packages/cli/src       # Run specific directory
bun test --timeout 30000        # Custom timeout (default 5s)
```

> **Timeout note:** CDK tests synthesizing stacks with many Lambdas routinely exceed the 5s default. Set `timeout = 30000` in `bunfig.toml` or pass `--timeout 30000`.

---

## 2. Subprocess Spawning to Bun.$

### Before (Node child_process)

```typescript
import { execSync, execFileSync, spawnSync } from 'child_process';

// Simple command
const account = execSync(
  'aws sts get-caller-identity --query Account --output text',
  { encoding: 'utf8' }
).trim();

// File args passed as array (injection-safe)
execFileSync('git', ['clone', '--depth=1', remoteUrl, destDir], { stdio: 'inherit' });

// spawnSync pattern
const result = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: sourcePath,
  encoding: 'utf8',
});
if (result.status !== 0) throw new Error(result.stderr);
const sha = result.stdout.trim();
```

### After (Bun.$)

```typescript
// Simple command — template literal (safe for app-controlled strings)
const account = await Bun.$`aws sts get-caller-identity --query Account --output text`
  .text();
// .text() trims trailing newline automatically

// Capture stdout, suppress echo to parent terminal
const sha = await Bun.$`git rev-parse HEAD`
  .cwd(sourcePath)
  .quiet()
  .text();

// Error handling — Bun.$ throws ShellError on non-zero exit
try {
  await Bun.$`git clone --depth=1 ${remoteUrl} ${destDir}`;
} catch (err) {
  // err.exitCode: number
  // err.stderr: Buffer (call .toString() for string)
  throw new Error(`git clone failed: ${err.stderr.toString()}`);
}

// JSON output
const identity = await Bun.$`aws sts get-caller-identity`.json<{ Account: string }>();
console.log(identity.Account);
```

### Security: User-supplied Args

**Do NOT embed user-supplied strings directly in `Bun.$` template literals** — this is equivalent to shell injection. Use `execFileNoThrow` from `src/utils/execFileNoThrow.ts` for any argument derived from user input:

```typescript
// Shell injection risk — do not use this pattern
const stackName = getUserInput();
// await Bun.$`aws cloudformation deploy --stack-name ${stackName}`;

// Safe — execFileNoThrow passes args as array (no shell interpolation)
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
const result = await execFileNoThrow('aws', [
  'cloudformation', 'deploy',
  '--stack-name', stackName,
  '--template-body', templateBody,
]);
```

`Bun.$` template literals ARE safe when the values are application-controlled (e.g., a path returned by `mkdtemp`, a hardcoded region). They are unsafe when the value comes from user input, environment variables set by users, or external APIs.

### Key Differences

| child_process | Bun.$ | Notes |
|---|---|---|
| Synchronous by default | `async` — must `await` | Biggest ergonomic change |
| `stdout.toString()` | `.text()` | Also `.json()`, `.blob()`, `.arrayBuffer()` |
| `stdio: 'pipe'` vs `'inherit'` | `.quiet()` to suppress | Default prints to parent stdout |
| `{ encoding: 'utf8' }` | `.text()` returns string | No encoding option needed |
| `{ env: { ... } }` | `.env({ ... })` | Merges with process.env by default |
| `{ cwd: dir }` | `.cwd(dir)` | Chainable |
| Non-zero exit: check status field | Non-zero exit: throws `ShellError` | Use `try/catch` |

---

## 3. fs to Bun.file / Bun.write

### Before (Node fs)

```typescript
import * as fs from 'fs';

// Read text
const content = fs.readFileSync(configPath, 'utf-8');

// Read JSON
const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Write text/JSON
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');

// Check existence
const exists = fs.existsSync(configPath);

// Create directory
fs.mkdirSync(dir, { recursive: true });
```

### After (Bun.file / Bun.write)

```typescript
// Read text
const content = await Bun.file(configPath).text();

// Read JSON — one call, no JSON.parse needed
const config = await Bun.file(configPath).json<WorkspaceConfig>();

// Write text
await Bun.write(configPath, JSON.stringify(config, null, 2));

// Check existence
const exists = await Bun.file(configPath).exists();

// Create directory — still use fs.mkdirSync (no Bun.mkdir built-in in 1.3.11)
import { mkdirSync } from 'fs';
mkdirSync(dir, { recursive: true });
```

### Key Differences

| fs | Bun.file/write | Notes |
|---|---|---|
| `readFileSync` | `await Bun.file(p).text()` | All async |
| `writeFileSync` | `await Bun.write(p, data)` | Creates parent dirs if needed |
| `existsSync` | `await Bun.file(p).exists()` | Returns boolean |
| `JSON.parse(readFileSync(...))` | `await Bun.file(p).json()` | Direct JSON parse |
| Synchronous | Asynchronous | Must `await` |

> **Mixed usage during migration:** It is safe to mix `fs` and `Bun.file` calls in the same file during incremental migration. Both access the same filesystem.

---

## 4. chalk to ANSI Escape Codes

### Before (chalk v5)

```typescript
import chalk from 'chalk';

console.log(chalk.green('Success!'));
console.log(chalk.red('Error: ' + message));
console.log(chalk.yellow('Warning'));
console.log(chalk.blue('Info'));
console.log(chalk.bold.underline('Section Header'));
console.log(`${chalk.bold('key')}: value`);
console.log(chalk.gray('debug message'));
```

### After (ANSI escape codes)

```typescript
// packages/cli/src/lib/color.ts — create this wrapper when removing chalk
const ESC = '\x1b[';
const isTTY = process.env.NO_COLOR == null && Boolean(process.stdout.isTTY);
const c = (code: string, s: string) => isTTY ? `${ESC}${code}m${s}${ESC}0m` : s;

export const color = {
  reset:     (s: string) => c('0', s),
  bold:      (s: string) => c('1', s),
  underline: (s: string) => c('4', s),
  red:       (s: string) => c('31', s),
  green:     (s: string) => c('32', s),
  yellow:    (s: string) => c('33', s),
  blue:      (s: string) => c('34', s),
  gray:      (s: string) => c('90', s),
};

// Usage
import { color } from './lib/color.js';

console.log(color.green('Success!'));
console.log(color.red('Error: ' + message));
console.log(color.yellow('Warning'));
console.log(color.blue('Info'));
console.log(color.bold(color.underline('Section Header')));
console.log(`${color.bold('key')}: value`);
console.log(color.gray('debug message'));
```

### Key Differences

| chalk | ANSI wrapper | Notes |
|---|---|---|
| `chalk.bold.underline(s)` | `color.bold(color.underline(s))` | Nesting via function calls |
| `chalk.green.bold(s)` | `color.bold(color.green(s))` | Order reversal is intentional |
| Auto-detects TTY | `NO_COLOR` + `isTTY` check | Handled in wrapper constructor |
| Template literals: chalk`text` | Not supported | Use function call style |

> **`Bun.color()` note:** `Bun.color('green', 'ansi')` is available in Bun 1.x but returns hex by default; the `'ansi'` format option may not be available in 1.3.11. Raw ANSI sequences in a thin wrapper are more reliable and have zero runtime overhead.

---

## 5. dotenv to Bun Auto-loading

### Before (dotenv)

```typescript
import * as dotenv from 'dotenv';
dotenv.config();
```

### After (nothing — Bun handles it)

Delete the import entirely. Bun automatically loads `.env` files at startup in this priority order:

1. `.env.{NODE_ENV}.local`
2. `.env.local`
3. `.env.{NODE_ENV}`
4. `.env`

### Key Differences

| dotenv | Bun auto-loading | Notes |
|---|---|---|
| Manual import + config call | Automatic | No code required |
| `dotenv.config({ path: '...' })` | Not configurable per-call | Fixed load order |
| Works under Node | Bun only | Tests under Node need dotenv if ever run there |
| npm dependency | Built-in | Remove from package.json |

> **Note for this repo:** `dotenv` was not found in any `package.json` — it was never installed. Simply do not install it when writing new code.

---

## 6. glob to Bun.Glob

### Before (glob / fast-glob)

```typescript
import { glob } from 'glob';
const files = await glob('src/**/*.ts', { ignore: ['**/*.test.ts'] });
```

### After (Bun.Glob)

```typescript
// Sync scan — wrap in Array.from() for an array
const g = new Bun.Glob('src/**/*.ts');
const allFiles = Array.from(g.scanSync('.'));

// Bun.Glob has no built-in ignore — filter afterward
const nonTest = allFiles.filter(f => !f.includes('.test.'));

// Async scan
const files: string[] = [];
for await (const file of g.scan('.')) files.push(file);

// Test a single path (no filesystem access)
const isTypeScript = new Bun.Glob('**/*.ts').match('src/index.ts'); // true
```

### Key Differences

| glob | Bun.Glob | Notes |
|---|---|---|
| Returns `string[]` promise | Returns Iterator/AsyncIterator | Wrap in `Array.from()` for array |
| Built-in `ignore` patterns | Filter manually after scan | No ignore option |
| Cross-runtime | Bun only | |
| npm dependency | Built-in | Remove from package.json |

> **Note for this repo:** `glob` and `fast-glob` are not in any package.json. Use `Bun.Glob` in any new CLI code that needs file globbing.

---

## 7. Future Bun Feature Opportunities

Features in Bun 1.3.11 worth adopting in future streams:

| Feature | API | Use Case | Effort | Stream |
|---|---|---|---|---|
| SQLite local state | `bun:sqlite` | CLI session history cache, skill catalog | S | Stream 4 |
| Password hashing | `Bun.password` | Future local credential storage hardening | XS | Future |
| Semver comparison | `Bun.semver` | Skill version constraint checking (`>=1.2.0`) | XS | Future |
| S3 client | `Bun.S3` | Direct S3 ops in CLI deploy/sync | M | After AWS SDK v3 audit |
| Redis client | `Bun.redis` | Caching layer if Redis added to the stack | M | Future |

> **Version check:** Verify each API's availability in the pinned Bun version before implementing. `Bun.S3`, `Bun.redis`, `Bun.semver` were introduced in different minor releases.

---

## Depcheck Findings (Stream 5 Audit)

Running `bunx depcheck` across all packages:

### Removed This Stream

| Package | Removed | Reason |
|---|---|---|
| `packages/chat-gateway` | `express` | Hono replaced Express (ADR-019); express lingered in devDeps |
| `packages/chat-gateway` | `@types/express` | Types for removed express |
| `packages/cli` | `@types/chalk` | chalk v5 is ESM with bundled types — `@types/chalk` is redundant |

**Net reduction: 3 devDependencies removed.**

### Future Cleanup (Out of Scope for Stream 5)

| Package | Unused Dep | Replacement |
|---|---|---|
| `packages/chat-gateway` | `jest`, `ts-jest`, `@types/jest` | `bun:test` (Stream 4/6) |
| `packages/cli` | `jest`, `ts-jest`, `@types/jest` | `bun:test` (Stream 4/6) |
| `packages/shared` | `jest`, `ts-jest`, `@types/jest` | `bun:test` (Stream 4/6) |
| `packages/sse-bridge` | `jest`, `ts-jest`, `@types/jest` | `bun:test` (Stream 4/6) |
| `packages/cli` | `chalk` (runtime dep) | ANSI wrapper (Stream 4) |

Full jest-to-bun:test migration (removing `jest`, `ts-jest`, `@types/jest` from 5 packages + migrating ~20 test files) is a Stream 4/6 task.

> **False positives:** `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, and `aws-cdk` appear as "unused" in depcheck output because they are loaded indirectly (via `.eslintrc` config and `infra/cdk.json`). Do not remove them.
