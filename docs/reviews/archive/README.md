# docs/reviews/archive/

Historical wave-specific audit docs moved here to keep `docs/reviews/` focused
on living strategic documents (STATE-OF-THE-WORLD, FINAL-REPORT, SYNTHESIS,
OPEN-PUNCH-LIST, WAVE-RETROSPECTIVE-13, wave14-system-audit,
wave15-concurrent-review).

Closes cleanup item #12 in [../OPEN-PUNCH-LIST.md](../OPEN-PUNCH-LIST.md).

## Contents

| File | Wave | Scope |
|------|------|-------|
| `wave4-architecture-coherence.md` | 4 | Cross-stack architecture coherence sweep |
| `wave4-python-runtime-audit.md` | 4 | Python runtime / agent-container audit |
| `wave4-ts-audit.md` | 4 | TypeScript monorepo audit |
| `wave7-doc-drift-audit.md` | 7 | Documentation drift identification |
| `wave7-safety-audit.md` | 7 | Safety / guardrail audit |
| `wave9-post-commit-smoke-audit.md` | 9 | Post-commit smoke verification |

## Not archived

Retained in `docs/reviews/` because still actively referenced from
`docs/MIGRATION-registry.md` and the agentcore-rabbithole dossier:

- `wave4-registry-migration-delta.md` — 6-phase Registry migration plan.

## Rationale

Findings from these docs are either (a) closed in git history, (b) consolidated
into `OPEN-PUNCH-LIST.md`, or (c) superseded by a later wave's retrospective.
They remain in-tree (not deleted) for audit traceability and because
`WAVE-RETROSPECTIVE-12.md` still links `previous: WAVE-RETROSPECTIVE-10.md`.
