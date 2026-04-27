---
title: "chimera-5000: CodeCommit Push Architecture — SDK vs git"
version: 1.0.0
status: research
last_updated: 2026-04-27
---

# SHIP: Option A — keep batched `CreateCommit` + token bucket, defer Option B

The Wave-30 token bucket (2 TPS sustained, 5 burst) + 6-attempt full-jitter backoff
covering `ThrottlingException | RequestLimitExceeded | LimitExceededException |
TooManyRequestsException | 429 | "Rate exceeded"` implements verbatim the
AWS-recommended remediation in [troubleshooting-ae](https://docs.aws.amazon.com/codecommit/latest/userguide/troubleshooting-ae.html).
No evidence the per-account CreateCommit ceiling is below 2 TPS; CodeCommit's
quota page publishes no TPS number and AWS's fix is "jitter + backoff +
quota increase." Fix 1 is sufficient. Add Option B later as an opt-in.

## 1. Performance
A `git push` to CodeCommit is a single TCP connection carrying one pack-objects
transfer (smart-HTTP v2). Server-side rate limiting is per-request, not
per-commit: one pack = one authenticated request, so 67 file changes incur one
throttle slot vs 67 `CreateCommit` slots today. Expected latency for ~67 files
is 2–5 s vs ~30–60 s for batched SDK pushes pacing at 2 TPS.

## 2. Dependency story
- **grc** requires `pip install git-remote-codecommit` + Python 3.6+ + AWS CLI
  ([setting-up-git-remote-codecommit](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-git-remote-codecommit.html)).
  Unshippable inside a single `bun build --compile` binary.
- **Credential helper** is bundled in `aws` CLI (`aws codecommit credential-helper $@`);
  no pip dep ([setting-up-https-unixes](https://docs.aws.amazon.com/codecommit/latest/userguide/setting-up-https-unixes.html)).
  Shellout-viable if the user already has `git` + `aws` on PATH.

## 3. Error model
`git push` throttles surface as non-zero exit with stderr error (not a hang);
the underlying HTTP layer returns the same 429 our retry catches. No direct
`RequestLimitExceeded` equivalent — native git clients don't auto-retry, so
we'd still wrap the spawn with our existing retry.

## 4. Fetch-first semantics
Yes — `git push` is safer for concurrent deploys. It fails fast with
`non-fast-forward` when someone else pushed, forcing an explicit fetch/merge.
Our current `parentCommitId`-from-`GetBranch` is TOCTOU-vulnerable: two
parallel `chimera deploy`s read the same tip and one loses silently.

## 5. Bun compile constraint
`bun build --compile` binaries can spawn `git` via `Bun.spawn` / `child_process`
with full stdio piping and PATH resolution ([Bun subprocess docs via DeepWiki](https://deepwiki.com/search/can-a-standalone-binary-built_5736639c-53ac-4db2-83b9-4aa233f852ed)).
No known compile-time limitations.

## 6. Recommendation
**Ship Option A now.** Token bucket + backoff matches AWS's authoritative
remediation; zero prereq burden. **Add Option B as a follow-up** (`chimera
deploy --use-git` detects `git` + credential helper, falls back to
CreateCommit): ~10x faster pushes, coalesce-safe, no user-visible breakage.
**Reject Option C** — breaks zero-prereq install story.
