/**
 * Tier-based access control for AWS service tools
 *
 * Defines which AWS services are available at each subscription tier.
 * Based on aws-api-tool-prioritization convention (mx-391c14):
 * - Tier 1: Core Compute & Storage (Lambda, EC2, S3, CloudWatch, SQS)
 * - Tier 2: Database & Messaging (RDS, Redshift, Athena, Glue, OpenSearch)
 * - Tier 3: Orchestration & ML (Step Functions, Bedrock, SageMaker, Rekognition, Textract, Transcribe, CodeBuild, CodeCommit, CodePipeline)
 * - Discovery: Available to all tiers (Config Scanner, Cost Analyzer, Resource Explorer, etc.)
 *
 * Tier Access:
 * - Basic: Tier 1 + Discovery
 * - Advanced: Tiers 1-2 + Discovery
 * - Enterprise: All tiers + Discovery
 * - Dedicated: All tiers + Discovery
 */

import type { TenantTier } from '@chimera/shared';

export type ToolTier = 1 | 2 | 3;

/**
 * AWS service tool identifier
 */
export type AWSServiceTool =
  // Tier 1: Core Compute & Storage
  | 'lambda'
  | 'ec2'
  | 's3'
  | 'cloudwatch'
  | 'sqs'
  // Tier 2: Database & Messaging
  | 'rds'
  | 'redshift'
  | 'athena'
  | 'glue'
  | 'opensearch'
  // Tier 3: Orchestration & ML
  | 'stepfunctions'
  | 'bedrock'
  | 'sagemaker'
  | 'rekognition'
  | 'textract'
  | 'transcribe'
  | 'codebuild'
  | 'codecommit'
  | 'codepipeline';

/**
 * Discovery tool identifier
 */
export type DiscoveryTool =
  | 'config-scanner'
  | 'cost-analyzer'
  | 'tag-organizer'
  | 'resource-explorer'
  | 'stack-inventory'
  | 'resource-index';

export type ToolIdentifier = AWSServiceTool | DiscoveryTool;

/**
 * Tool tier assignment map
 *
 * Each tool is assigned to a tier based on its criticality and use frequency.
 * Discovery tools are marked as 'discovery' and are available to all tiers.
 */
export const TOOL_TIER_MAP: Record<ToolIdentifier, ToolTier | 'discovery'> = {
  // Tier 1: Core Compute & Storage
  lambda: 1,
  ec2: 1,
  s3: 1,
  cloudwatch: 1,
  sqs: 1,

  // Tier 2: Database & Messaging
  rds: 2,
  redshift: 2,
  athena: 2,
  glue: 2,
  opensearch: 2,

  // Tier 3: Orchestration & ML
  stepfunctions: 3,
  bedrock: 3,
  sagemaker: 3,
  rekognition: 3,
  textract: 3,
  transcribe: 3,
  codebuild: 3,
  codecommit: 3,
  codepipeline: 3,

  // Discovery tools (available to all tiers)
  'config-scanner': 'discovery',
  'cost-analyzer': 'discovery',
  'tag-organizer': 'discovery',
  'resource-explorer': 'discovery',
  'stack-inventory': 'discovery',
  'resource-index': 'discovery',
};

/**
 * Tenant tier to maximum tool tier mapping
 */
const TENANT_TIER_ACCESS: Record<TenantTier, ToolTier> = {
  basic: 1,
  advanced: 2,
  enterprise: 3,
  dedicated: 3,
};

/**
 * Check if a tool is available for a given tenant tier
 *
 * @param tool - Tool identifier
 * @param tenantTier - User's tenant tier
 * @returns True if the tool is accessible at this tier
 */
export function isToolAvailable(
  tool: ToolIdentifier,
  tenantTier: TenantTier
): boolean {
  const toolTier = TOOL_TIER_MAP[tool];

  // Discovery tools are always available
  if (toolTier === 'discovery') {
    return true;
  }

  const maxTier = TENANT_TIER_ACCESS[tenantTier];
  return toolTier <= maxTier;
}

/**
 * Get all available tools for a tenant tier
 *
 * @param tenantTier - User's tenant tier
 * @returns Array of tool identifiers accessible at this tier
 */
export function getAvailableTools(tenantTier: TenantTier): ToolIdentifier[] {
  return (Object.keys(TOOL_TIER_MAP) as ToolIdentifier[]).filter((tool) =>
    isToolAvailable(tool, tenantTier)
  );
}

/**
 * Get the tier number for a specific tool
 *
 * @param tool - Tool identifier
 * @returns Tier number (1-3) or 'discovery'
 */
export function getToolTier(tool: ToolIdentifier): ToolTier | 'discovery' {
  return TOOL_TIER_MAP[tool];
}

/**
 * Group tools by tier
 *
 * @returns Record mapping tier number to array of tool identifiers
 */
export function groupToolsByTier(): Record<ToolTier | 'discovery', ToolIdentifier[]> {
  const grouped: Record<ToolTier | 'discovery', ToolIdentifier[]> = {
    1: [],
    2: [],
    3: [],
    discovery: [],
  };

  for (const [tool, tier] of Object.entries(TOOL_TIER_MAP)) {
    grouped[tier].push(tool as ToolIdentifier);
  }

  return grouped;
}
