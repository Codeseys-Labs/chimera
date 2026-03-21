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
  BedrockModel,
  createBedrockModel,
  SystemPromptTemplate,
  createSystemPrompt,
  createDefaultSystemPrompt,
  DEFAULT_SYSTEM_PROMPT,
  type AgentConfig,
  type AgentContext,
  type AgentResult,
  type ToolCall,
  type StreamEvent,
  type PromptContext,
  type BedrockModelConfig
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
  type DynamoDBClient as TenantDynamoDBClient,
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
export {
  EvolutionSafetyHarness,
  createSafetyHarness,
  ModelRouter,
  createModelRouter,
  PromptOptimizer,
  createPromptOptimizer,
  AutoSkillGenerator,
  createAutoSkillGenerator,
  InfrastructureModifier,
  createInfrastructureModifier,
  ExperimentRunner,
  createExperimentRunner,
  type ExperimentConfig,
  type ExperimentTrial,
  type ExperimentStatus,
  type ISOTimestamp as EvolutionISOTimestamp,
  type PromptABExperiment,
  type VariantScores,
  type FailurePattern,
  type ConversationAnalysis,
  type PromptImprovement,
  type PromptTestCase,
  type PromptVariantResult,
  type TaskCategory,
  type ModelId,
  type ModelArm,
  type ModelRoutingState,
  type ModelSelection,
  type ToolPattern,
  type PatternDetectionResult,
  type GeneratedSkill,
  type SkillTestResult,
  type IaCChangeType,
  type DangerousIaCOperation,
  type InfrastructureChangeProposal,
  type InfrastructureChangeResult,
  type SelfHealAction,
  type MemoryLifecycle,
  type MemoryType,
  type MemorySource,
  type EvolutionMemoryEntry,
  type MemoryEvolutionActions,
  type MemoryEvolutionResult,
  type CronSuggestion,
  BEDROCK_MODELS,
} from './evolution';

// AWS Tools module (Tier 1 first-class AWS service integration)
export * from './aws-tools';

// Discovery module (AWS account-wide resource discovery)
export * from './discovery';

// Activity module (real-time agent activity monitoring)
export {
  DecisionLogger,
  StatusDashboard,
  BALANCED_WEIGHTS,
  COST_OPTIMIZED_WEIGHTS,
  RELIABILITY_WEIGHTS,
  type DecisionLoggerConfig,
  type LogDecisionParams,
  type StatusDashboardConfig,
  type SessionMetrics,
  type AgentActivitySummary,
  type TenantDashboard,
  type RecentActivityItem,
  type QuerySessionsParams,
  type QuerySessionsResult,
  type ActivityType,
  type ActivitySeverity,
  type BaseActivity,
  type RiskLevel as ActivityRiskLevel,
  type DecisionContext,
  type DecisionAlternative,
  type DecisionLog,
  type DecisionQueryFilter,
  type DecisionQueryResult,
  type DecisionAnalytics,
  type ConfidenceFactors,
  type ConfidenceResult,
  type ScoreCalculationInput,
  type ScoreCalculationResult,
  type DecisionRecommendation,
  type ISOTimestamp as ActivityISOTimestamp,
  type CostEstimate as ActivityCostEstimate,
} from './activity';

// Infrastructure Builder module (agent-driven IaC workspace and deployment)
export {
  CodeCommitWorkspaceManager,
  CodePipelineDeployer,
  CDKGenerator,
  createCDKGenerator,
  CedarProvisioningPolicies,
  createCedarProvisioningPolicies,
  InfrastructureDriftDetector,
  createDriftDetector,
  type InfraWorkspace,
  type WorkspaceStatus,
  type RepositoryConfig,
  type CommitMetadata,
  type FileCommit,
  type PipelineConfig,
  type PipelineExecution,
  type PipelineStatus,
  type StageExecution,
  type StageStatus as PipelineStageStatus,
  type ActionExecution,
  type ApprovalAction,
  type ApprovalStatus,
  type ChangeSetSummary,
  type ResourceChange,
  type ChangeType,
  type DriftDetection,
  type CedarInfraPolicy,
  type InfraOperationResult,
  type AWSToolContext,
  type ARN,
  type AWSRegion,
  type ISOTimestamp as InfraISOTimestamp,
  type CDKGenerationRequest,
  type CDKGenerationResult,
  type L3ConstructRequest,
  type CedarProvisioningContext,
  type CedarProvisioningResult,
  type TenantTierConfig,
  type DriftDetectionRequest,
  type DriftDetectionResult,
  type DriftedResource,
  type PropertyDifference,
  type DriftRemediationAction,
} from './infra-builder';

