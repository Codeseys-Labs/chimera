---
title: 'ADR-011: Self-Modifying IaC via DynamoDB-Driven CDK'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-011: Self-Modifying IaC via DynamoDB-Driven CDK

## Status

**Accepted** (2026-03-20)

## Context

Chimera's self-evolution capability requires agents to modify infrastructure:
- Add DynamoDB GSI for new query pattern
- Create Lambda function for new skill
- Add EventBridge rule for new cron job

Agents must modify infrastructure within safety bounds:
- Budget constraint: <$50/month
- Resource type whitelist: Only Lambda, DynamoDB GSI, EventBridge rules
- Cedar policy enforcement: Cannot delete core resources

## Decision

Use **DynamoDB-driven CDK synthesis** where agents write infrastructure requests to DynamoDB, and a separate CDK app reads DynamoDB to synthesize CloudFormation.

**Flow:**
1. Agent writes infrastructure request to `chimera-infra-requests` table
2. Cedar policy validates request (budget, resource type, bounds)
3. GitOps workflow generates CDK code from DynamoDB
4. Human reviews PR before merge
5. CodePipeline deploys approved changes

## Alternatives Considered

### Alternative 1: DynamoDB-Driven CDK (Selected)
Infrastructure definitions in DynamoDB, CDK synthesizes from data.

**Pros:**
- ✅ **Auditable**: All changes in DynamoDB audit table
- ✅ **Reversible**: Rollback = delete DynamoDB item + redeploy
- ✅ **Policy-enforced**: Cedar policies validate before write
- ✅ **GitOps**: PR approval required before deploy

**Cons:**
- Complexity (DynamoDB + CDK)

**Verdict:** Selected for safety and audit trail.

### Alternative 2: Agents Write CDK Code
Agents directly generate TypeScript CDK code.

**Cons:**
- ❌ **Hard to validate**: Code generation can have subtle bugs
- ❌ **Hard to rollback**: Code changes harder to revert than data

**Verdict:** Rejected - too error-prone.

## Consequences

### Positive

- **Safe self-modification**: Cedar policies prevent dangerous changes
- **Audit trail**: Every infrastructure change logged
- **Rollback**: Delete DynamoDB item to remove resource

### Negative

- **Complexity**: Two-step process (DynamoDB write + CDK synthesis)

## Evidence

- **Mulch record mx-381e52**: "Evolution research: self-modifying infrastructure with Cedar policy constraints"

## Related Decisions

- **ADR-002** (Cedar): Policies constrain infrastructure modifications
- **ADR-005** (CDK): CDK synthesizes CloudFormation from DynamoDB

## References

1. Self-modifying IaC research: [docs/research/enhancement/04-Self-Modifying-IaC-Patterns.md](../../research/enhancement/04-Self-Modifying-IaC-Patterns.md)
