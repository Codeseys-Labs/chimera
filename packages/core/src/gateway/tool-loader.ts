/**
 * Dynamic Tool Loader - On-demand tool loading with tier filtering
 *
 * Provides a high-level API for loading AWS and discovery tools based on
 * tenant subscription tier. Handles lazy initialization and caching.
 *
 * Usage:
 *   const loader = new ToolLoader(registry);
 *   const tools = await loader.loadToolsForTenant(tenantId);
 *   const specificTools = await loader.loadToolsByIdentifier('lambda');
 */

import type { TenantTier } from '@chimera/shared';
import type { ToolRegistry, StrandsTool } from './tool-registry';
import type { ToolIdentifier } from './tier-config';
import { getAvailableTools, getToolTier } from './tier-config';

/**
 * Tenant information for tool loading
 */
export interface TenantToolContext {
  /** Tenant identifier */
  tenantId: string;

  /** Subscription tier (basic, advanced, enterprise, dedicated) */
  subscriptionTier: TenantTier;

  /** Optional: specific tools to include (overrides tier filtering) */
  allowedTools?: ToolIdentifier[];

  /** Optional: specific tools to exclude */
  deniedTools?: ToolIdentifier[];
}

/**
 * Tool loading result with metadata
 */
export interface ToolLoadResult {
  /** Loaded Strands tools */
  tools: StrandsTool[];

  /** Tool identifiers that were loaded */
  loadedIdentifiers: ToolIdentifier[];

  /** Tool identifiers that were denied (not available at tier) */
  deniedIdentifiers: ToolIdentifier[];

  /** Total count of loaded tools */
  count: number;

  /** Subscription tier used for filtering */
  tier: TenantTier;
}

/**
 * Dynamic tool loader with tier-based filtering
 *
 * Wraps the ToolRegistry to provide convenient APIs for loading tools
 * based on tenant context and subscription tiers.
 */
export class ToolLoader {
  private registry: ToolRegistry;
  private cache: Map<string, ToolLoadResult> = new Map();

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  /**
   * Load all tools available for a tenant based on subscription tier
   *
   * @param context - Tenant tool context with tier and optional filters
   * @returns Tool loading result with tools and metadata
   */
  async loadToolsForTenant(context: TenantToolContext): Promise<ToolLoadResult> {
    // Check cache first
    const cacheKey = this.getCacheKey(context);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Get base tools for tier
    const tools = this.registry.getToolsForTier(context.subscriptionTier);
    const allIdentifiers = this.registry.getAllIdentifiers();

    // Apply allow/deny filters
    const filteredTools = this.applyFilters(tools, context, allIdentifiers);

    const result: ToolLoadResult = {
      tools: filteredTools.tools,
      loadedIdentifiers: filteredTools.loaded,
      deniedIdentifiers: filteredTools.denied,
      count: filteredTools.tools.length,
      tier: context.subscriptionTier,
    };

    // Cache result
    this.cache.set(cacheKey, result);

    return result;
  }

  /**
   * Load tools for specific identifiers
   *
   * @param identifiers - Array of tool identifiers to load
   * @param tier - Optional subscription tier for validation (skips check if omitted)
   * @returns Array of Strands tools
   */
  async loadToolsByIdentifier(
    identifiers: ToolIdentifier[],
    tier?: TenantTier
  ): Promise<StrandsTool[]> {
    const tools: StrandsTool[] = [];

    for (const identifier of identifiers) {
      // Validate tier access if provided
      if (tier) {
        const availableTools = getAvailableTools(tier);
        if (!availableTools.includes(identifier)) {
          console.warn(
            `Tool '${identifier}' not available for tier '${tier}' (requires tier ${getToolTier(identifier)})`
          );
          continue;
        }
      }

      const toolArray = this.registry.getToolsByIdentifier(identifier);
      if (toolArray) {
        tools.push(...toolArray);
      }
    }

    return tools;
  }

  /**
   * Get tool identifiers available for a subscription tier
   *
   * @param tier - Subscription tier
   * @returns Array of tool identifiers accessible at this tier
   */
  getAvailableIdentifiers(tier: TenantTier): ToolIdentifier[] {
    return getAvailableTools(tier);
  }

  /**
   * Check if a specific tool is available for a tenant
   *
   * @param identifier - Tool identifier
   * @param context - Tenant tool context
   * @returns True if the tool is accessible for this tenant
   */
  isToolAvailable(identifier: ToolIdentifier, context: TenantToolContext): boolean {
    // Check explicit deny list
    if (context.deniedTools?.includes(identifier)) {
      return false;
    }

    // Check explicit allow list
    if (context.allowedTools?.length) {
      return context.allowedTools.includes(identifier);
    }

    // Check tier access
    const availableTools = getAvailableTools(context.subscriptionTier);
    return availableTools.includes(identifier);
  }

  /**
   * Clear the tool loading cache
   *
   * Useful when tenant subscriptions change or registry is updated.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Clear cache for a specific tenant
   *
   * @param tenantId - Tenant identifier
   */
  clearTenantCache(tenantId: string): void {
    // Remove all cache entries matching this tenant
    const keysToDelete: string[] = [];
    this.cache.forEach((_value, key) => {
      if (key.startsWith(`${tenantId}:`)) {
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => this.cache.delete(key));
  }

  /**
   * Get cache statistics
   *
   * @returns Object with cache size and hit metrics
   */
  getCacheStats(): { size: number; keys: string[] } {
    const keys: string[] = [];
    this.cache.forEach((_value, key) => {
      keys.push(key);
    });
    return {
      size: this.cache.size,
      keys,
    };
  }

  // --- Private methods ---

  /**
   * Generate cache key from tenant context
   */
  private getCacheKey(context: TenantToolContext): string {
    const parts = [
      context.tenantId,
      context.subscriptionTier,
      context.allowedTools?.sort().join(',') || 'none',
      context.deniedTools?.sort().join(',') || 'none',
    ];
    return parts.join(':');
  }

  /**
   * Apply allow/deny filters to tool list
   */
  private applyFilters(
    tools: StrandsTool[],
    context: TenantToolContext,
    allIdentifiers: ToolIdentifier[]
  ): { tools: StrandsTool[]; loaded: ToolIdentifier[]; denied: ToolIdentifier[] } {
    const loaded: ToolIdentifier[] = [];
    const denied: ToolIdentifier[] = [];

    // Build set of tool names that passed filtering
    const allowedToolNames = new Set<string>();

    for (const identifier of allIdentifiers) {
      if (this.isToolAvailable(identifier, context)) {
        const toolArray = this.registry.getToolsByIdentifier(identifier);
        if (toolArray) {
          for (const tool of toolArray) {
            allowedToolNames.add(tool.name);
          }
          loaded.push(identifier);
        }
      } else {
        denied.push(identifier);
      }
    }

    // Filter tools by name
    const filteredTools = tools.filter((tool) => allowedToolNames.has(tool.name));

    return {
      tools: filteredTools,
      loaded,
      denied,
    };
  }
}
