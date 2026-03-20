

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

// Orchestration module (multi-agent coordination)
export {
  AgentOrchestrator,
  createOrchestrator,
  AgentSwarm,
  createSwarm,
  SwarmPresets,
  WorkflowEngine,
  createWorkflowEngine,
  WorkflowPatterns,
  CronScheduler,
  createCronScheduler,
  CronPatterns,
  CronJobPresets,
  type AgentStatus,
  type AgentRole,
  type AgentEventType,
  type SpawnAgentConfig,
  type AgentRuntimeMetadata,
  type TaskDelegation,
  type AgentEvent,
  type OrchestratorConfig,
  type ScalingStrategy,
  type SwarmConfig,
  type SwarmMetrics,
  type SwarmState,
  type WorkflowStepType,
  type WorkflowStepStatus,
  type WorkflowStep,
  type WorkflowChoice,
  type RetryConfig,
  type WorkflowDefinition,
  type WorkflowExecution,
  type StepExecutionResult,
  type CronExpression,
  type CronJobStatus,
  type CronExecutionStatus,
  type CronJob,
  type CronExecution,
  type CronSchedulerConfig
} from './orchestration';

// Tenant module (multi-tenant configuration and resource management)
export {
  TenantService,
  QuotaManager,
  RateLimiter,
  type TenantServiceConfig,
  type CreateTenantParams,
  type QuotaManagerConfig,
  type QuotaCheckResult,
  type ConsumeQuotaParams,
  type CreateQuotaParams,
  type RateLimiterConfig,
  type CheckRateLimitParams,
} from './tenant';

// Billing module (cost tracking and budget management)
export {
  CostTracker,
  BudgetMonitor,
  type CostTrackerConfig,
  type RecordCostParams,
  type BudgetMonitorConfig,
  type BudgetCheckResult,
  type BudgetAction,
} from './billing';

// Evolution module (self-improvement engine)
export * from './evolution';

// AWS Tools module (Tier 1 first-class AWS service integration)
export * from './aws-tools';

// Discovery module (AWS account-wide resource discovery)
export * from './discovery';

// Swarm module (autonomous problem-solving)
export * from './swarm';
