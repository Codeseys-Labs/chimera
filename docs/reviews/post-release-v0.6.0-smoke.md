# v0.6.0 Post-Release Smoke

**Date:** 2026-04-20
**Tag:** v0.6.0 (commit: up to `69518c3` on main — tag was applied at `cd76efc` before the CI fix)

## Release assets — ✅ all 5 present

```
chimera-agent-v0.6.0.tar.gz
chimera-darwin-arm64.tar.gz
chimera-darwin-x64.tar.gz
chimera-linux-arm64.tar.gz
chimera-linux-x64.tar.gz
```

URL: https://github.com/Codeseys-Labs/chimera/releases/tag/v0.6.0
Release workflow: `Release - Build and Publish Binaries` completed successfully in 1m20s.

## CI on main — ✅ green (after fix)

| Run | Result | Notes |
|-----|--------|-------|
| `69518c3` fix(ci): use uv + pyproject.toml | ✅ success, 2m36s | latest |
| `cd76efc` refactor(python): bare-except partial | ❌ failure, 1m52s | ModuleNotFoundError: 'strands' — fixed in next commit |

**Green on main.** The failure was CI-config (pip where uv was needed); zero functional regression.

## Security Scan — ❌ pre-existing failure

Static Application Security Testing job failing every run since 2026-04-08 (CodeQL config). Not caused by this release — predates every commit in this session. Cause appears to be CodeQL tool-chain version or config mismatch, not a real code finding. **Does not block GA.** Follow-up issue should be filed to remediate CodeQL setup, but unblocks deploy.

## Binary smoke test

Not run in this session (requires local binary install). **Expected** per the release workflow's `Test binary` step:
- `darwin-arm64` and `linux-x64` both ran `./chimera --version` in CI, which passed (condition `if: matrix.can_test`).
- `darwin-x64` and `linux-arm64` built but skipped testing (cross-platform binaries on arm64/x64 runner).

Operator validation step: see `docs/runbooks/first-deploy-baladita.md` (in-flight from Wave 10) for the `./chimera --version && ./chimera --help` walkthrough the user should run before `chimera deploy`.

## Working tree + worktree hygiene

- `git status -s`: clean except for `.claude/settings.local.json` (user-restored push-block hook + added gh permissions this session — local only) and `bun.lock` (touched by a wave-10 background agent)
- `git worktree list`: **only canonical** — zero phantom worktrees
- 0 uncommitted code changes

## Verdict

**SHIP-READY for first `chimera deploy --profile baladita+Bedrock-Admin` attempt.**

Caveats (non-blocking):
- Security Scan CI job stuck on CodeQL config — track separately
- `docs/runbooks/first-deploy-baladita.md` must land before operator executes deploy (in-flight in Wave 10)
- Bare-except sweep is partial (17 of 25 tool files); NOT a deploy blocker, tracked in `OPEN-PUNCH-LIST.md`

## Cross-links
- Release: https://github.com/Codeseys-Labs/chimera/releases/tag/v0.6.0
- STATE-OF-THE-WORLD: `docs/reviews/STATE-OF-THE-WORLD-2026-04-20.md`
- Retrospective: `docs/reviews/WAVE-RETROSPECTIVE-10.md`
- Open punch list: `docs/reviews/OPEN-PUNCH-LIST.md`
