---
title: "chimera-a272 — TOCTOU guard on parentCommitId"
status: design
last_updated: 2026-04-27
---

# chimera-a272 — TOCTOU guard on parentCommitId

## Problem

`pushToCodeCommit` (packages/cli/src/utils/codecommit.ts:322-333) reads
`parentCommitId` via `GetBranch` exactly once and then chains N sequential
`CreateCommit` calls using each response's `commitId` as the next parent. Two
concurrent `chimera deploy` runs observe the same tip, and the second deploy's
mid-loop `CreateCommit` lands against a stale parent — CodeCommit rejects it
with `ParentCommitIdRequiredException`, or worse, silently orphans the first
deploy's commits. Per `docs/research/chimera-5000-push-architecture.md` §4,
`parentCommitId` *is* CodeCommit's only concurrency condition.

## Chosen fix: refresh parent before each batch

Refresh `parentCommitId` via `GetBranch` immediately before each
`CreateCommit`. If the tip has advanced between batches (another deploy
landed), re-point the chain at the new tip so this deploy continues on top of
it. Cost is one extra `GetBranch` per batch — pacing is already handled by
the module-level token bucket, so steady-state TPS stays the same.

## Snippet (≤30 LOC) — team-lead to paste

Insert **before line 355** of `codecommit.ts` (i.e. immediately before the
existing `try { const createCommitResult = await withThrottleRetry(...) }`
block, inside the `for (let i = 0; i < batches.length; i++)` loop):

```ts
// TOCTOU guard (chimera-a272): refresh tip before each CreateCommit.
// A concurrent deploy may have advanced the branch since our initial
// GetBranch or since our previous CreateCommit. Without this refresh,
// batch i+1 is sent with a stale parentCommitId and CodeCommit rejects
// it with ParentCommitIdRequiredException.
try {
  const freshBranch = await withThrottleRetry(() =>
    client.send(new GetBranchCommand({ repositoryName: repoName, branchName })),
  );
  const freshTip = freshBranch.branch?.commitId;
  if (freshTip && freshTip !== parentCommitId) {
    console.log(
      color.yellow(
        `  Branch tip advanced (concurrent deploy) — re-pointing parent ${parentCommitId} → ${freshTip}`,
      ),
    );
    parentCommitId = freshTip;
  }
} catch (error: any) {
  if (error.name !== 'BranchDoesNotExistException') throw error;
}
```

## Alternative considered: retry-on-exception

Catch `ParentCommitIdRequiredException` in the existing `catch` block, call
`GetBranch` again, then re-send. Worse because: (a) it's reactive in a loop —
every batch can race again on the retry, risking unbounded/nested retries,
(b) it complicates `withThrottleRetry` with a second axis of retry semantics,
and (c) silent-stomp is still possible if the API ever admits a stale parent
(proactive refresh catches this case; retry-on-exception can't).

## Test plan

`packages/cli/src/__tests__/codecommit-toctou.test.ts` mocks
`CodeCommitClient.send` to stage the race: after the first `CreateCommit`
returns, the simulated server tip jumps to `commitC_from_concurrent_deploy`.
Two tests:

1. **reproducer** — permissive mock accepts any parent for both
   `CreateCommit` calls; asserts the race was actually staged (tip advanced
   mid-loop). Passes on current HEAD AND after the fix.
2. **acceptance** — strict mock rejects any `CreateCommit` carrying a stale
   parent with `ParentCommitIdRequiredException`; asserts the push completes
   and batch 2's parent is the refreshed tip. **Currently FAILS on HEAD** —
   that failure IS the TOCTOU reproducer. Turns green when the snippet
   above is pasted, and stays green as a regression guard.

Verified locally by temporarily applying the snippet and running the file:
both tests pass with the fix, only the reproducer passes without it.
