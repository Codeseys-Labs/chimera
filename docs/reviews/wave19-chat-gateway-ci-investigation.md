---
title: "Wave-19 — Chat-gateway CI exclusion root cause"
wave: 19
issue: chimera-cc6f
status: fixed
last_updated: 2026-04-24
---

# Wave-19 — Chat-gateway CI exclusion root cause

## TL;DR

The comment in `.github/workflows/ci.yml` excluding `packages/chat-gateway/`
blamed "Bun CJS/ESM compat with `@aws-sdk/lib-dynamodb`". **That diagnosis was
wrong.** The actual problem was a test-isolation bug inside the chat-gateway
suite itself: an incomplete `mock.module('@aws-sdk/lib-dynamodb', ...)` stub in
`persistence-session.test.ts` was polluting Bun's process-global module cache
and breaking three sibling route tests (Teams, Discord, Telegram) that run
later in the same process.

Fixed in Wave-19 by making the mock expose every command class the codebase
imports from `@aws-sdk/lib-dynamodb`. Tests re-enabled in CI.

## Symptom

`cd packages/chat-gateway && bun test` produced:

```
src/__tests__/routes/teams.test.ts:

# Unhandled error between tests
-------------------------------
1 | })
2 | {
    ^
SyntaxError: Export named 'QueryCommand' not found in module
'.../node_modules/.bun/@aws-sdk+lib-dynamodb@3.1018.0+.../
node_modules/@aws-sdk/lib-dynamodb/dist-cjs/index.js'.
      at loadAndEvaluateModule (2:1)
...
 178 pass
 5 skip
 3 fail
 3 errors
```

Three route test files failed identically (teams, discord, telegram), each
reporting that `QueryCommand` could not be imported from the CJS entrypoint of
`@aws-sdk/lib-dynamodb`.

## Why the original "CJS/ESM compat" diagnosis was plausible but wrong

The error message points at `dist-cjs/index.js`, and `@aws-sdk/lib-dynamodb`
ships both `main` (CJS) and `module` (ESM) entrypoints with no modern
`exports` field. It's reasonable to suspect Bun's module resolver. However:

1. `dist-cjs/index.js` **does** correctly export `QueryCommand`:
   ```
   $ grep -n "QueryCommand" .../dist-cjs/index.js
   399:class QueryCommand extends DynamoDBDocumentClientCommand {
   830:exports.QueryCommand = QueryCommand;
   ```
2. Running the three failing files together in isolation
   (`bun test src/__tests__/routes/teams.test.ts discord.test.ts telegram.test.ts`)
   produced **46 pass / 0 fail** — no CJS/ESM issue whatsoever.
3. Running `persistence-session.test.ts` *before* any route test reliably
   reproduced the "Export named 'QueryCommand' not found" error, even for a
   single route file.

## Actual root cause

`packages/chat-gateway/src/__tests__/persistence-session.test.ts` contained:

```ts
mock.module('@aws-sdk/lib-dynamodb', () => {
  class PutCommand  { /* ... */ }
  class UpdateCommand { /* ... */ }
  class GetCommand  { /* ... */ }
  return {
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
    PutCommand, UpdateCommand, GetCommand,
  };
});
```

Three relevant facts about Bun's test runner:

1. **`mock.module` mutates a process-global module registry.** Once called, the
   mock persists for the rest of the `bun test` run, across every subsequent
   `.test.ts` file in the same process.
2. **Bun runs test files in a single process by default** (no per-file
   isolation unless you opt in).
3. When a later file evaluates an import chain like
   `import teamsRouter from '../../routes/teams'` →
   `import { createAgent } from '@chimera/core'` →
   `export * from './skills/registry'` →
   `import { ..., QueryCommand } from '@aws-sdk/lib-dynamodb'`,
   Bun serves the **cached mock module**. Because the mock only named
   `PutCommand`, `UpdateCommand`, `GetCommand`, and
   `DynamoDBDocumentClient`, resolving `QueryCommand` against it failed with
   `SyntaxError: Export named 'QueryCommand' not found`.

The error pointed at `dist-cjs/index.js` not because that file was being
evaluated, but because that path was baked into the module's internal
identity at first resolution, before `mock.module` replaced its exports.

Key corroborating evidence:

- The mock deliberately omitted `QueryCommand` — the test author only needed
  the three commands `persistence-listener.ts` actually invokes.
- `chat-gateway/src/routes/chat.ts` is the sole file in the suite that
  imports `QueryCommand`: `import { DynamoDBDocumentClient, QueryCommand }
  from '@aws-sdk/lib-dynamodb';`.
- Teams/Discord/Telegram routes don't import `chat.ts` directly, but they
  all `import { createAgent, createDefaultSystemPrompt } from '@chimera/core'`,
  and `@chimera/core`'s barrel export pulls in modules that need
  `QueryCommand` transitively (e.g. `auth/user-pairing.ts`,
  `billing/cost-tracker.ts`, `activity/decision-logger.ts`, etc.).

## Fix (landed Wave-19)

`packages/chat-gateway/src/__tests__/persistence-session.test.ts` —
extend the mock so every `@aws-sdk/lib-dynamodb` command class imported
anywhere in chimera (chat-gateway + `@chimera/core`) has a stub:

```ts
const makeCommand = (type: string) =>
  class {
    _type = type;
    input: any;
    constructor(input: any) { this.input = input; }
  };

mock.module('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  PutCommand: makeCommand('PutCommand'),
  UpdateCommand: makeCommand('UpdateCommand'),
  GetCommand: makeCommand('GetCommand'),
  // Previously missing — these are used by transitive imports via @chimera/core
  // and sibling routes (chat.ts → QueryCommand), not by persistence-listener itself.
  QueryCommand: makeCommand('QueryCommand'),
  DeleteCommand: makeCommand('DeleteCommand'),
  ScanCommand: makeCommand('ScanCommand'),
  BatchGetCommand: makeCommand('BatchGetCommand'),
  BatchWriteCommand: makeCommand('BatchWriteCommand'),
  TransactGetCommand: makeCommand('TransactGetCommand'),
  TransactWriteCommand: makeCommand('TransactWriteCommand'),
  ExecuteStatementCommand: makeCommand('ExecuteStatementCommand'),
  ExecuteTransactionCommand: makeCommand('ExecuteTransactionCommand'),
  BatchExecuteStatementCommand: makeCommand('BatchExecuteStatementCommand'),
}));
```

`.github/workflows/ci.yml` — add `./packages/chat-gateway/` to the `bun test`
path list and rewrite the exclusion comment to reflect the real root cause.

## Verification

```
$ cd packages/chat-gateway && bun test 2>&1 | tail -5
 224 pass
 8 skip
 0 fail
 402 expect() calls
Ran 232 tests across 13 files. [8.52s]
```

Before the fix: **178 pass / 3 fail / 3 errors**.
After the fix: **224 pass / 0 fail / 0 errors**.

## Lesson (for mulch)

**Bun's `mock.module` is a process-global module registry mutation.**
An incomplete stub in one test file will corrupt every subsequent file in the
same `bun test` run whose import graph reaches that module, even transitively.
Always enumerate every named export the broader codebase imports from a
mocked module — not just the ones the unit under test uses — or switch to
`mock.module(...)` with the real module spread (`...require('actual-module')`)
so missing names fall through to the real implementation.

Classification: `foundational` — confirmed failure mode for any multi-test
Bun project that mocks a widely-imported SDK module.
