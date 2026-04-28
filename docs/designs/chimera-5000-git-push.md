---
title: "chimera-5000: opt-in --use-git push path"
version: 1.0.0
status: design
last_updated: 2026-04-27
---

# Summary

Add `chimera deploy --use-git` as an **opt-in** alternative to the batched
`CreateCommit` path. Default stays batched (zero prereqs); `--use-git` trades
a `git` + `aws` CLI prereq for ~10x faster pushes and fail-fast concurrency
(non-fast-forward instead of TOCTOU loss). See
`docs/research/chimera-5000-push-architecture.md` for the full analysis.

## CLI surface

```
chimera deploy [--use-git]
```

- Flag is off by default.
- When set, CLI runs `detectGit()` + `detectAwsCredentialHelper()`. If
  either is missing, emit a single stderr warning and fall through to
  batched. No hard failure — user asked for faster, we best-effort deliver.
- Rationale for opt-in (not auto-detect): users with `git` + `aws` on PATH
  may still prefer batched for the no-surprises property
  (module-level token bucket, full-jitter retries).

## Implementation (utils/git-push.ts)

New file, no changes to `utils/codecommit.ts`. Exports:

- `detectGit()` — runs `git --version`, returns `{present, path?, version?}`.
- `detectAwsCredentialHelper()` — runs `aws --version`, returns `boolean`.
- `pushViaGit({repoUrl, branch, profile, region, sourceDir, onProgress})`
  — invokes `git -c credential.helper='!aws … codecommit credential-helper
  \$@' -c credential.UseHttpPath=true push <repoUrl> HEAD:<branch>` via
  `Bun.spawn` with `GIT_TERMINAL_PROMPT=0`. Streams stdout/stderr through
  `onProgress`. Parses `pushedSha` from stderr (`pushed: <sha>` marker or
  the default `<old>..<new>  HEAD -> branch` line). Throws with last 10
  stderr lines on non-zero exit.

The `SpawnFn` is injectable (`_spawn` option) so tests stub subprocess I/O
deterministically — real `Bun.spawn` stdout capture is known-flaky under
parallel `bun test` (see `commands/upgrade.test.ts` skip comments).

Caller contract: `sourceDir` must already be a git repo with a committed
HEAD. The caller is responsible for `git init && git add && git commit`
before invoking. This keeps `pushViaGit` a pure push primitive and lets
the caller choose how to stage content (real working tree, synthesized
temp clone, etc.).

## Wiring snippet for `utils/codecommit.ts` (owned by team-lead)

At SHA `dcfe90cb`, `pushToCodeCommit` starts at **line 295** with signature:

```ts
export async function pushToCodeCommit(
  client: CodeCommitClient,
  repoName: string,
  repoRoot: string,
  branchName: string = 'main',
  commitMessage?: string,
): Promise<string | undefined> {
```

Extend it with an `opts?: { useGit?: boolean; repoUrl?: string; region?: string; profile?: string }` parameter, then **insert at line 302** (before
`console.log('  Scanning repository files...')`):

```ts
if (opts?.useGit && opts.repoUrl && opts.region) {
  const { detectGit, detectAwsCredentialHelper, pushViaGit } = await import('./git-push.js');
  const git = await detectGit();
  const awsOk = await detectAwsCredentialHelper();
  if (git.present && awsOk) {
    console.log(color.gray(`  Using native git push (git ${git.version ?? 'unknown'})`));
    const res = await pushViaGit({
      repoUrl: opts.repoUrl,
      branch: branchName,
      profile: opts.profile,
      region: opts.region,
      sourceDir: repoRoot,
      onProgress: (l) => console.log(color.gray(`    ${l}`)),
    });
    return res.pushedSha || undefined;
  }
  console.warn(color.yellow(
    `  --use-git requested but ${!git.present ? 'git' : 'aws CLI'} not on PATH — falling back to batched CreateCommit`,
  ));
}
// else fall through to existing batched path (lines 302+ unchanged)
```

Fallback behavior: when `git` or `aws` is missing, emit a **yellow stderr
warning** naming the missing tool, then continue to the existing batched
loop. No hard failure. Users who passed `--use-git` on a machine without
git still get a successful deploy.

## Non-goals

- Caller-side staging (init/add/commit of `repoRoot`) — that belongs in
  `deploy.ts` (`@resume-builder`'s scope).
- Changing the default path to git. Option A stays default per the
  research doc's recommendation.
