/**
 * AgentCore Gateway Module - MCP Tool Priming
 *
 * Centralized registration and tier-based access control for all 25 AWS service
 * tools and 6 discovery tools. Implements the gateway pattern for Chimera agents
 * to access AWS resources through a unified interface.
 *
 * Architecture:
 * - tier-config: Defines subscription tiers and tool access levels
 * - tool-registry: Central registry mapping identifiers to tool factories
 * - tool-loader: Dynamic loading with tenant context and caching
 *
 * Usage:
 *   import { ToolRegistry, ToolLoader } from '@chimera/core/gateway';
 *
 *   const registry = new ToolRegistry();
 *   await registry.initialize({ clientFactory, discoveryConfig });
 *
 *   const loader = new ToolLoader(registry);
 *   const result = await loader.loadToolsForTenant({
 *     tenantId: 'tenant-123',
 *     subscriptionTier: 'advanced',
 *   });
 *
 * @see docs/architecture/canonical-data-model.md for tenant tier configuration
 */

// Tier configuration
export {
  isToolAvailable,
  getAvailableTools,
  getToolTier,
  groupToolsByTier,
  TOOL_TIER_MAP,
} from './tier-config';

export type {
  ToolTier,
  AWSServiceTool,
  DiscoveryTool,
  ToolIdentifier,
} from './tier-config';

// Tool registry
export { ToolRegistry } from './tool-registry';

export type {
  StrandsTool,
  DiscoveryConfig,
  ToolRegistryOptions,
} from './tool-registry';

// Tool loader
export { ToolLoader } from './tool-loader';

export type {
  TenantToolContext,
  ToolLoadResult,
} from './tool-loader';