// Well-Architected module (framework integration and automated reviews)
export {
  // Types
  PILLAR_NAMES,
  // Evaluation functions
  evaluateChange,
  evaluateOperationalExcellence,
  evaluateSecurity,
  evaluateReliability,
  evaluatePerformanceEfficiency,
  evaluateCostOptimization,
  evaluateSustainability,
  getPillarsByScore,
  countPillarScores,
  // Presentation functions
  presentTradeoffs,
  createCompactSummary,
  createPillarComparisonTable,
  formatForSlack,
  formatForEmail,
  formatForAPI,
  // API client
  WellArchitectedToolAPI,
  createWellArchitectedToolAPI,
  // Review generator
  ReviewGenerator,
  createReviewGenerator,
  // Types
  type WellArchitectedPillar,
  type PillarScore,
  type ImpactSeverity,
  type PillarEvaluation,
  type WellArchitectedEvaluation,
  type InfrastructureChangeType,
  type InfrastructureChange,
  type TradeoffPresentation,
  type PillarPriorities,
  type WellArchitectedQuestion,
  type WellArchitectedReview,
  type WellArchitectedToolConfig,
  type CreateWorkloadParams,
  type UpdateAnswerParams,
  type CreateMilestoneParams,
  type RiskLevel as WARiskLevel,
  type PillarSummary,
  type ReviewSummary,
  type PillarId,
  type PillarScore as ReviewPillarScore,
  type PillarEvaluation as ReviewPillarEvaluation,
  type InfrastructureEvaluation,
  type GeneratedAnswer,
  type ReviewGenerationResult,
  type ReviewGeneratorConfig,
} from './well-architected';

// Swarm module (autonomous problem-solving)
export {
  STAGE_QUALITY_GATES,
  TaskDecomposer,
  createTaskDecomposer,
  BlockerResolver,
  createBlockerResolver,
  RoleAssigner,
  createRoleAssigner,
  HITLGateway,
  createHITLGateway,
  ProgressiveRefiner,
  createProgressiveRefiner,
  type DecomposerConfig,
  type DecompositionStrategy,
  type TaskStatus,
  type TaskPriority,
  type Subtask,
  type DecompositionContext,
  type DecompositionResult,
  type BlockerCategory,
  type BlockerSeverity,
  type Blocker,
  type ResolutionStrategy,
  type Resolution,
  type BlockerPattern,
  type BlockerResolverConfig,
  type SwarmRole,
  type TaskCapabilityRequirements,
  type RoleAssignment,
  type RoleAssignerConfig,
  type HumanLoopStrategy,
  type DecisionCriticality,
  type Decision,
  type HITLRequest,
  type HITLResponse,
  type HITLGatewayConfig,
  type RefinementStage,
  type QualityGate,
  type Gap,
  type RefinementState,
  type StageEvaluation,
  type ProgressiveRefinerConfig,
  type SwarmEngineConfig,
  type BlockerType,
  type BlockerResolutionAttempt,
  type ResolutionResult,
  type AgentRole as SwarmAgentRole,
  type TaskCharacteristics,
  type AgentCapabilities,
  type RoleAssignmentResult,
  type RolePerformance,
  type EscalationUrgency,
  type Environment,
  type TaskContext,
  type HITLDecision,
  type EscalationRequest,
  type HITLResolutionAttempt,
  type HumanResponse,
  type HITLPolicyConfig,
  type StageStatus as RefinementStageStatus,
  type StageLearning,
  type StageTask,
  type StageResult,
  type ProductionReadinessChecklist,
} from './swarm';

// Media Processing module (multi-modal AWS service integration)
export {
  MediaProcessor,
  createMediaProcessor,
  type MediaType,
  type MediaInput,
  type MediaTypeDetection,
  type MediaProcessingResult,
  type TranscriptionResult,
  type ImageAnalysisResult,
  type DocumentAnalysisResult,
  type MediaProcessorConfig,
  type MediaProcessingOptions,
  type TranscribeOptions,
  type RekognitionOptions,
  type TextractOptions,
} from './media';

// Multi-Account module (cross-account governance and management)
export * from './multi-account';

// Gateway module (tier-based tool access control)
export * from './gateway';

// Auth module (user pairing and identity resolution)
export {
  UserPairingService,
  type UserPairingServiceConfig,
  type ChatPlatform,
  type UserPairing,
  type CreateUserPairingParams,
  type GetUserPairingParams,
  type GetPairingsByCognitoParams,
  type UpdateUserPairingParams,
  type RevokeUserPairingParams,
  type ResolvedUserContext,
} from './auth';
