---
title: 'ADR-024: Standardize Tenant Tier Naming'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-024: Standardize Tenant Tier Naming

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera is a multi-tenant SaaS platform where the tenant subscription tier (`basic`, `advanced`, `enterprise`, `dedicated`) governs feature access, model routing, memory strategies, token quotas, and AgentCore isolation. As the platform grew, multiple teams independently introduced tier terminology, resulting in at least four conflicting naming conventions across the codebase:

| Location | Tier names used |
|---|---|
| `packages/shared/src/types/tenant.ts` | `basic \| advanced \| enterprise \| dedicated` |
| `packages/core/src/agent/agent.ts` | `basic \| advanced \| premium` |
| `packages/core/src/well-architected/types.ts` | `basic \| pro \| enterprise` |
| `packages/core/src/infra-builder/cedar-provisioning.ts` | `basic \| advanced \| enterprise` (no dedicated) |
| `packages/core/src/runtime` (memory strategy tiers) | `basic \| advanced \| premium` |

These inconsistencies create several failure modes:
1. **Runtime mismatches** — Cedar policy evaluation uses `enterprise` but agent memory config checks `premium`, so enterprise tenants may receive basic-tier memory strategies.
2. **Incomplete feature gating** — `dedicated` tier tenants are missing from Cedar provisioning logic entirely, so dedicated tenants fall through to default policy behavior.
3. **Silent type widening** — Code that accepts `TenantTier` from `@chimera/shared` must handle four values, but code using local inline literals handles only three, making the types structurally incompatible.
4. **Documentation confusion** — ADRs, runbooks, and operator docs use different names for the same tier, slowing onboarding and incident response.

The four conflicting names map roughly as follows:
- `pro` (well-architected) → `advanced` (canonical)
- `premium` (agent/memory) → `enterprise` or `dedicated` depending on context
- Missing `dedicated` → the highest-isolation tier for single-tenant deployments

## Decision

**Standardize all tier references on the canonical four-value set: `basic | advanced | enterprise | dedicated`**, as defined in `packages/shared/src/types/tenant.ts`.

**Canonical definition (unchanged — already correct):**
```typescript
// packages/shared/src/types/tenant.ts
export type TenantTier = 'basic' | 'advanced' | 'enterprise' | 'dedicated';
```

**Tier semantics:**
| Tier | Isolation | Memory strategies | Max subagents | AgentCore |
|---|---|---|---|---|
| `basic` | Shared pool | SUMMARY only | 1 | Shared endpoint |
| `advanced` | Shared pool | SUMMARY + USER_PREFERENCE | 5 | Shared endpoint |
| `enterprise` | Shared pool | SUMMARY + USER_PREFERENCE + SEMANTIC | 20 | Shared endpoint |
| `dedicated` | Single-tenant silo | All strategies + EPISODIC | Unlimited | Dedicated endpoint |

**Alias mapping for migration (delete after migration):**
```typescript
// Temporary bridge — remove once all call sites are updated
export const TIER_ALIASES: Record<string, TenantTier> = {
  'pro': 'advanced',      // well-architected module used 'pro'
  'premium': 'enterprise', // agent/memory module used 'premium'
};
```

**Memory strategy tiers are an internal implementation detail**, not a public tier name. The runtime module's `MEMORY_STRATEGY_TIERS` map uses `basic | advanced | premium` as internal keys for historical reasons. These internal keys must be updated to use the canonical names:
```typescript
// Before (inconsistent)
export const MEMORY_STRATEGY_TIERS = {
  basic: ['SUMMARY'],
  advanced: ['SUMMARY', 'USER_PREFERENCE'],
  premium: ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC'],
};

// After (canonical)
export const MEMORY_STRATEGY_TIERS: Record<TenantTier, MemoryStrategy[]> = {
  basic: ['SUMMARY'],
  advanced: ['SUMMARY', 'USER_PREFERENCE'],
  enterprise: ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC'],
  dedicated: ['SUMMARY', 'USER_PREFERENCE', 'SEMANTIC', 'EPISODIC'],
};
```

**Rules:**
1. All code importing tier strings must import `TenantTier` from `@chimera/shared` — no inline string literals.
2. `'pro'` and `'premium'` are forbidden as tier values in source code.
3. Cedar policies must include all four tiers; missing a tier is a policy gap (authorization failure).
4. DynamoDB tier values stored as strings must match the canonical set exactly.

## Alternatives Considered

### Alternative 1: Keep All Naming Systems (Status Quo)

Allow `basic/advanced/enterprise/dedicated` for subscription, `basic/advanced/premium` for memory strategies, and `basic/pro/enterprise` for well-architected module.

**Pros:**
- No migration work required

**Cons:**
- ❌ **Runtime bugs** — Cross-module tier comparisons silently fail
- ❌ **Policy gaps** — `dedicated` tier tenants miss Cedar authorization coverage
- ❌ **Type drift** — Impossible to safely narrow tier values across module boundaries

