/**
 * Mock implementations for local development
 *
 * These mocks simulate AgentCore Runtime, Memory, and Gateway services
 * for local development without requiring AWS infrastructure.
 *
 * Usage:
 * ```typescript
 * import { MockRuntime, MockMemoryClient, MockGatewayClient } from '@chimera/core/mocks';
 *
 * // Local development
 * const runtime = new MockRuntime({ tenantId: 'local-tenant' });
 * const memory = new MockMemoryClient('local-namespace');
 * const gateway = new MockGatewayClient();
 * ```
 */

export { MockRuntime, MockRuntimeConfig } from './mock-runtime';
export { MockMemoryClient } from './mock-memory';
export { MockGatewayClient } from './mock-gateway';
