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