**Verdict:** Rejected. Inconsistency is actively causing bugs.

### Alternative 2: Adopt 'premium' as Canonical (Replace 'enterprise')

Use `basic | advanced | premium | dedicated` as the canonical set, matching the agent module.

**Pros:**
- Fewer changes to agent and memory modules
- 'premium' is arguably more descriptive to end users

**Cons:**
- ❌ **DynamoDB migration** — All existing `tier: 'enterprise'` records in DynamoDB must be rewritten
- ❌ **Cedar policy migration** — Existing Cedar policies use `enterprise`
- ❌ **Larger blast radius** — More code to change than standardizing on existing canonical set

**Verdict:** Rejected. The canonical set already exists in `@chimera/shared`; changing it creates unnecessary data migration.

### Alternative 3: Three-Tier Simplification (Drop 'dedicated')

Merge `dedicated` into `enterprise`, using `basic | advanced | enterprise` only.

**Pros:**
- Simplifies all tier logic (three branches instead of four)
- Matches existing Cedar provisioning and agent module patterns

**Cons:**
- ❌ **AgentCore isolation lost** — Dedicated tier's single-tenant endpoint routing is a key differentiator
- ❌ **Pricing model gap** — `dedicated` tenants pay for exclusive infrastructure; collapsing into `enterprise` breaks billing
- ❌ **Already in production** — Some dedicated tenants exist in DynamoDB with `tier: 'dedicated'`

**Verdict:** Rejected. `dedicated` encodes a materially different infrastructure topology.

### Alternative 4: Standardize on Canonical Set (Selected)

Use `basic | advanced | enterprise | dedicated` everywhere, updating divergent modules.

**Pros:**
- ✅ **Single source of truth** — `@chimera/shared` is the canonical definition
- ✅ **No data migration** — DynamoDB and Cedar policies already use this set
- ✅ **Smallest change surface** — Only two modules need updating (agent, well-architected)
- ✅ **Type safety** — `TenantTier` from `@chimera/shared` can be used everywhere

**Cons:**
- Agent and memory modules require code changes

**Verdict:** Selected.

## Consequences

### Positive

- **Cross-module type safety**: Tier comparisons across Cedar, agent, memory, and gateway modules are now type-safe and semantically consistent.
- **No Cedar policy gaps**: All four tiers have explicit policy coverage; `dedicated` is no longer silently falling through.
- **Single source of truth**: `@chimera/shared`'s `TenantTier` type is the authority; no other inline definitions.
- **Correct memory strategies**: Enterprise and dedicated tenants receive their full memory strategy configurations.

### Negative

- **Migration work**: Two modules require code changes and test updates.
- **Temporary alias table**: A bridge is needed during migration (removed once complete).

### Risks

- **Incomplete migration**: If a module is missed, type-safe code at the call site masks runtime mismatch (mitigated by: TypeScript strict mode + grep for string literals `'premium'` and `'pro'` in CI).
- **DynamoDB schema drift**: Old records with non-canonical tier values (e.g., written during testing) would bypass tier logic (mitigated by: DDB tier field validated on read in `TenantService`).

## Evidence

- **Canonical definition**: `packages/shared/src/types/tenant.ts` line 10
- **Inconsistency 1**: `packages/core/src/agent/agent.ts` — `tier?: 'basic' | 'advanced' | 'premium'`
- **Inconsistency 2**: `packages/core/src/well-architected/types.ts` — `impactedTiers?: ('basic' | 'pro' | 'enterprise')[]`
- **Gap**: `packages/core/src/infra-builder/cedar-provisioning.ts` — `dedicated` tier absent from all policy configs
- **Mulch record mx-63174c**: Tenant lifecycle with PROVISIONING/DEPROVISIONED status (status is separate from tier)
- **Mulch record mx-d0c0db**: Tier-change atomic DDB pattern (uses canonical `basic/advanced/enterprise`)

## Related Decisions

- **ADR-001** (6-table DynamoDB): `chimera-tenants` table stores `tier` as a string — canonical values stored there
- **ADR-002** (Cedar policy engine): Cedar policies use tier values in conditions; all four tiers must be covered
- **ADR-007** (AgentCore MicroVM): `dedicated` tier determines whether a tenant gets a dedicated AgentCore endpoint
- **ADR-017** (multi-provider LLM): Model routing defaults are per-tier (`basic`→nova-lite, `advanced`→sonnet, `enterprise`→opus)

## References

1. Canonical type definition: `packages/shared/src/types/tenant.ts`
2. Agent tier usage (to migrate): `packages/core/src/agent/agent.ts`
3. Well-architected tier usage (to migrate): `packages/core/src/well-architected/types.ts`
4. Cedar provisioning (to update): `packages/core/src/infra-builder/cedar-provisioning.ts`
5. Memory strategy tiers (to update): `packages/core/src/runtime/`
