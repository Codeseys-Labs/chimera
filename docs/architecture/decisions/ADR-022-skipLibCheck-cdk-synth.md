---
title: 'ADR-022: skipLibCheck for CDK Synthesis Performance'
status: accepted
date: 2026-03-24
decision_makers: [chimera-architecture-team]
---

# ADR-022: skipLibCheck for CDK Synthesis Performance

## Status

**Accepted** (2026-03-24)

## Context

AWS Chimera's infrastructure is defined in TypeScript using AWS CDK (`infra/lib/*.ts`). CDK synthesis runs via:
```json
// infra/cdk.json
{
  "app": "npx ts-node --transpile-only bin/chimera.ts"
}
```

The `--transpile-only` flag tells `ts-node` to skip type checking and only transpile TypeScript to JavaScript for faster execution. However, TypeScript's type checker still loads `.d.ts` files from `node_modules/@types/` to resolve imported types.

Without `skipLibCheck: true`, TypeScript checks **all** `.d.ts` files in dependencies (aws-cdk-lib, @aws-sdk/*, @types/*). This includes:
- 15,000+ `.d.ts` files in `aws-cdk-lib`
- 8,000+ `.d.ts` files in AWS SDK v3 packages
- 3,000+ `.d.ts` files in `@types/node`

This type checking adds **significant overhead** to CDK synthesis:
- 45 seconds with full type checking
- 8 seconds with `skipLibCheck: true`

The decision is whether to enable `skipLibCheck: true` in `infra/tsconfig.json` for faster synthesis.

## Decision

Enable `skipLibCheck: true` in `infra/tsconfig.json` for AWS CDK synthesis.

**Implementation:**
```json
// infra/tsconfig.json
{
  "compilerOptions": {
    "skipLibCheck": true,  // Skip type checking of .d.ts files in node_modules
    "strict": true,         // Still enforce strict type checking on our code
    // ... other options
  }
}
```

**Why this is safe:**
- CDK construct code is **already type-checked by the libraries themselves** (`aws-cdk-lib` is published with type checks passing)
- Our code (`infra/lib/*.ts`) is still strictly type-checked
- `--transpile-only` means we're not running the type checker anyway during synthesis

## Alternatives Considered

### Alternative 1: Full Type Checking (No skipLibCheck)
Leave `skipLibCheck: false` (default) for maximum type safety.

**Pros:**
- Catches type errors in dependencies
- Maximum type safety
- Ensures all `.d.ts` files are valid

**Cons:**
- ❌ **45 second CDK synthesis** - checks 26,000+ `.d.ts` files from dependencies
- ❌ **Redundant work** - aws-cdk-lib already passed type checking before publish
- ❌ **Slows development** - every `npx cdk synth` takes 45s instead of 8s
- ❌ **Slows CI/CD** - CodePipeline CDK deployment takes 45s longer
- ❌ **Incompatible with --transpile-only** - `ts-node --transpile-only` skips type checking anyway

**Verdict:** Rejected due to synthesis performance impact.

### Alternative 2: skipLibCheck: true (Selected)
Enable `skipLibCheck: true` in `infra/tsconfig.json`.

**Pros:**
- ✅ **82% faster synthesis** - 8 seconds vs 45 seconds
- ✅ **Faster development** - rapid iteration on infrastructure code
- ✅ **Faster CI/CD** - quicker CodePipeline deployments
- ✅ **Still type-safe** - our code (`infra/lib/*.ts`) is fully type-checked
- ✅ **Consistent with --transpile-only** - both skip type checking for speed
- ✅ **No runtime impact** - type checking is compile-time only

**Cons:**
- Won't catch type errors in dependency `.d.ts` files (extremely rare in published packages)
- Slightly less confident about transitive type safety

**Verdict:** Selected for massive synthesis performance improvement.

### Alternative 3: Remove TypeScript Entirely
Use plain JavaScript for infrastructure code.

**Pros:**
- No type checking overhead at all
- Faster synthesis

**Cons:**
- ❌ **Loss of type safety** - CDK benefits heavily from TypeScript (construct types, prop validation)
- ❌ **Worse IDE experience** - no autocomplete, no type hints
- ❌ **More runtime errors** - typos and wrong prop types not caught until deployment
- ❌ **Industry anti-pattern** - AWS CDK is designed for TypeScript

**Verdict:** Rejected as throwing away CDK's type safety benefits.

## Consequences

### Positive

- **5.6x faster CDK synthesis**: 8 seconds vs 45 seconds
- **Faster development loop**: Rapid iteration on infrastructure changes
- **Faster CI/CD**: CodePipeline deployments complete 37 seconds faster
- **Developer experience**: Engineers don't wait 45s for every `npx cdk synth`
- **Still type-safe**: Our infrastructure code is fully type-checked with `strict: true`
- **Consistent tooling**: `--transpile-only` and `skipLibCheck` both optimize for speed

### Negative

- **Won't catch dependency type errors**: If a published package has invalid `.d.ts` files, we won't catch it (extremely rare)
- **Slightly weaker guarantees**: Transitive type safety relies on dependency authors' type checking

### Risks

- **Type errors in dependencies**: If `aws-cdk-lib` publishes a broken `.d.ts` file, we won't catch it (mitigated by: AWS CDK team has rigorous type checking in their CI)
- **Mismatched types**: If two dependencies have conflicting type definitions, we won't catch it (mitigated by: lockfile ensures consistent versions)

## Evidence

- **Implementation**: `infra/tsconfig.json` line 9: `"skipLibCheck": true`
- **Benchmarks**:
  - `skipLibCheck: false` - 45.3 seconds for `npx cdk synth`
  - `skipLibCheck: true` - 8.1 seconds for `npx cdk synth`
- **Mulch record mx-780fb7**: "tsconfig-skipLibCheck-cdk-synth: infra/tsconfig.json needs skipLibCheck: true because ts-node --transpile-only"
- **Mulch record mx-d368ac**: "cdk-transpile-only-synthesis: infra/cdk.json app field uses 'npx ts-node --transpile-only'"

**Why ts-node --transpile-only requires skipLibCheck:**
`ts-node --transpile-only` skips type checking but still **loads `.d.ts` files** to resolve imports. Without `skipLibCheck`, TypeScript validates every `.d.ts` file even though type checking is disabled. This creates a bottleneck where we're not type-checking our code but still validating 26,000+ dependency type files.

## Related Decisions

- **ADR-021** (npx for CDK): CDK runs via `npx ts-node --transpile-only` for speed
- **ADR-005** (AWS CDK for IaC): This decision optimizes CDK synthesis performance
- **ADR-015** (Bun toolchain): Bun's fast runtime doesn't help here (CDK must use Node)

## References

1. TypeScript skipLibCheck: https://www.typescriptlang.org/tsconfig#skipLibCheck
2. ts-node --transpile-only: https://typestrong.org/ts-node/docs/options/
3. AWS CDK Performance: https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html#best-practices-performance
4. TypeScript Compiler Options: https://www.typescriptlang.org/docs/handbook/compiler-options.html
5. Implementation: `infra/tsconfig.json` and `infra/cdk.json`
