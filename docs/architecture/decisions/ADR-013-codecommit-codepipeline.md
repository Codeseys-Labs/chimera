---
title: 'ADR-013: CodeCommit + CodePipeline for Infrastructure-as-Capability'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-013: CodeCommit + CodePipeline for Infrastructure-as-Capability

## Status

**Accepted** (2026-03-20)

## Context

Infrastructure changes require:
- **Version control**: Track who changed what when
- **Review**: Human approval before production deploy
- **Automated testing**: CDK synth, unit tests, integration tests
- **Deployment**: Multi-stage (dev → staging → prod)
- **Rollback**: Quick rollback on failure

## Decision

Use **CodeCommit for Git** and **CodePipeline for CI/CD**.

**Pipeline stages:**
1. Source: CodeCommit repository
2. Build: CDK synth + unit tests
3. Deploy Dev: Auto-deploy to dev account
4. Deploy Staging: Auto-deploy to staging account
5. Manual Approval: Human reviews change
6. Deploy Prod: Deploy to production

## Alternatives Considered

### Alternative 1: CodeCommit + CodePipeline (Selected)
AWS-native Git + CI/CD.

**Pros:**
- ✅ **AWS-native**: No external dependencies
- ✅ **Integrated**: CloudWatch logs, IAM permissions
- ✅ **Secure**: Data stays in AWS VPC

**Cons:**
- Less feature-rich than GitHub Actions

**Verdict:** Selected for AWS-native integration.

### Alternative 2: GitHub + GitHub Actions
Popular alternative with large ecosystem.

**Cons:**
- ❌ **External dependency**: Code leaves AWS
- ❌ **Cost**: GitHub Enterprise for private repos
- ❌ **Compliance**: Some customers require AWS-only

**Verdict:** Rejected - external dependency.

## Consequences

### Positive

- **AWS-native**: All in AWS, no external services
- **Audit trail**: All commits, approvals logged

### Negative

- **Less features**: GitHub Actions more feature-rich

## Evidence

- **Mulch record mx-78e5ff**: "8-stack CDK architecture includes Pipeline stack"

## Related Decisions

- **ADR-005** (CDK): CDK code deployed via CodePipeline
- **ADR-011** (Self-modifying IaC): GitOps workflow uses CodePipeline

## References

1. CodePipeline: https://aws.amazon.com/codepipeline/
2. CodeCommit: https://aws.amazon.com/codecommit/
