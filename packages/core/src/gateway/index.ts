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
  GatewayTargetConfig,
} from './tool-registry';

// Tool loader
export { ToolLoader } from './tool-loader';

export type {
  TenantToolContext,
  ToolLoadResult,
} from './tool-loader';

// --------------------------------------------------------------------------
// AgentCore Gateway migration (Phase 0/1) — see docs/MIGRATION-gateway.md.
// Everything below is net-new, flag-gated, and does NOT replace the Python
// `gateway_proxy.py` layer. Dual-path stays until the cutover wave.
// --------------------------------------------------------------------------

export {
  loadGatewayFlags,
  gatewayFlags,
  assertGatewayFlagsConsistent,
} from './feature-flags';

export type { GatewayFeatureFlags } from './feature-flags';

export type {
  GatewayTargetType,
  GatewayTarget,
  GatewayInvokeResult,
} from './types';

export {
  GatewayError,
  GatewayNotFoundError,
  GatewayAuthError,
  GatewayRateLimitError,
  GatewayUnavailableError,
} from './types';

export {
  AgentcoreGatewayClient,
  _resetSdkBundleForTests,
} from './agentcore-gateway-client';

export type {
  AgentcoreGatewayClientOptions,
  GatewaySdkClient,
} from './agentcore-gateway-client';

export {
  TIER_TO_SERVICE_IDENTIFIERS,
  chimeraToolsToGatewayTargets,
  allTiersToGatewayTargets,
} from './tool-to-gateway-target-mapper';

export type { ChimeraToolTier } from './tool-to-gateway-target-mapper';
