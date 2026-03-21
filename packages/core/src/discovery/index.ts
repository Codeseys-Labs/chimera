/**
 * AWS Account Discovery Module - Strands Tools
 *
 * Provides Strands @tool decorated functions for account-wide resource discovery,
 * cost analysis, and tag governance.
 *
 * Each discovery service is exported as a factory function that creates
 * an array of Strands tools. These tools wrap AWS SDK calls and provide
 * structured input/output with Zod validation.
 *
 * Based on research:
 * - docs/research/aws-account-agent/04-Cost-Explorer-Spending-Analysis.md
 * - docs/research/aws-account-agent/05-Tag-Organization-Strategy.md
 * - docs/research/aws-account-agent/06-Account-Discovery-Architecture.md
 */

// Config Scanner - AWS Config resource inventory and history
export {
  createConfigScannerTools,
  type ConfigAggregatorConfig,
} from './config-scanner';

// Cost Analyzer - AWS Cost Explorer integration
export {
  createCostAnalyzerTools,
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

// Tag Organizer - Resource tagging governance
export {
  createTagOrganizerTools,
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

// Resource Explorer - Cross-region instant search
export {
  createResourceExplorerTools,
  ExplorerQueryBuilder,
  type ResourceExplorerConfig,
} from './resource-explorer';

// Stack Inventory - CloudFormation stack tracking and drift detection
export {
  createStackInventoryTools,
  type StackInventoryConfig,
} from './stack-inventory';

// Resource Index - Unified in-memory resource index
export {
  createResourceIndexTools,
  type ResourceMetadata,
  type ResourceQuery,
  type ResourceAggregation,
  type ResourceIndexConfig,
} from './resource-index';
