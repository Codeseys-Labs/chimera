/**
 * MCP Tool Registry - Central registration for all AWS service and discovery tools
 *
 * Manages the mapping between tool identifiers and their factory functions,
 * handling both AWS service tools (with AWSClientFactory) and discovery tools
 * (with config objects).
 *
 * Usage:
 *   const registry = new ToolRegistry();
 *   registry.registerAWSTools(clientFactory);
 *   registry.registerDiscoveryTools(discoveryConfig);
 *   const tools = registry.getToolsForTier('advanced');
 */

import type { TenantTier } from '@chimera/shared';
import type { AWSClientFactory } from '../aws-tools';
import type { ToolIdentifier } from './tier-config';
import { isToolAvailable } from './tier-config';

// Type imports for discovery tools (these don't trigger module loading)
import type {
  ConfigAggregatorConfig,
  CostAnalyzerConfig,
  TagOrganizerConfig,
  ResourceExplorerConfig,
  StackInventoryConfig,
  ResourceIndexConfig,
} from '../discovery';

/**
 * Strands tool definition (generic structure)
 * Matches the Tool interface from aws-tools/strands-agents.d.ts
 */
export interface StrandsTool {
  name: string;
  description: string;
  inputSchema: unknown;
  callback: (input: unknown) => Promise<string>;
}

/**
 * Discovery tools configuration
 */
export interface DiscoveryConfig {
  configScanner: ConfigAggregatorConfig;
  costAnalyzer: CostAnalyzerConfig;
  tagOrganizer: TagOrganizerConfig;
  resourceExplorer: ResourceExplorerConfig;
  stackInventory: StackInventoryConfig;
  resourceIndex: ResourceIndexConfig;
}

/**
 * Tool registry options
 */
export interface ToolRegistryOptions {
  /** AWS client factory for service tool credential management */
  clientFactory: AWSClientFactory;

  /** Discovery tools configuration */
  discoveryConfig: DiscoveryConfig;
}

/**
 * Central registry for all MCP tools
 *
 * Manages tool factories and provides tier-filtered tool access.
 */
export class ToolRegistry {
  private awsTools: Map<ToolIdentifier, StrandsTool[]> = new Map();
  private discoveryTools: Map<ToolIdentifier, StrandsTool[]> = new Map();
  private initialized = false;

  /**
   * Initialize the registry with all tool factories
   *
   * @param options - Registry configuration options
   */
  async initialize(options: ToolRegistryOptions): Promise<void> {
    if (this.initialized) {
      throw new Error('ToolRegistry already initialized');
    }

    // Register AWS service tools (dynamic import to avoid loading at module import time)
    await this.registerAWSTools(options.clientFactory);

    // Register discovery tools (dynamic import to avoid loading at module import time)
    await this.registerDiscoveryTools(options.discoveryConfig);

    this.initialized = true;
  }

  /**
   * Register all AWS service tools with client factory
   *
   * Uses dynamic imports to avoid loading tool modules at import time,
   * which allows tests to run without the full AWS tools infrastructure.
   *
   * @param clientFactory - AWS client factory for credential management
   */
  private async registerAWSTools(clientFactory: AWSClientFactory): Promise<void> {
    // Dynamic import of AWS tool factories
    const {
      createLambdaTools,
      createEC2Tools,
      createS3Tools,
      createCloudWatchTools,
      createSQSTools,
      createRDSTools,
      createStepFunctionsTools,
      createBedrockTools,
      createSageMakerTools,
      createAthenaTools,
      createGlueTools,
      createRedshiftTools,
      createOpenSearchTools,
      createCodeBuildTools,
      createCodeCommitTools,
      createCodePipelineTools,
      createRekognitionTools,
      createTextractTools,
      createTranscribeTools,
    } = await import('../aws-tools');

    // Tier 1: Core Compute & Storage
    this.awsTools.set('lambda', createLambdaTools(clientFactory));
    this.awsTools.set('ec2', createEC2Tools(clientFactory));
    this.awsTools.set('s3', createS3Tools(clientFactory));
    this.awsTools.set('cloudwatch', createCloudWatchTools(clientFactory));
    this.awsTools.set('sqs', createSQSTools(clientFactory));

    // Tier 2: Database & Messaging
    this.awsTools.set('rds', createRDSTools(clientFactory));
    this.awsTools.set('redshift', createRedshiftTools(clientFactory));
    this.awsTools.set('athena', createAthenaTools(clientFactory));
    this.awsTools.set('glue', createGlueTools(clientFactory));
    this.awsTools.set('opensearch', createOpenSearchTools(clientFactory));

    // Tier 3: Orchestration & ML
    this.awsTools.set('stepfunctions', createStepFunctionsTools(clientFactory));
    this.awsTools.set('bedrock', createBedrockTools(clientFactory));
    this.awsTools.set('sagemaker', createSageMakerTools(clientFactory));
    this.awsTools.set('rekognition', createRekognitionTools(clientFactory));
    this.awsTools.set('textract', createTextractTools(clientFactory));
    this.awsTools.set('transcribe', createTranscribeTools(clientFactory));
    this.awsTools.set('codebuild', createCodeBuildTools(clientFactory));
    this.awsTools.set('codecommit', createCodeCommitTools(clientFactory));
    this.awsTools.set('codepipeline', createCodePipelineTools(clientFactory));
  }

