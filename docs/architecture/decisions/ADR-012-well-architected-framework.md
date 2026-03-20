---
title: 'ADR-012: Well-Architected Framework as Agent Decision Framework'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-012: Well-Architected Framework as Agent Decision Framework

## Status

**Accepted** (2026-03-20)

## Context

Agents making infrastructure decisions need a vocabulary for evaluating options:
- Is this solution reliable?
- Is it secure?
- Is it cost-effective?

Agents must explain decisions to humans in industry-standard terms.

## Decision

Use **AWS Well-Architected Framework's 6 pillars** as the decision vocabulary:
1. Operational Excellence
2. Security
3. Reliability
4. Performance Efficiency
5. Cost Optimization
6. Sustainability

Agents score each alternative 1-10 per pillar, select highest total score.

## Alternatives Considered

### Alternative 1: Well-Architected Framework (Selected)
Industry-standard framework with 6 pillars.

**Pros:**
- ✅ **Industry standard**: Engineers understand terminology
- ✅ **Comprehensive**: Covers all major concerns
- ✅ **AWS-native**: Maps to AWS services
- ✅ **Auditable**: Clear scoring criteria

**Cons:**
- AWS-specific (acceptable)

**Verdict:** Selected for industry adoption.

### Alternative 2: Custom Framework
Build custom decision criteria.

**Cons:**
- ❌ **Not standard**: Team needs to learn new vocabulary
- ❌ **Less credible**: Well-Architected is industry-proven

**Verdict:** Rejected - reinventing the wheel.

## Consequences

### Positive

- **Common language**: Engineers and agents use same vocabulary
- **Audit trail**: ADRs reference Well-Architected pillars

### Negative

- **Learning curve**: Agents need to understand 6 pillars

## Evidence

- **Mulch record mx-fbdb18**: "Well-Architected Framework as agent decision vocabulary"
- **Mulch record mx-eb7faa**: "AWS Well-Architected Framework as agent decision vocabulary: Six pillars"

## Related Decisions

- **ADR-001** (DynamoDB): Scored 9/10 on Performance, 10/10 on Reliability

## References

1. Well-Architected Framework: https://aws.amazon.com/architecture/well-architected/
