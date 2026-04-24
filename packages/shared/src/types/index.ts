/**
 * Type exports for @chimera/shared package
 *
 * Provides TypeScript type definitions for all AWS Chimera platform entities
 * based on the canonical DynamoDB data model specification.
 *
 * For runtime validation of cross-boundary payloads (DDB items, JWT claims,
 * API requests/responses), import the parallel Zod schemas from
 * `@chimera/shared/schemas` — for example `TenantConfigSchema`, `SkillSchema`,
 * `AgentSessionSchema`, `AuditEventSchema`. Keep schemas in sync with these
 * types when making field changes.
 */

// Common utility types
export * from './common';

// Domain entity types
export * from './tenant';
export * from './session';
export * from './skill';
export * from './rate-limit';
export * from './cost-tracking';
export * from './audit';
