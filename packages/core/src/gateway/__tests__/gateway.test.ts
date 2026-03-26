/**
 * Gateway Module Tests - Tier configuration, tool registry, and dynamic loading
 *
 * NOTE: These are unit tests that mock the tool factories to avoid requiring
 * the full AWS tools infrastructure. The ToolRegistry tests use direct mocking
 * of internal state rather than calling real factory functions.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { TenantTier } from '@chimera/shared';
import {
  isToolAvailable,
  getAvailableTools,
  getToolTier,
  groupToolsByTier,
  TOOL_TIER_MAP,
  type ToolIdentifier,
} from '../tier-config';
import { ToolRegistry, type ToolRegistryOptions, type StrandsTool } from '../tool-registry';
import { ToolLoader, type TenantToolContext } from '../tool-loader';

// --- Mock Tool Factory ---

/**
 * Create a mock Strands tool for testing
 */
function createMockTool(name: string): StrandsTool {
  return {
    name,
    description: `Mock tool: ${name}`,
    inputSchema: {} as any,
    callback: async () => 'mock result',
  };
}

/**
 * Mock tool registry with pre-populated tools (bypasses factory initialization)
 */
class MockToolRegistry extends ToolRegistry {
  constructor() {
    super();
    // Bypass factory loading by directly populating internal maps
    // @ts-expect-error - accessing private fields for testing
    this.awsTools = new Map([
      ['lambda', [createMockTool('lambda_invoke'), createMockTool('lambda_create')]],
      ['ec2', [createMockTool('ec2_run_instances'), createMockTool('ec2_describe')]],
      ['s3', [createMockTool('s3_put_object'), createMockTool('s3_get_object')]],
      ['cloudwatch', [createMockTool('cloudwatch_put_metric')]],
      ['sqs', [createMockTool('sqs_send_message')]],
      ['rds', [createMockTool('rds_create_instance')]],
      ['redshift', [createMockTool('redshift_execute_statement')]],
      ['athena', [createMockTool('athena_start_query')]],
      ['glue', [createMockTool('glue_start_job')]],
      ['opensearch', [createMockTool('opensearch_index_document')]],
      ['stepfunctions', [createMockTool('sfn_start_execution')]],
      ['bedrock', [createMockTool('bedrock_invoke_model')]],
      ['sagemaker', [createMockTool('sagemaker_invoke_endpoint')]],
      ['rekognition', [createMockTool('rekognition_detect_labels')]],
      ['textract', [createMockTool('textract_analyze_document')]],
      ['transcribe', [createMockTool('transcribe_start_job')]],
      ['codebuild', [createMockTool('codebuild_start_build')]],
      ['codecommit', [createMockTool('codecommit_get_file')]],
      ['codepipeline', [createMockTool('codepipeline_start_execution')]],
    ]);

    // @ts-expect-error - accessing private fields for testing
    this.discoveryTools = new Map([
      ['config-scanner', [createMockTool('config_scan_resources')]],
      ['cost-analyzer', [createMockTool('cost_get_spending')]],
      ['tag-organizer', [createMockTool('tag_get_compliance')]],
      ['resource-explorer', [createMockTool('explorer_search')]],
      ['stack-inventory', [createMockTool('stack_list')]],
      ['resource-index', [createMockTool('index_query')]],
    ]);

    // @ts-expect-error - accessing private fields for testing
    this.initialized = true;
  }

  // Override initialize to be a no-op
  async initialize(): Promise<void> {
    // Already initialized in constructor
  }
}

// --- Tier Configuration Tests ---

