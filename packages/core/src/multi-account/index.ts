/**
 * Multi-Account Management Module
 *
 * Provides AWS Organizations integration for multi-account governance:
 * - Service Control Policy (SCP) management and compliance
 * - Consolidated billing and cost aggregation across accounts
 * - Cross-account resource discovery and inventory
 *
 * This module enables Chimera to operate across AWS Organizations with:
 * - Centralized security guardrails via SCPs
 * - Account-level cost attribution and chargeback
 * - Unified resource visibility across member accounts
 * - Multi-account compliance monitoring
 *
 * Reference: docs/research/aws-account-agent/
 */

// SCP Manager exports
export {
  SCPManager,
  SCPError,
  type ServiceControlPolicy,
  type SCPTarget,
  type SCPAttachment,
  type EffectiveSCPResult,
  type SCPManagerConfig,
  type SCPErrorCode,
} from './scp-manager';

// Billing Aggregator exports
export {
  BillingAggregator,
  BillingError,
  type BillingTimePeriod,
  type AccountCostBreakdown,
  type AggregatedBillingResult,
  type AccountBudgetStatus,
  type CostComparison,
  type BillingAggregatorConfig,
  type BillingErrorCode,
} from './billing-aggregator';

// Cross-Account Discovery exports
export {
  CrossAccountDiscovery,
  CrossAccountDiscoveryError,
  type CrossAccountFilter,
  type CrossAccountResource,
  type AccountDiscoveryStatus,
  type MultiAccountComplianceSummary,
  type CrossAccountDiscoveryConfig,
  type DiscoveryErrorCode,
} from './cross-account-discovery';
