/**
 * @chimera/core - Core agent runtime for AWS Chimera platform
 *
 * This package provides the foundational agent runtime functionality:
 * - Strands agent wrapper with multi-tenant session management
 * - AgentCore Runtime integration (serverless MicroVM execution)
 * - AgentCore Memory integration (STM + LTM with tenant-scoped namespaces)
 * - Universal skill loading (OpenClaw, MCP, Strands, Claude Code)
 * - System prompt templating
 * - Tool registry and execution
 *
 * @packageDocumentation
 */

// Agent components
export {
  ChimeraAgent,
  createAgent,
  SystemPromptTemplate,
  createSystemPrompt,
  createDefaultSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type AgentConfig,
  type AgentContext,
  type AgentResult,
  type ToolCall,
  type StreamEvent,
  type PromptContext
} from './agent';

// Runtime components
export {
  AgentCoreRuntime,
  createRuntime,
  MEMORY_STRATEGY_TIERS,
  type RuntimeConfig,
  type RuntimeSession,
  type MemoryOperation,
  type MemoryResult
} from './runtime';

// Memory module
export * from './memory';

// Tools module (in-memory prototypes with adapter patterns)
export * from './tools';

// Skills module (production-ready ecosystem services)
// Export with distinct names to avoid collision with tools module
export {
  SkillRegistry as SkillRegistryService,
  SkillInstaller,
  SkillDiscovery,
  SkillValidator,
  MCPGatewayClient,
  SkillTrustEngine,
  type RegistryConfig,
  type DynamoDBClient,
  type InstallerConfig,
  type S3Client,
  type DiscoveryConfig,
  type DiscoveryFilters,
  type SearchResult,
  type BedrockKBClient,
  type OpenSearchClient,
  type ValidatorConfig,
  type MCPGatewayConfig,
  type MCPTool,
  type MCPRegistrationResponse,
  type HttpClient,
  type TrustEngineConfig,
  type ActionType,
  type ResourceContext,
  type PrincipalContext,
  type AuthorizationResult,
} from './skills';
