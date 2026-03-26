---
title: 'ADR-025: CDK Nag Compliance Scanning'
status: accepted
date: 2026-03-26
decision_makers: [chimera-architecture-team]
---

# ADR-025: CDK Nag Compliance Scanning

## Status

**Accepted** (2026-03-26)

## Context

AWS Chimera's infrastructure is defined across 11 CDK stacks (`NetworkStack`, `DataStack`, `SecurityStack`, `ObservabilityStack`, `ApiStack`, `SkillPipelineStack`, `ChatStack`, `EvolutionStack`, `OrchestrationStack`, `TenantOnboardingStack`, `PipelineStack`). As of ADR-005, all infrastructure is managed via AWS CDK; as of ADR-012, the project aligns with the AWS Well-Architected Framework.

The current development workflow has no automated compliance scanning for CDK-defined resources. Security and compliance issues are caught only at code review or post-deployment. This creates risk exposure in several areas:

**Identified gaps (discovered without automated scanning):**
- S3 buckets created in early iterations lacked server-side encryption by default
- Lambda functions did not consistently enforce least-privilege execution roles
- Secrets Manager secret values were accessed via `unsafeUnwrap()` in some stacks (embedding plaintext in CloudFormation templates)
- CloudWatch log groups lacked explicit KMS key assignment in several stacks
- SQS queues had inconsistent encryption settings (KMS vs SSE-SQS)

**Compliance requirements driving this decision:**
- The platform handles multi-tenant workloads with customer data, triggering SOC 2 Type II readiness requirements
- Enterprise tier customers require evidence of security controls in vendor assessments
- The self-modifying IAC capability (ADR-011) means CDK changes are deployed autonomously; human review is intermittent

**CDK Nag** is an open-source CDK library from AWS Labs that applies static analysis packs against synthesized CloudFormation templates. It integrates into CDK synthesis (runs during `cdk synth`), producing violations as CDK `Annotations` (warnings or errors). Key capabilities:
- **AwsSolutions** pack: 200+ rules for AWS security best practices
- **NIST 800-53 rev 5** pack: Compliance controls mapped to AWS resources
- **Suppression mechanism**: Named suppressions with mandatory justification strings

## Decision

**Adopt CDK Nag with the `AwsSolutions` rule pack applied to all stacks**, running as part of `cdk synth`. Violations are reported as warnings by default; rules are promoted to errors for a curated subset of high-severity controls.

**Installation:**
```bash
bun add -D cdk-nag
```

**Integration in `infra/bin/chimera.ts`:**
```typescript
import { App, Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';

const app = new App();

// Apply AwsSolutions rule pack to all stacks
Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Stacks instantiation...
new NetworkStack(app, `Chimera-${env}-Network`, { /* ... */ });
// etc.
```

**Suppression pattern (for intentional deviations):**
```typescript
import { NagSuppressions } from 'cdk-nag';

// Stack-level suppression with justification
NagSuppressions.addStackSuppressions(this, [
  {
    id: 'AwsSolutions-IAM4',
    reason: 'Lambda execution roles use AWS managed AWSLambdaBasicExecutionRole; '
          + 'project-specific resources are granted via addToRolePolicy()',
  },
]);

// Resource-level suppression
NagSuppressions.addResourceSuppressions(myBucket, [
  {
    id: 'AwsSolutions-S1',
    reason: 'Access logging bucket is the logging target itself; '
          + 'circular logging is intentionally disabled',
  },
]);
```

**Rule severity promotion (errors, not warnings):**
```typescript
Aspects.of(app).add(new AwsSolutionsChecks({
  verbose: true,
  reports: true,           // Generate HTML/JSON reports
}));
```

The following rules are enforced as hard failures (build breaks if violated without suppression):
- `AwsSolutions-S2` / `AwsSolutions-S3`: S3 bucket server-side encryption
- `AwsSolutions-SQS3`: SQS queues must have a dead-letter queue
- `AwsSolutions-SMG4`: Secrets Manager secrets must have rotation enabled
- `AwsSolutions-IAM5`: Wildcard IAM resource permissions must be justified

**Known suppressions at adoption:**

| Rule | Location | Justification |
|---|---|---|
| `AwsSolutions-IAM4` | All Lambda roles | Managed `AWSLambdaBasicExecutionRole` used for CloudWatch Logs; project resources via addToRolePolicy |
| `AwsSolutions-L1` | Skill pipeline Lambdas | Lambda runtime version pinned for reproducibility; updated on schedule per ADR-009 |
| `AwsSolutions-SQS4` | Orchestration DLQs | DLQs are the terminal queue; adding a DLQ-of-DLQ adds no value |
| `AwsSolutions-S1` | Access logging buckets | Logging bucket cannot log to itself |

## Alternatives Considered

### Alternative 1: No Automated Scanning (Status Quo)

Rely solely on code review and manual AWS Security Hub post-deployment.

**Pros:**
- No integration work
- No suppression management overhead

**Cons:**
- ❌ **Late detection** — Issues found post-deploy cost 10x more to fix than pre-synth
- ❌ **Human review gaps** — Self-modifying IAC (ADR-011) deploys without human review
- ❌ **Compliance evidence** — No machine-readable security control evidence for SOC 2 audits
- ❌ **Inconsistent standards** — Rules enforced by reviewer familiarity, not policy

**Verdict:** Rejected. Self-modifying IAC makes automated scanning non-optional.

### Alternative 2: AWS CloudFormation Guard (cfn-guard)

Use CloudFormation Guard (cfn-guard) with custom rule files applied to synthesized templates.

**Pros:**
- Language-agnostic (works on any CloudFormation template, not CDK-specific)
- Rich declarative rule language