describe('Tier Configuration', () => {
  describe('TOOL_TIER_MAP', () => {
    it('should have all 25 tool identifiers defined', () => {
      const tools = Object.keys(TOOL_TIER_MAP);
      expect(tools.length).toBe(25);
    });

    it('should assign Tier 1 to core compute & storage tools', () => {
      expect(TOOL_TIER_MAP.lambda).toBe(1);
      expect(TOOL_TIER_MAP.ec2).toBe(1);
      expect(TOOL_TIER_MAP.s3).toBe(1);
      expect(TOOL_TIER_MAP.cloudwatch).toBe(1);
      expect(TOOL_TIER_MAP.sqs).toBe(1);
    });

    it('should assign Tier 2 to database & messaging tools', () => {
      expect(TOOL_TIER_MAP.rds).toBe(2);
      expect(TOOL_TIER_MAP.redshift).toBe(2);
      expect(TOOL_TIER_MAP.athena).toBe(2);
      expect(TOOL_TIER_MAP.glue).toBe(2);
      expect(TOOL_TIER_MAP.opensearch).toBe(2);
    });

    it('should assign Tier 3 to orchestration & ML tools', () => {
      expect(TOOL_TIER_MAP.stepfunctions).toBe(3);
      expect(TOOL_TIER_MAP.bedrock).toBe(3);
      expect(TOOL_TIER_MAP.sagemaker).toBe(3);
      expect(TOOL_TIER_MAP.rekognition).toBe(3);
      expect(TOOL_TIER_MAP.textract).toBe(3);
      expect(TOOL_TIER_MAP.transcribe).toBe(3);
      expect(TOOL_TIER_MAP.codebuild).toBe(3);
      expect(TOOL_TIER_MAP.codecommit).toBe(3);
      expect(TOOL_TIER_MAP.codepipeline).toBe(3);
    });

    it('should assign discovery tier to all discovery tools', () => {
      expect(TOOL_TIER_MAP['config-scanner']).toBe('discovery');
      expect(TOOL_TIER_MAP['cost-analyzer']).toBe('discovery');
      expect(TOOL_TIER_MAP['tag-organizer']).toBe('discovery');
      expect(TOOL_TIER_MAP['resource-explorer']).toBe('discovery');
      expect(TOOL_TIER_MAP['stack-inventory']).toBe('discovery');
      expect(TOOL_TIER_MAP['resource-index']).toBe('discovery');
    });
  });

  describe('isToolAvailable', () => {
    it('should allow all Tier 1 tools for basic subscription', () => {
      expect(isToolAvailable('lambda', 'basic')).toBe(true);
      expect(isToolAvailable('ec2', 'basic')).toBe(true);
      expect(isToolAvailable('s3', 'basic')).toBe(true);
      expect(isToolAvailable('cloudwatch', 'basic')).toBe(true);
      expect(isToolAvailable('sqs', 'basic')).toBe(true);
    });

    it('should allow discovery tools for basic subscription', () => {
      expect(isToolAvailable('config-scanner', 'basic')).toBe(true);
      expect(isToolAvailable('cost-analyzer', 'basic')).toBe(true);
      expect(isToolAvailable('resource-explorer', 'basic')).toBe(true);
    });

    it('should deny Tier 2+ tools for basic subscription', () => {
      expect(isToolAvailable('rds', 'basic')).toBe(false);
      expect(isToolAvailable('bedrock', 'basic')).toBe(false);
    });

    it('should allow Tier 1-2 tools for advanced subscription', () => {
      expect(isToolAvailable('lambda', 'advanced')).toBe(true);
      expect(isToolAvailable('sqs', 'advanced')).toBe(true);
      expect(isToolAvailable('rds', 'advanced')).toBe(true);
      expect(isToolAvailable('athena', 'advanced')).toBe(true);
    });

    it('should allow discovery tools for advanced subscription', () => {
      expect(isToolAvailable('config-scanner', 'advanced')).toBe(true);
      expect(isToolAvailable('cost-analyzer', 'advanced')).toBe(true);
    });

    it('should deny Tier 3 tools for advanced subscription', () => {
      expect(isToolAvailable('bedrock', 'advanced')).toBe(false);
      expect(isToolAvailable('codebuild', 'advanced')).toBe(false);
    });

    it('should allow all tools for premium subscription', () => {
      expect(isToolAvailable('lambda', 'premium')).toBe(true);
      expect(isToolAvailable('sqs', 'premium')).toBe(true);
      expect(isToolAvailable('bedrock', 'premium')).toBe(true);
      expect(isToolAvailable('config-scanner', 'premium')).toBe(true);
    });
  });

  describe('getAvailableTools', () => {
    it('should return 11 tools for basic subscription (5 tier1 + 6 discovery)', () => {
      const tools = getAvailableTools('basic');
      expect(tools.length).toBe(11);
      tools.forEach((tool) => {
        const tier = getToolTier(tool);
        expect(tier === 1 || tier === 'discovery').toBe(true);
      });
    });

    it('should return 16 tools for advanced subscription (5+5+6)', () => {
      const tools = getAvailableTools('advanced');
      expect(tools.length).toBe(16);
      const tiers = tools.map((tool) => getToolTier(tool));
      expect(tiers).toContain(1);
      expect(tiers).toContain(2);
      expect(tiers).toContain('discovery');
      expect(tiers).not.toContain(3);
    });

    it('should return all 25 tools for premium subscription', () => {
      const tools = getAvailableTools('premium');
      expect(tools.length).toBe(25);
    });
  });

  describe('groupToolsByTier', () => {
    it('should group all tools by tier', () => {
      const grouped = groupToolsByTier();
      expect(grouped[1].length).toBe(5); // lambda, ec2, s3, cloudwatch, sqs
      expect(grouped[2].length).toBe(5); // rds, redshift, athena, glue, opensearch
      expect(grouped[3].length).toBe(9); // stepfunctions, bedrock, sagemaker, rekognition, textract, transcribe, codebuild, codecommit, codepipeline
      expect(grouped.discovery.length).toBe(6); // 6 discovery tools
    });

    it('should have correct total tool count across all tiers', () => {
      const grouped = groupToolsByTier();
      const total = grouped[1].length + grouped[2].length + grouped[3].length + grouped.discovery.length;
      expect(total).toBe(25);
    });
  });
});

