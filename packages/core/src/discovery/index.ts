/**
 * AWS Account Discovery Module
 *
 * Provides account-wide resource discovery, cost analysis, and tag governance:
 * - Cost Explorer integration for spending analysis and forecasting
 * - Tag Organization for compliance checking and resource discovery
 * - Unified Resource Index for fast queries and aggregations
 *
 * Based on research:
 * - docs/research/aws-account-agent/04-Cost-Explorer-Spending-Analysis.md
 * - docs/research/aws-account-agent/05-Tag-Organization-Strategy.md
 * - docs/research/aws-account-agent/06-Account-Discovery-Architecture.md
 */

// Cost Analyzer exports
export {
  CostAnalyzer,
  type CostExplorerClient,
  type CostGranularity,
  type CostMetric,
  type CostDimension,
  type TimePeriod,
  type CostGroupBy,
  type CostFilter,
  type CostAnalysisResult,
  type CostAnomaly,
  type ResourceCost,
  type CostForecast,
  type CostAnalyzerConfig,
} from './cost-analyzer';

// Tag Organizer exports
export {
  TagOrganizer,
  CHIMERA_TAG_SCHEMA,
  type ResourceGroupsTaggingClient,
  type ConfigClient,
  type Tag,
  type TagValidationRule,
  type TagPolicy,
  type TagComplianceResult,
  type TagFilter,
  type TaggedResource,
  type TagComplianceSummary,
  type TagOrganizerConfig,
} from './tag-organizer';

// Resource Index exports
export {
  ResourceIndex,
  type ResourceMetadata,
  type ResourceQuery,
  type ResourceAggregation,
  type ResourceIndexConfig,
} from './resource-index';
