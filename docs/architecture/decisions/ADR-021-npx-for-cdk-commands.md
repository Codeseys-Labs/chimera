---
title: 'ADR-021: npx for CDK Commands (Not bunx)'
status: accepted
date: 2026-03-24
decision_makers: [chimera-architecture-team]
---

# ADR-021: npx for CDK Commands (Not bunx)

## Status

**Accepted** (2026-03-24)

## Context

AWS Chimera uses **Bun exclusively** as its package manager and script runner (`bun install`, `bun test`, `bunx tsc`). However, AWS CDK synthesis and deployment requires running `cdk` commands.

The question is whether to use:
- `bunx cdk` (Bun's equivalent to npx)
- `npx cdk` (Node's package runner)
- `cdk` (global install)

AWS CDK is fundamentally **Node.js-based** and relies on Node's module resolution algorithm for:
- Construct peer dependencies (e.g., `aws-cdk-lib`)
- Dynamically loading construct classes via `require()`
- Instance checks using `instanceof` for construct validation
- Peer dependency resolution for cross-stack references

When CDK code runs under **Bun's runtime**, Bun's different module resolution creates **separate class instances** for the same construct, breaking `instanceof` checks and peer dependency patterns.

## Decision

**Always use `npx cdk` for AWS CDK commands**, even though the project uses Bun for everything else.

**Implementation:**
```bash
# ✅ Correct
npx cdk synth
npx cdk deploy --all
npx cdk diff

# ❌ Wrong
bunx cdk synth      # Breaks instanceof checks
cdk deploy          # Assumes global install
```

**CDK synthesis uses Node runtime:**
```json
// infra/cdk.json
{
  "app": "npx ts-node --transpile-only bin/chimera.ts"
}
```

This ensures CDK construct code runs under **Node.js runtime**, not Bun, avoiding module resolution mismatches.

## Alternatives Considered

### Alternative 1: bunx cdk (Use Bun for Everything)
Use `bunx cdk` to stay consistent with project's Bun-first approach.

**Pros:**
- Consistent toolchain (no exceptions to "use Bun everywhere" rule)
- Slightly faster execution (Bun's runtime is faster than Node)

**Cons:**
- ❌ **Breaks instanceof checks** - `peer.canInlineRule is not a function` errors
- ❌ **Breaks peer dependencies** - CDK constructs loaded via different class instances
- ❌ **Breaks security group rules** - `SecurityGroup` `instanceof` checks fail
- ❌ **Breaks cross-stack references** - `Fn.importValue()` fails when stacks use different construct instances
- ❌ **Upstream limitation** - AWS CDK team does not test against Bun runtime

**Root cause:**
Bun's module resolution algorithm differs from Node's. When `aws-cdk-lib` is loaded:
```typescript
// Under Node (correct)
const sg1 = new SecurityGroup(...);  // Instance A
const sg2 = someFunction();          // Returns Instance A
sg1 instanceof SecurityGroup         // true

// Under Bun (broken)
const sg1 = new SecurityGroup(...);  // Instance A
const sg2 = someFunction();          // Returns Instance B (different class load)
sg1 instanceof SecurityGroup         // false
sg1.canInlineRule()                  // TypeError: canInlineRule is not a function
```

**Verdict:** Rejected due to runtime incompatibilities.

### Alternative 2: Global cdk Install
Install CDK globally: `npm install -g aws-cdk`.

**Pros:**
- No need for `npx` or `bunx` prefix
- Slightly faster (no package resolution on each run)

**Cons:**
- ❌ **Version drift** - global version may differ from project's `package.json`
- ❌ **CI/CD complexity** - must install global package in CodeBuild
- ❌ **Onboarding friction** - new engineers must remember to install globally
- ❌ **Breaks reproducibility** - different developers may have different CDK versions

**Verdict:** Rejected due to version management issues.

### Alternative 3: npx cdk (Selected)
Use `npx cdk` for all CDK commands, run CDK constructs via `npx ts-node`.

**Pros:**
- ✅ **Correct module resolution** - Node's algorithm matches CDK's expectations
- ✅ **instanceof checks work** - constructs loaded via single class instance
- ✅ **Peer dependencies work** - CDK's peer dependency resolution works correctly
- ✅ **Version pinned** - uses version from `package.json`, not global install
- ✅ **CI/CD compatible** - CodeBuild runs `npx cdk` without global install
- ✅ **Upstream support** - AWS CDK team tests against Node, not Bun
- ✅ **Reproducible** - all developers and CI use same CDK version

**Cons:**
- Exception to "Bun everywhere" rule (documented exception)
- Slightly slower than Bun runtime (~200ms overhead per command)

**Verdict:** Selected as the only reliable approach.

## Consequences

### Positive

- **Reliable CDK synthesis**: No `instanceof` errors, no peer dependency issues
- **Security group rules work**: `canInlineRule()` method exists on all `SecurityGroup` instances
- **Cross-stack references work**: `Fn.importValue()` and stack exports/imports work correctly
- **Reproducible builds**: All developers and CI use same CDK version from `package.json`
- **Upstream compatibility**: Benefits from AWS CDK team's Node.js testing

### Negative

- **Toolchain inconsistency**: One exception to "Bun everywhere" rule (documented in CLAUDE.md)
- **Slightly slower**: `npx cdk` adds ~200ms overhead vs `bunx` (acceptable for infrequent CDK commands)
- **Developer confusion**: Must remember CDK is the exception to Bun rule

### Risks

- **Forgetting the exception**: Engineers use `bunx cdk` out of habit (mitigated by CLAUDE.md documentation and PR reviews)
- **Node version drift**: Project uses Bun for runtime but Node for CDK (mitigated by explicit documentation)

## Evidence

- **Implementation**: `infra/cdk.json` line 2: `"app": "npx ts-node --transpile-only bin/chimera.ts"`
- **Documentation**: `CLAUDE.md` documents exception: "⚠️ EXCEPTION: AWS CDK commands must use `npx`"
- **Failure case**: Using `bunx cdk deploy` resulted in `TypeError: peer.canInlineRule is not a function` in security group stack
- **Mulch record mx-711d31**: "AWS CDK commands must use 'npx cdk' not 'bunx cdk' due to module resolution"
- **Mulch record mx-2f9c6d**: "bun-exclusive-package-manager: Project uses bun exclusively" (CDK is documented exception)

**Why this happens:**
AWS CDK's `instanceof` checks rely on **reference equality** of constructor functions. Bun's module cache differs from Node's, causing:
```typescript
// Node (correct)
require('aws-cdk-lib').SecurityGroup === require('aws-cdk-lib').SecurityGroup  // true

// Bun (broken)
require('aws-cdk-lib').SecurityGroup === require('aws-cdk-lib').SecurityGroup  // false (different instances)
```

## Related Decisions

- **ADR-015** (Bun toolchain): CDK is the one exception to "Bun everywhere" rule
- **ADR-005** (AWS CDK for IaC): This decision enables reliable CDK synthesis
- **ADR-022** (skipLibCheck): `ts-node --transpile-only` requires `skipLibCheck: true`
- **ADR-013** (CodePipeline): CI/CD pipeline runs `npx cdk deploy` in CodeBuild

## References

1. AWS CDK CLI: https://docs.aws.amazon.com/cdk/v2/guide/cli.html
2. Node Module Resolution: https://nodejs.org/api/modules.html#modules_all_together
3. Bun Module Resolution: https://bun.sh/docs/runtime/modules
4. CDK Construct instanceof Issues: https://github.com/aws/aws-cdk/issues/12851
5. Implementation: `infra/cdk.json` and `CLAUDE.md`
