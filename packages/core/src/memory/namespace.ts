/**
 * Memory namespace utilities for tenant isolation
 *
 * Implements the namespace template pattern: 'tenant-{tenantId}-user-{userId}'
 * Ensures cross-tenant data isolation at the AgentCore Memory level.
 *
 * Reference: Architecture convention mx-c877d0 from mulch expertise
 */

/**
 * Namespace template pattern for AgentCore Memory
 */
const NAMESPACE_TEMPLATE = 'tenant-{tenantId}-user-{userId}';

/**
 * Generate memory namespace for tenant-user isolation
 *
 * @param tenantId - Tenant identifier
 * @param userId - User identifier
 * @returns Namespaced memory identifier
 *
 * @example
 * ```ts
 * const namespace = generateNamespace('tenant-123', 'user-456');
 * // Returns: 'tenant-tenant-123-user-user-456'
 * ```
 */
export function generateNamespace(tenantId: string, userId: string): string {
  if (!tenantId || !userId) {
    throw new Error('Both tenantId and userId are required for namespace generation');
  }

  // Validate tenant and user IDs (alphanumeric, hyphens, underscores only)
  const validIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validIdPattern.test(tenantId)) {
    throw new Error(`Invalid tenantId format: ${tenantId}`);
  }
  if (!validIdPattern.test(userId)) {
    throw new Error(`Invalid userId format: ${userId}`);
  }

  return NAMESPACE_TEMPLATE
    .replace('{tenantId}', tenantId)
    .replace('{userId}', userId);
}

/**
 * Parse namespace to extract tenant and user IDs
 *
 * @param namespace - Memory namespace string
 * @returns Parsed tenant and user IDs
 *
 * @example
 * ```ts
 * const { tenantId, userId } = parseNamespace('tenant-tenant-123-user-user-456');
 * // Returns: { tenantId: 'tenant-123', userId: 'user-456' }
 * ```
 */
export function parseNamespace(namespace: string): {
  tenantId: string;
  userId: string;
} | null {
  // Pattern: tenant-{tenantId}-user-{userId}
  // Use non-greedy match to handle IDs with hyphens correctly
  const pattern = /^tenant-(.+?)-user-(.+)$/;
  const match = namespace.match(pattern);

  if (!match) {
    return null;
  }

  return {
    tenantId: match[1],
    userId: match[2],
  };
}

/**
 * Validate namespace format
 *
 * @param namespace - Namespace to validate
 * @returns True if namespace is valid
 */
export function validateNamespace(namespace: string): boolean {
  const parsed = parseNamespace(namespace);
  return parsed !== null;
}

/**
 * Generate session-scoped namespace
 * Used for session-specific memory isolation within a tenant-user context
 *
 * @param tenantId - Tenant identifier
 * @param userId - User identifier
 * @param sessionId - Session identifier
 * @returns Session-scoped namespace
 */
export function generateSessionNamespace(
  tenantId: string,
  userId: string,
  sessionId: string
): string {
  const baseNamespace = generateNamespace(tenantId, userId);
  return `${baseNamespace}-session-${sessionId}`;
}

/**
 * Extract session ID from session namespace
 *
 * @param sessionNamespace - Session-scoped namespace
 * @returns Session ID or null if not a session namespace
 */
export function extractSessionId(sessionNamespace: string): string | null {
  const pattern = /-session-(.+)$/;
  const match = sessionNamespace.match(pattern);
  return match ? match[1] : null;
}

/**
 * Generate namespace for SWARM scope (shared across agents on same task)
 *
 * @param tenantId - Tenant identifier
 * @param swarmId - Swarm/task identifier (e.g., 'chimera-39d5', 'build-pipeline-123')
 * @returns Swarm-scoped namespace
 *
 * @example
 * ```ts
 * const namespace = generateSwarmNamespace('acme-corp', 'chimera-39d5');
 * // Returns: 'tenant-acme-corp-swarm-chimera-39d5'
 * ```
 */