// --- Tool Registry Tests ---

describe('Tool Registry', () => {
  let registry: MockToolRegistry;

  beforeEach(() => {
    registry = new MockToolRegistry();
  });

  describe('initialization', () => {
    it('should start initialized (mock bypasses factory loading)', () => {
      expect(registry.isInitialized()).toBe(true);
    });
  });

  describe('tool access', () => {
    it('should throw error when accessing tools on uninitialized real registry', () => {
      const uninitRegistry = new ToolRegistry();
      expect(() => uninitRegistry.getToolsForTier('basic')).toThrow('not initialized');
    });

    it('should return tools for basic tier (tier 1 + discovery)', () => {
      const tools = registry.getToolsForTier('basic');
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
      // Basic tier should have Tier 1 tools (5) + discovery (6) = 11 identifiers
      // Each tool has ~1-2 mock functions, so expect at least 11 tools
      expect(tools.length).toBeGreaterThanOrEqual(11);
    });

    it('should return more tools for advanced tier than basic', () => {
      const basicTools = registry.getToolsForTier('basic');
      const advancedTools = registry.getToolsForTier('advanced');
      expect(advancedTools.length).toBeGreaterThan(basicTools.length);
    });

    it('should return all tools for premium tier', () => {
      const premiumTools = registry.getToolsForTier('premium');
      expect(premiumTools.length).toBeGreaterThan(0);
      // Premium should have all 25 tools (significantly more than basic)
      const basicTools = registry.getToolsForTier('basic');
      expect(premiumTools.length).toBeGreaterThan(basicTools.length);
    });

    it('should return tools for specific identifier', () => {
      const lambdaTools = registry.getToolsByIdentifier('lambda');
      expect(lambdaTools).toBeDefined();
      expect(Array.isArray(lambdaTools)).toBe(true);
      expect(lambdaTools!.length).toBe(2); // Mock has 2 lambda tools
      expect(lambdaTools![0].name).toContain('lambda');
    });

    it('should return undefined for non-existent identifier', () => {
      const nonExistent = registry.getToolsByIdentifier('nonexistent' as any);
      expect(nonExistent).toBeUndefined();
    });

    it('should return all 25 identifiers', () => {
      const identifiers = registry.getAllIdentifiers();
      expect(identifiers.length).toBe(25);
    });

    it('should return total tool count', () => {
      const count = registry.getToolCount();
      // 19 AWS tools + 6 discovery tools = 25, with ~1-2 mock functions each
      expect(count).toBeGreaterThanOrEqual(25);
      expect(count).toBeLessThanOrEqual(60); // Upper bound check
    });

    it('should include both AWS and discovery tools', () => {
      const identifiers = registry.getAllIdentifiers();
      expect(identifiers).toContain('lambda'); // AWS tool
      expect(identifiers).toContain('config-scanner'); // Discovery tool
    });
  });
});

// --- Tool Loader Tests ---

