---
title: 'ADR-036: Zod Schemas at the Shared-Type Boundary'
status: accepted
date: 2026-04-24
decision_makers: [chimera-architecture-team]
---

# ADR-036: Zod Schemas at the Shared-Type Boundary

## Status

**Accepted** (2026-04-24)

## Context

Chimera's `packages/shared/src/types/` exports TypeScript interfaces used across every package: `TenantConfig`, `Skill`, `AgentSession`, `AuditEvent`. TypeScript types are erased at runtime — they impose no obligation on JSON payloads pulled from DynamoDB, JWT claims extracted in API handlers, or request bodies posted to API Gateway. A payload that violates the type silently flows through the system until it breaks somewhere downstream, or worse, corrupts state without breaking.

This failure mode had already bitten us. Wave-15d H1 traced a bug where `SkillRegistry` GSI queries returned the wrong shape to the caller, and the caller cheerfully destructured fields that did not exist. The TS compiler had nothing to say about it; the mismatch was a runtime property of the data, not a compile-time property of the code.

The Wave-16a audit (`docs/reviews/OPEN-PUNCH-LIST.md` typescript-hardening #3) recommended introducing runtime validation at boundaries where TypeScript types meet untyped JSON: DDB reads, JWT parsing, API request bodies, EventBridge event consumers.

## Decision

Add runtime schemas at `packages/shared/src/schemas/` that mirror the existing TypeScript types, expressed with Zod. Four domains are covered in the initial landing:

- `schemas/tenant.ts` — `TenantConfigSchema`, `TenantProfileSchema`, `TenantBillingSchema`, `TenantQuotaSchema`, enums for tier/status
- `schemas/skill.ts` — `SkillSchema`, `SkillMetadataSchema`, `SkillRegistryItemSchema`, approval-state enums
- `schemas/session.ts` — `AgentSessionSchema`, session-state enums, TTL shape
- `schemas/audit.ts` — `AuditEventSchema`, event-type enums

**The schemas do not replace the TypeScript types.** They sit alongside them. `Skill` (TS type) and `SkillSchema` (Zod) are both exported; callers use the type for static checking and `.parse()` / `.safeParse()` at boundaries.

The canonical pattern for a cross-package boundary:

```ts
import { SkillSchema } from '@chimera/shared';

// At a boundary (DDB read, API request, event consumer):
const skill = SkillSchema.parse(rawJson);   // throws on mismatch
// or
const result = SkillSchema.safeParse(rawJson);
if (!result.success) { /* report + reject */ }
```

Internal types — values that never cross a package boundary and whose shape is controlled by the producing code — continue to use plain TypeScript. Zod is an invariant-checking tool at trust boundaries, not a universal replacement for types.

**Commit reference:** `5ecb88b` (Wave-16a, bundled). 54 schema/enum exports across 4 domain files. 53 round-trip tests in `packages/shared/src/__tests__/{tenant,skill,session,audit}-schema.test.ts` covering happy path, boundary values, required-field omission, and unknown-field stripping.

Downstream rewrites — migrating existing boundary call sites to actually call `.parse()` / `.safeParse()` — are deferred. `packages/shared/src/schemas/index.ts` carries a `TODO` pointing to the OPEN-PUNCH-LIST entry that tracks this cleanup.

## Alternatives Considered

### Alternative 1: io-ts

Runtime validation library with the longest history in the TS ecosystem.

**Cons:** Worse type-inference ergonomics than Zod in TS 5.x; error messages harder to present to API clients; smaller community. Rejected.

### Alternative 2: Yup

Popular in the form-validation world.

**Cons:** Schema-to-type inference is weaker than Zod's; `yup.InferType` does not compose cleanly with the existing `types/` exports. Rejected.

### Alternative 3: Hand-written type guards

`function isSkill(v: unknown): v is Skill { ... }` for each type.

**Cons:** Every new field requires a code edit in the guard; easy to forget; does not produce structured error messages; does not scale to nested types. Rejected.

### Alternative 4: Zod with schema-as-source-of-truth (schemas replace types)

Delete `types/` and export `z.infer<typeof SkillSchema>` everywhere.

**Cons:** Every consumer of the types now imports Zod, bloating client bundles; re-ordering the migration makes the diff enormous; not all downstream code is ready for the rewrite today. Rejected for the initial landing; still viable as a later consolidation if we choose it.

### Alternative 5: Zod alongside existing types (Selected)

Schemas parallel the types. Migration of call sites is incremental and tracked.

**Verdict:** Selected.

## Consequences

### Positive

- **Boundary-crossing data is validated.** DDB reads, JWT claims, API bodies, EventBridge payloads have a place to plug validation in with one import.
- **Errors are structured.** Zod's `issues` array is mechanically translatable to API error responses and CloudWatch log fields.
- **Test discipline.** 53 round-trip tests locked in the initial schemas; the same tests catch drift if a TS type is updated without its schema.

### Negative

- **Two artifacts to keep in sync.** A change to a TS type requires a matching change to its Zod schema. Mitigated by the round-trip tests (which fail if the TS type drifts) and by future work to generate one from the other.
- **Incomplete cutover.** Landing the schemas does not itself validate anything in production. Until individual boundaries migrate to `.parse()` / `.safeParse()`, the benefit is latent. Tracked in `docs/reviews/OPEN-PUNCH-LIST.md`.

### Risks

- **Silent acceptance via `safeParse` ignored.** A caller that uses `.safeParse()` and forgets to check `.success` is no better off than before. Mitigated by the ESLint rule added in the same window that flags unchecked `safeParse` returns.

## Evidence

- **`docs/reviews/OPEN-PUNCH-LIST.md` typescript-hardening #3** — the audit recommendation.
- **`packages/shared/src/schemas/index.ts`** — export barrel and the TODO tracking downstream cleanup.
- **`packages/shared/src/__tests__/*-schema.test.ts`** — 53 round-trip tests (9 audit, 12 session, 17 skill, 15 tenant).
- **Commit `5ecb88b`** — Wave-16a landing (bundled with a separate Python tenant-context fix).

## Related Decisions

- **ADR-033** (Tenant context injection for Python tools) — Python's analogue. Python uses a `ContextVar` + `require_tenant_id()` gate; TS uses Zod at boundaries. Same goal: runtime enforcement of invariants that static types cannot express.
- **ADR-006** (Monorepo structure) — `packages/shared/` is the cross-package contract, which is precisely where runtime validation belongs.
- **ADR-018** (skill.md v2) — `SkillSchema` is the runtime gate that enforces skill.md v2 shape when a skill is loaded from disk or the registry.

## References

1. Zod documentation: <https://zod.dev/>
2. Schema files: `packages/shared/src/schemas/`
3. Round-trip tests: `packages/shared/src/__tests__/`
4. Landing commit: `5ecb88b`
5. Downstream cleanup tracker: `docs/reviews/OPEN-PUNCH-LIST.md` typescript-hardening #3