  /**
   * Register all discovery tools with their configurations
   *
   * Uses dynamic imports to avoid loading tool modules at import time.
   *
   * @param config - Discovery tools configuration
   */
  private async registerDiscoveryTools(config: DiscoveryConfig): Promise<void> {
    // Dynamic import of discovery tool factories
    const {
      createConfigScannerTools,
      createCostAnalyzerTools,
      createTagOrganizerTools,
      createResourceExplorerTools,
      createStackInventoryTools,
      createResourceIndexTools,
    } = await import('../discovery');

    this.discoveryTools.set('config-scanner', createConfigScannerTools(config.configScanner));
    this.discoveryTools.set('cost-analyzer', createCostAnalyzerTools(config.costAnalyzer));
    this.discoveryTools.set('tag-organizer', createTagOrganizerTools(config.tagOrganizer));
    this.discoveryTools.set(
      'resource-explorer',
      createResourceExplorerTools(config.resourceExplorer)
    );
    this.discoveryTools.set('stack-inventory', createStackInventoryTools(config.stackInventory));
    this.discoveryTools.set('resource-index', createResourceIndexTools(config.resourceIndex));
  }

  /**
   * Get all tools available for a subscription tier
   *
   * @param tier - Subscription tier (basic, advanced, enterprise, dedicated)
   * @returns Array of all Strands tools accessible at this tier
   */
  getToolsForTier(tier: TenantTier): StrandsTool[] {
    if (!this.initialized) {
      throw new Error('ToolRegistry not initialized. Call initialize() first.');
    }

    const tools: StrandsTool[] = [];

    // Collect AWS service tools
    this.awsTools.forEach((toolArray, identifier) => {
      if (isToolAvailable(identifier, tier)) {
        tools.push(...toolArray);
      }
    });

    // Collect discovery tools
    this.discoveryTools.forEach((toolArray, identifier) => {
      if (isToolAvailable(identifier, tier)) {
        tools.push(...toolArray);
      }
    });

    return tools;
  }

  /**
   * Get tools for a specific service/identifier
   *
   * @param identifier - Tool identifier (e.g., 'lambda', 'config-scanner')
   * @returns Array of Strands tools for this identifier, or undefined if not found
   */
  getToolsByIdentifier(identifier: ToolIdentifier): StrandsTool[] | undefined {
    if (!this.initialized) {
      throw new Error('ToolRegistry not initialized. Call initialize() first.');
    }

    return this.awsTools.get(identifier) || this.discoveryTools.get(identifier);
  }

  /**
   * Get all registered tool identifiers
   *
   * @returns Array of all registered tool identifiers
   */
  getAllIdentifiers(): ToolIdentifier[] {
    if (!this.initialized) {
      throw new Error('ToolRegistry not initialized. Call initialize() first.');
    }

    const awsKeys: ToolIdentifier[] = [];
    this.awsTools.forEach((_value, key) => awsKeys.push(key));

    const discoveryKeys: ToolIdentifier[] = [];
    this.discoveryTools.forEach((_value, key) => discoveryKeys.push(key));

    return [...awsKeys, ...discoveryKeys];
  }

  /**
   * Get total count of registered tools
   *
   * @returns Total number of Strands tools across all identifiers
   */
  getToolCount(): number {
    if (!this.initialized) {
      throw new Error('ToolRegistry not initialized. Call initialize() first.');
    }

    let count = 0;
    this.awsTools.forEach((tools) => {
      count += tools.length;
    });
    this.discoveryTools.forEach((tools) => {
      count += tools.length;
    });
    return count;
  }

  /**
   * Check if the registry has been initialized
   *
   * @returns True if initialize() has been called successfully
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}
