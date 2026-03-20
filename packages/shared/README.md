# @chimera/shared

Shared TypeScript type definitions for the AWS Chimera multi-tenant agent platform.

## Purpose

This package provides common types based on the canonical DynamoDB data model specification. All types are designed for multi-tenant isolation and follow the 6-table design pattern.

## Installation

```bash
# Within the monorepo
bun add @chimera/shared
```

## Usage

```typescript
import {
  TenantProfile,
  TenantTier,
  AgentSession,
  Skill,
  AuditEvent
} from '@chimera/shared';

// Use types for type-safe DynamoDB operations
const tenant: TenantProfile = {
  PK: 'TENANT#org-acme',
  SK: 'PROFILE',
  tenantId: 'org-acme',
  name: 'Acme Corp',
  tier: 'enterprise',
  status: 'ACTIVE',
  adminEmail: 'admin@acme.com',
  dataRegion: 'us-east-1',
  createdAt: '2026-03-19T10:00:00Z',
  updatedAt: '2026-03-19T10:00:00Z'
};
```

## Type Categories

### Tenant Types (`types/tenant.ts`)
- `TenantProfile` - Core tenant metadata
- `TenantFeatureConfig` - Feature flags and limits
- `TenantModelConfig` - LLM model configuration
- `TenantToolConfig` - Tool permissions
- `TenantChannelConfig` - Integration channels (Slack, Discord)
- `TenantBilling` - Billing information
- `TenantQuota` - Resource quotas

### Session Types (`types/session.ts`)
- `AgentSession` - Active agent session state
- `SessionContext` - Working directory and environment
- `SessionTokenUsage` - Token consumption tracking

### Skill Types (`types/skill.ts`)
- `Skill` - Installed skill metadata
- `SkillTrustLevel` - 5-tier trust model
- `MCPEndpoint` - MCP server configuration
- `SecurityScanResult` - Security scan results

### Rate Limit Types (`types/rate-limit.ts`)
- `RateLimitWindow` - Sliding window counters
- `TokenBucket` - Token bucket state
- `RateLimitCheckResult` - Rate limit check response

### Cost Tracking Types (`types/cost-tracking.ts`)
- `MonthlyCost` - Monthly spend by service and model
- `CostBreakdown` - Service-level cost breakdown
- `CostAlert` - Budget threshold alerts

### Audit Types (`types/audit.ts`)
- `AuditEvent` - Security and compliance events
- `AuditEventType` - Event taxonomy
- `AuditSeverity` - Event severity levels

### Common Types (`types/common.ts`)
- `APIResponse<T>` - Generic API response wrapper
- `PaginatedResponse<T>` - Paginated list responses
- Utility types: `ISOTimestamp`, `ARN`, `AWSRegion`, etc.

## Design Principles

1. **Multi-tenant isolation** - All types use `TENANT#{tenantId}` partition keys
2. **Type safety** - Strict TypeScript types prevent DynamoDB schema drift
3. **Canonical source** - Types mirror `docs/architecture/canonical-data-model.md`
4. **Reusability** - Shared across API handlers, CDK stacks, and clients

## Building

```bash
bun run build
```

## Testing

```bash
bun test
```

## License

Apache-2.0