**Cons:**
- ❌ **No CDK integration** — Runs as a post-synth step, losing CDK context (construct paths, props)
- ❌ **No suppression mechanism** — Suppressions require modifying rule files or template metadata manually
- ❌ **Maintenance burden** — Rules must be written from scratch; no community-maintained pack for AWS best practices
- ❌ **No inline reporting** — Violations are not surfaced in CDK synthesis output; require separate CI step

**Verdict:** Rejected. Lack of CDK-native integration and suppression mechanism makes it harder to maintain.

### Alternative 3: AWS Security Hub with CDK-deployed findings

Enable Security Hub with FSBP (AWS Foundational Security Best Practices) standard, accepting that issues are found post-deployment.

**Pros:**
- Zero integration effort at synthesis time
- Centralized findings across all AWS resources (not just CDK-managed)
- Real-time findings as resources are deployed

**Cons:**
- ❌ **Post-deployment only** — Cannot catch issues before `cdk deploy`; self-healing is reactive
- ❌ **No PR feedback** — Engineers don't see violations in their local development loop
- ❌ **Cost** — Security Hub charges per finding check ingested
- ❌ **False positives** — Many findings for intentional patterns (e.g., public-facing S3 static site)

**Verdict:** Rejected as the sole mechanism. Can be used as a complementary layer alongside CDK Nag.

### Alternative 4: CDK Nag with AwsSolutions pack (Selected)

Integrate CDK Nag into CDK synthesis with the AwsSolutions rule pack.

**Pros:**
- ✅ **Pre-synth detection** — Violations surface during `cdk synth`, before deployment
- ✅ **CDK-native** — Uses CDK Aspects, integrates with construct tree, reports by logical ID
- ✅ **Suppression with justification** — Named suppressions require human-readable rationale, creating audit trail
- ✅ **Community-maintained rules** — AWS Labs maintains 200+ AwsSolutions rules
- ✅ **Local dev feedback** — Engineers see violations in their terminal during `cdk synth`
- ✅ **CI-compatible** — Runs as part of `cdk synth --quiet` in CodeBuild (ADR-013 pipeline)
- ✅ **Compliance reporting** — Generates HTML/JSON reports suitable for SOC 2 evidence

**Cons:**
- Suppression management adds overhead as stacks grow
- Verbose output during `cdk synth` (mitigated by `--quiet` flag in CI)

**Verdict:** Selected.

## Consequences

### Positive

- **Shift-left security**: CDK Nag catches violations at synthesis time, before CloudFormation deployment begins.
- **Suppression audit trail**: Every intentional deviation from best practices requires a documented justification string, creating evidence for compliance reviews.
- **Self-modifying IAC safety**: Autonomous CDK changes generated by the evolution stack (ADR-011) are subject to the same scanning as human-authored changes.
- **Consistent enforcement**: Rules apply equally to all 11 stacks; no gaps from reviewer unfamiliarity.
- **SOC 2 evidence**: CDK Nag reports can be attached to SOC 2 audit packages as evidence of security control verification.

### Negative

- **Initial suppression debt**: Existing stacks have known deviations that require suppressions at adoption time (~15-20 suppressions estimated).
- **Synth output verbosity**: `cdk synth` output is noisier during development (mitigated by `--quiet` in CI).
- **Rule updates require review**: When `cdk-nag` package updates add new rules, existing stacks may gain new violations requiring suppression review.

### Risks

- **Suppression abuse**: Engineers suppress violations without understanding them, defeating the purpose (mitigated by: requiring `reason` strings in PRs, periodic suppression audits).
- **False security confidence**: CDK Nag checks infrastructure-as-code, not runtime behavior; runtime misconfigurations (IAM conditions, resource policies applied at runtime) are out of scope (documented in runbooks).
- **Unintentional synth breakage**: A CDK Nag version update promoting a warning to an error could break CI unexpectedly (mitigated by: pinning `cdk-nag` version in `package.json` with explicit upgrade reviews).

## Evidence

- **No existing CDK Nag integration**: `infra/package.json` contains no `cdk-nag` dependency as of 2026-03-26
- **Known compliance gaps**: `unsafeUnwrap()` usage documented in skill `cdk-secrets-manager-unsafeunwrap-leak`; resolved before CDK Nag adoption
- **Self-modifying IAC**: ADR-011 documents autonomous CDK synthesis; ADR-025 closes the compliance loop for agent-generated changes
- **SOC 2 readiness**: Enterprise tier tenant contracts require vendor security questionnaire responses citing automated compliance controls

## Related Decisions

- **ADR-005** (AWS CDK for IaC): CDK Nag is a CDK-native tool; requires CDK as prerequisite
- **ADR-011** (Self-modifying IAC): Autonomous CDK changes are the primary driver for automated compliance scanning
- **ADR-012** (Well-Architected Framework): CDK Nag's AwsSolutions pack is aligned with AWS Well-Architected Security pillar
- **ADR-013** (CodeCommit + CodePipeline): CDK Nag runs during `cdk synth` in the CodeBuild stage of the pipeline
- **ADR-021** (npx for CDK): CDK Nag integrates via CDK Aspects; runs under Node (same constraint as CDK itself)

## References

1. CDK Nag GitHub: https://github.com/cdklabs/cdk-nag
2. AwsSolutions rule pack: https://github.com/cdklabs/cdk-nag/blob/main/RULES.md
3. CDK Aspects API: https://docs.aws.amazon.com/cdk/v2/guide/aspects.html
4. AWS Security Hub FSBP: https://docs.aws.amazon.com/securityhub/latest/userguide/fsbp-standard.html
5. SOC 2 Type II overview: https://www.aicpa.org/resources/article/soc-2-and-soc-3-reports