describe('Tool Loader', () => {
  let registry: MockToolRegistry;
  let loader: ToolLoader;

  beforeEach(() => {
    registry = new MockToolRegistry();
    loader = new ToolLoader(registry);
  });

  describe('loadToolsForTenant', () => {
    it('should load tools for basic tenant', async () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      const result = await loader.loadToolsForTenant(context);
      expect(result.tier).toBe('basic');
      expect(result.tools.length).toBeGreaterThan(0);
      expect(result.count).toBe(result.tools.length);
    });

    it('should load more tools for advanced tenant', async () => {
      const basicContext: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      const advancedContext: TenantToolContext = {
        tenantId: 'tenant-456',
        subscriptionTier: 'advanced',
      };
      const basicResult = await loader.loadToolsForTenant(basicContext);
      const advancedResult = await loader.loadToolsForTenant(advancedContext);
      expect(advancedResult.count).toBeGreaterThan(basicResult.count);
    });

    it('should cache results', async () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      const result1 = await loader.loadToolsForTenant(context);
      const result2 = await loader.loadToolsForTenant(context);
      expect(result1).toBe(result2); // Same reference
    });

    it('should respect allowedTools filter', async () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
        allowedTools: ['lambda'],
      };
      const result = await loader.loadToolsForTenant(context);
      expect(result.loadedIdentifiers).toContain('lambda');
      expect(result.loadedIdentifiers.length).toBe(1);
    });

    it('should respect deniedTools filter', async () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
        deniedTools: ['lambda'],
      };
      const result = await loader.loadToolsForTenant(context);
      expect(result.loadedIdentifiers).not.toContain('lambda');
    });
  });

  describe('loadToolsByIdentifier', () => {
    it('should load specific tools by identifier', async () => {
      const tools = await loader.loadToolsByIdentifier(['lambda', 'ec2']);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should validate tier access when tier is provided', async () => {
      const tools = await loader.loadToolsByIdentifier(['lambda'], 'basic');
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should skip tools not available at tier', async () => {
      const tools = await loader.loadToolsByIdentifier(['bedrock'], 'basic');
      expect(tools.length).toBe(0); // bedrock is Tier 3, not available for basic
    });

    it('should allow discovery tools at basic tier', async () => {
      const tools = await loader.loadToolsByIdentifier(['config-scanner'], 'basic');
      expect(tools.length).toBeGreaterThan(0); // discovery tools available at all tiers
    });
  });

  describe('isToolAvailable', () => {
    it('should return true for tier 1 tools on basic', () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      expect(loader.isToolAvailable('lambda', context)).toBe(true);
    });

    it('should return true for discovery tools on basic', () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      expect(loader.isToolAvailable('config-scanner', context)).toBe(true);
    });

    it('should return false for tier 3 tools on basic', () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      expect(loader.isToolAvailable('bedrock', context)).toBe(false);
    });

    it('should respect deniedTools list', () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'premium',
        deniedTools: ['lambda'],
      };
      expect(loader.isToolAvailable('lambda', context)).toBe(false);
    });

    it('should respect allowedTools list', () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
        allowedTools: ['lambda', 'bedrock'], // bedrock normally tier 3
      };
      expect(loader.isToolAvailable('bedrock', context)).toBe(true);
      expect(loader.isToolAvailable('ec2', context)).toBe(false); // not in allowedTools
    });
  });

  describe('cache management', () => {
    it('should track cache size', async () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      await loader.loadToolsForTenant(context);
      const stats = loader.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.keys.length).toBe(1);
    });

    it('should clear entire cache', async () => {
      const context: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      await loader.loadToolsForTenant(context);
      loader.clearCache();
      const stats = loader.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('should clear cache for specific tenant', async () => {
      const context1: TenantToolContext = {
        tenantId: 'tenant-123',
        subscriptionTier: 'basic',
      };
      const context2: TenantToolContext = {
        tenantId: 'tenant-456',
        subscriptionTier: 'advanced',
      };
      await loader.loadToolsForTenant(context1);
      await loader.loadToolsForTenant(context2);

      loader.clearTenantCache('tenant-123');
      const stats = loader.getCacheStats();
      expect(stats.size).toBe(1);
      expect(stats.keys[0]).toContain('tenant-456');
    });
  });

  describe('getAvailableIdentifiers', () => {
    it('should return identifiers for each tier', () => {
      const basicIds = loader.getAvailableIdentifiers('basic');
      const advancedIds = loader.getAvailableIdentifiers('advanced');
      const premiumIds = loader.getAvailableIdentifiers('premium');

      expect(basicIds.length).toBe(11); // 5 tier1 + 6 discovery
      expect(advancedIds.length).toBe(16); // 5+5+6
      expect(premiumIds.length).toBe(25); // all
    });
  });
});