export function generateSwarmNamespace(
  tenantId: string,
  swarmId: string
): string {
  if (!tenantId || !swarmId) {
    throw new Error('Both tenantId and swarmId are required for swarm namespace generation');
  }

  const validIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validIdPattern.test(tenantId)) {
    throw new Error(`Invalid tenantId format: ${tenantId}`);
  }
  if (!validIdPattern.test(swarmId)) {
    throw new Error(`Invalid swarmId format: ${swarmId}`);
  }

  return `tenant-${tenantId}-swarm-${swarmId}`;
}

/**
 * Generate namespace for AGENT scope (persistent cross-session agent knowledge)
 *
 * @param tenantId - Tenant identifier
 * @param agentId - Agent identifier (e.g., 'builder-memory-tiers', 'lead-docs')
 * @returns Agent-scoped namespace
 *
 * @example
 * ```ts
 * const namespace = generateAgentNamespace('acme-corp', 'builder-memory-tiers');
 * // Returns: 'tenant-acme-corp-agent-builder-memory-tiers'
 * ```
 */
export function generateAgentNamespace(
  tenantId: string,
  agentId: string
): string {
  if (!tenantId || !agentId) {
    throw new Error('Both tenantId and agentId are required for agent namespace generation');
  }

  const validIdPattern = /^[a-zA-Z0-9_-]+$/;
  if (!validIdPattern.test(tenantId)) {
    throw new Error(`Invalid tenantId format: ${tenantId}`);
  }
  if (!validIdPattern.test(agentId)) {
    throw new Error(`Invalid agentId format: ${agentId}`);
  }

  return `tenant-${tenantId}-agent-${agentId}`;
}

/**
 * Parse scoped namespace to extract components and determine scope
 *
 * @param namespace - Scoped namespace string
 * @returns Parsed components with scope type or null if invalid
 *
 * @example
 * ```ts
 * parseScopedNamespace('tenant-acme-corp-swarm-chimera-39d5');
 * // Returns: { tenantId: 'acme-corp', scope: 'SWARM', scopeId: 'chimera-39d5' }
 * ```
 */
export function parseScopedNamespace(namespace: string): {
  tenantId: string;
  scope: 'SESSION' | 'SWARM' | 'AGENT';
  scopeId: string;
  userId?: string; // Only for SESSION scope
} | null {
  // Try SWARM pattern: tenant-{tenantId}-swarm-{swarmId}
  const swarmPattern = /^tenant-(.+?)-swarm-(.+)$/;
  const swarmMatch = namespace.match(swarmPattern);
  if (swarmMatch) {
    return {
      tenantId: swarmMatch[1],
      scope: 'SWARM',
      scopeId: swarmMatch[2],
    };
  }

  // Try AGENT pattern: tenant-{tenantId}-agent-{agentId}
  const agentPattern = /^tenant-(.+?)-agent-(.+)$/;
  const agentMatch = namespace.match(agentPattern);
  if (agentMatch) {
    return {
      tenantId: agentMatch[1],
      scope: 'AGENT',
      scopeId: agentMatch[2],
    };
  }

  // Try SESSION pattern: tenant-{tenantId}-user-{userId}-session-{sessionId}
  const sessionPattern = /^tenant-(.+?)-user-(.+?)-session-(.+)$/;
  const sessionMatch = namespace.match(sessionPattern);
  if (sessionMatch) {
    return {
      tenantId: sessionMatch[1],
      scope: 'SESSION',
      scopeId: sessionMatch[3],
      userId: sessionMatch[2],
    };
  }

  // Try base user pattern (legacy SESSION scope): tenant-{tenantId}-user-{userId}
  const userPattern = /^tenant-(.+?)-user-(.+)$/;
  const userMatch = namespace.match(userPattern);
  if (userMatch) {
    return {
      tenantId: userMatch[1],
      scope: 'SESSION',
      scopeId: 'default', // No explicit session ID
      userId: userMatch[2],
    };
  }

  return null;
}
