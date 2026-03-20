---
title: 'ADR-001: 6-Table DynamoDB Design over Single-Table'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-001: 6-Table DynamoDB Design over Single-Table

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera requires a multi-tenant data persistence layer for:
- Tenant configuration (tier, features, quotas, billing)
- Active agent sessions (ephemeral, 24h TTL)
- Installed skills and MCP endpoints
- Rate limiting state (token buckets, 5min TTL)
- Cost tracking per tenant per month
- Security audit trail (90d-7yr retention)

Each data type has different:
- **Access patterns** (key-value vs range queries vs time-series)
- **Capacity needs** (spiky vs steady traffic)
- **TTL requirements** (none, 5min, 24h, 2yr, 7yr)
- **Encryption requirements** (AWS-managed vs customer-managed KMS)
- **Compliance requirements** (GDPR, SOC2, HIPAA for audit)

The decision is whether to use a **single-table design** (all data in one table with sort key overloading) or **multi-table design** (one table per concern).

## Decision

Use a **6-table DynamoDB design** with clear separation of concerns:

1. `chimera-tenants` - Tenant config (no TTL, provisioned capacity)
2. `chimera-sessions` - Active sessions (24h TTL, on-demand)
3. `chimera-skills` - Installed skills (no TTL, provisioned)
4. `chimera-rate-limits` - Rate limiting state (5min TTL, on-demand)
5. `chimera-cost-tracking` - Monthly costs (2yr TTL, provisioned)
6. `chimera-audit` - Security events (tier-based TTL, on-demand, CMK encryption)

All tables use partition key `TENANT#{id}` for multi-tenant isolation. Different tables use different sort key patterns based on access requirements.

## Alternatives Considered

### Alternative 1: Single-Table Design
Use one `chimera-platform` table with sort key overloading:
- `SK=META` for tenant config
- `SK=SESSION#{id}` for sessions
- `SK=SKILL#{name}` for skills
- `SK=RATELIMIT#{resource}` for rate limits
- `SK=COST#{period}` for cost tracking
- `SK=AUDIT#{timestamp}` for audit events

**Pros:**
- Fewer tables to manage (1 vs 6)
- Single table scans possible
- Simpler IAM policies (one table ARN)
- Lower DynamoDB pricing (fewer table minimums)

**Cons:**
- ❌ **Cannot apply different TTL per concern** (sessions 24h, audit 7yr)
- ❌ **Cannot apply different encryption** (audit needs CMK, others AWS-managed)
- ❌ **Cannot apply different capacity modes** (rate-limits need on-demand, tenants use provisioned)
- ❌ **Cannot apply different backup strategies** (PITR for sessions, snapshots for audit)
- ❌ **Harder to enforce table-level IAM isolation** (one policy for everything)
- ❌ **Harder to understand and debug** (mixed concerns in one table)

**Verdict:** Rejected due to operational inflexibility.

### Alternative 2: Multi-Table Design (Selected)
One table per concern with independent configuration.

**Pros:**
- ✅ **Clear isolation boundaries** - table-level IAM policies
- ✅ **Independent scaling** - rate-limits on-demand, tenants provisioned
- ✅ **Different TTL per table** - sessions 24h, audit 90d-7yr, cost 2yr
- ✅ **Different encryption** - audit requires CMK, others use AWS-managed keys
- ✅ **Easier to understand** - one concern per table
- ✅ **Backup granularity** - PITR for sessions independently of tenants
- ✅ **Cost optimization** - pay for what each concern needs

**Cons:**
- More tables to manage (6 vs 1)
- More CloudWatch alarms needed
- Cannot query across all data types in one operation (acceptable trade-off)

**Verdict:** Selected for operational flexibility and security isolation.

### Alternative 3: Relational Database (RDS PostgreSQL)
Use RDS PostgreSQL with 6 tables in one database.

**Pros:**
- ACID compliance for all transactions
- Complex SQL queries for analytics
- Team familiarity with PostgreSQL

**Cons:**
- ❌ **6x higher cost** ($300/month vs $50/month for DynamoDB)
- ❌ **Manual capacity planning** required
- ❌ **Cold start latency** after failover (30-60s)
- ❌ **Higher operational burden** (patching, scaling, backups)
- ❌ **Not serverless** (always-on cost even with no traffic)

**Verdict:** Rejected due to cost and operational overhead.

## Consequences

### Positive

- **Operational isolation**: Each concern can be scaled, backed up, and encrypted independently
- **Cost optimization**: Rate-limits use on-demand (spiky), tenants use provisioned (steady)
- **Security compliance**: Audit table uses CMK encryption meeting HIPAA/SOC2 requirements
- **TTL per concern**: Sessions auto-expire in 24h, audit retains 7yr, rate-limits 5min
- **Simpler debugging**: Scan one table to understand sessions, another for audit
- **IAM granularity**: Can grant access to rate-limits without exposing audit logs
- **Clear migration path**: Can replace one table (e.g., move audit to S3 cold storage) without affecting others

### Negative

- **More tables to monitor**: 6 sets of CloudWatch alarms vs 1
- **More CDK code**: 6 table definitions vs 1
- **Cannot query across types**: Need multiple queries to get tenant config + sessions + costs
- **Table count quota**: Consumes 6 of the 2500 table limit per account

### Risks

- **Cross-table query patterns**: If new features require joining data across tables frequently, this design adds latency (mitigated by caching)
- **Increased cognitive load**: Engineers need to know which table holds which data (mitigated by clear documentation)

## Evidence

- **Canonical Data Model**: [docs/architecture/canonical-data-model.md](../canonical-data-model.md) lines 33-60 - documents full rationale
- **Research**: AWS Well-Architected Framework recommends "purpose-built databases" over one-size-fits-all
- **Prior art**: ClawCore research corpus evaluated single-table and rejected it
- **Mulch record mx-660d17**: "Canonical DynamoDB schema documentation pattern: Single authoritative document superseding multiple conflicting designs"
- **Implementation**: Already implemented in `infra/lib/data-stack.ts` (6 tables exist)

## Related Decisions

- **ADR-002** (Cedar policy engine): Table-level IAM policies enable Cedar policy enforcement
- **ADR-007** (AgentCore MicroVM): MicroVM sessions write to `chimera-sessions` with 24h TTL
- **ADR-014** (Token bucket rate limiting): `chimera-rate-limits` stores token bucket state
- **ADR-016** (AgentCore Memory): Memory state stored in S3, not DynamoDB (different access pattern)

## References

1. AWS DynamoDB Best Practices: https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html
2. Single-Table Design Patterns: https://www.alexdebrie.com/posts/dynamodb-single-table/
3. Multi-Table vs Single-Table: https://aws.amazon.com/blogs/database/choosing-the-right-dynamodb-partition-key/
4. Canonical Data Model (supersedes 4 conflicting designs): [docs/architecture/canonical-data-model.md](../canonical-data-model.md)
