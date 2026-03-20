---
title: 'ADR-014: Token Bucket over Sliding Window for Rate Limiting'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-014: Token Bucket over Sliding Window for Rate Limiting

## Status

**Accepted** (2026-03-20)

## Context

Multi-tenant platform requires rate limiting:
- Prevent one tenant from monopolizing resources
- Enforce quota limits (API calls/month)
- Protect against DDoS / abuse

Rate limiting algorithm must:
- Be **fast**: <1ms overhead per request
- Allow **burst traffic**: 100 requests in 1 second OK if quota allows
- Be **fair**: Replenish tokens at constant rate

## Decision

Use **Token Bucket** algorithm stored in DynamoDB.

Each tenant has bucket with:
- **Capacity**: Max tokens (e.g., 10,000)
- **Refill rate**: Tokens per second (e.g., 100/sec)
- **Current tokens**: Decremented on each request

DynamoDB conditional write ensures atomicity:
```typescript
await ddb.updateItem({
  Key: { PK: 'TENANT#acme', SK: 'RATELIMIT#api-requests' },
  UpdateExpression: 'SET tokens = tokens - :cost',
  ConditionExpression: 'tokens >= :cost',
  ExpressionAttributeValues: { ':cost': 1 }
});
```

## Alternatives Considered

### Alternative 1: Token Bucket (Selected)
Allow bursts, refill at constant rate.

**Pros:**
- ✅ **Allows bursts**: 100 req/sec OK for short time
- ✅ **Simple**: One DynamoDB item per limit
- ✅ **Atomic**: DynamoDB conditional write ensures correctness

**Cons:**
- None significant

**Verdict:** Selected for burst tolerance.

### Alternative 2: Sliding Window
Count requests in last N seconds.

**Cons:**
- ❌ **No burst tolerance**: Max 10 req/sec even if quota allows
- ❌ **Expensive**: Query last N records per request

**Verdict:** Rejected - no burst tolerance.

## Consequences

### Positive

- **Burst tolerance**: Users can burst to 10x normal rate
- **Simple**: One DynamoDB item per resource per tenant

### Negative

- **Token refill**: Need background process to refill tokens

## Evidence

- **Mulch record mx-391c14**: "Token bucket over sliding window for rate limiting"
- **Canonical Data Model**: Lines 369-410 define rate-limits table

## Related Decisions

- **ADR-001** (DynamoDB): Rate limiting state in `chimera-rate-limits` table

## References

1. Token Bucket algorithm: https://en.wikipedia.org/wiki/Token_bucket
