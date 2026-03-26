/**
 * Evolution Engine Types
 *
 * Type definitions for AWS Chimera's self-evolution system.
 * Covers prompt optimization, model routing, auto-skill generation,
 * IaC self-modification, and safety guardrails.
 */

/**
 * ISO 8601 timestamp string
 */
export type ISOTimestamp = string;

// ============================================================
// Prompt Evolution Types
// ============================================================

/**
 * Prompt A/B test experiment state
 */
export interface PromptABExperiment {
  experimentId: string;
  tenantId: string;
  variantAPromptS3: string;  // S3 key for control prompt
  variantBPromptS3: string;  // S3 key for challenger prompt
  trafficSplit: number;       // 0.0-1.0, fraction routed to B
  startedAt: ISOTimestamp;
  expiresAt: ISOTimestamp;
  variantAScores: VariantScores;
  variantBScores: VariantScores;
  status: 'running' | 'completed' | 'rolled_back';
  promotedVariant: 'a' | 'b' | null;
  cedarApproval: string;  // Cedar policy evaluation result
}

/**
 * Scores for a prompt variant
 */
export interface VariantScores {
  quality: number;    // Average quality score (0-1)
  cost: number;       // Average cost per interaction ($)
  n: number;          // Number of samples
  latencyMs?: number; // Average latency
}

/**
 * Failure pattern detected in logs
 */
export interface FailurePattern {
  sessionId: string;
  turn: number;
  tool?: string;
  error?: string;
  userMessage?: string;
  priorAssistantMessage?: string;
}

/**
 * Conversation log analysis result
 */
export interface ConversationAnalysis {
  tenantId: string;
  periodDays: number;
  totalSessions: number;
  failureCount: number;
  correctionCount: number;
  topFailures: FailurePattern[];
  topCorrections: FailurePattern[];
}

/**
 * Proposed prompt improvement
 */
export interface PromptImprovement {
  improvedPrompt: string;
  changes: string[];
  rationale: string;
}

/**
 * Golden dataset test case
 */
export interface PromptTestCase {
  id: string;
  userInput: string;
  expectedOutput: string;
  category?: string;
}

/**
 * Prompt variant test result
 */
export interface PromptVariantResult {
  variantId: string;
  avgQualityScore: number;
  avgTokensPerCase: number;
  passRate: number;
  details: Array<{
    caseId: string;
    score: number;
    latencyMs: number;
    tokensUsed: number;
  }>;
}

// ============================================================
// Model Routing Types
// ============================================================

/**
 * Task categories for model routing
 */
export type TaskCategory =
  | 'simple_qa'
  | 'code_gen'
  | 'analysis'
  | 'creative'
  | 'planning'
  | 'research';

/**
 * Model ID (flexible string type for extensibility)
 */
export type ModelId = string;

/**
 * Beta distribution parameters for Thompson sampling
 */
export interface ModelArm {
  modelId: ModelId;
  costPer1kTokens: number;
  alpha: number;  // successes + prior (default 1.0)
  beta: number;   // failures + prior (default 1.0)
}

/**
 * Model routing state per tenant
 */
export interface ModelRoutingState {
  tenantId: string;
  routingState: Record<TaskCategory, Record<ModelId, {
    alpha: number;
    beta: number;
  }>>;
  costSensitivity: number;  // 0.0-1.0 (quality vs cost tradeoff)
  lastUpdated: ISOTimestamp;
  totalRequests: number;
  costSaved: number;  // Estimated $ saved vs always-Opus
}

/**
 * Model selection result
 */
export interface ModelSelection {
  selectedModel: ModelId;
  taskCategory: TaskCategory;
  routingMode: 'static' | 'auto';
  explanation: string;
  routingWeights?: Record<ModelId, {
    meanQuality: number;
    observations: number;
    costPer1k: number;
    costAdjustedScore: number;
  }>;
}

// ============================================================
// Auto-Skill Generation Types
// ============================================================

/**
 * Detected repetitive tool pattern
 */
export interface ToolPattern {
  pattern: string[];  // Sequence of tool names
  occurrences: number;
  steps: number;
  exampleFullSequence: string[];
  confidence?: number;
}

/**
 * Pattern detection result
 */
export interface PatternDetectionResult {
  tenantId: string;
  sessionsAnalyzed: number;
  patternsFound: number;
  topPatterns: ToolPattern[];
}

/**
 * Generated skill from pattern
 */
export interface GeneratedSkill {
  skillName: string;
  skillMd: string;
  toolCode?: string;
  pattern: string[];
  confidence: number;
  metadata: {
    generatedAt: ISOTimestamp;
    tenantId: string;
    occurrences: number;
  };
}

/**
 * Skill sandbox test result
 */
export interface SkillTestResult {
  totalTests: number;
  passed: number;
  failed: number;
  passRate: number;
  results: Array<{
    input: unknown;
    output?: unknown;
    error?: string;
    executionMs?: number;
  }>;
}

// ============================================================
// Infrastructure Self-Modification Types
// ============================================================

/**
 * IaC change types bounded by Cedar policies
 */
export type IaCChangeType =
  | 'scale_horizontal'
  | 'scale_vertical'
  | 'update_env_var'
  | 'rotate_secret'
  | 'add_tool'
  | 'update_config';

/**
 * Dangerous operations (always require human approval)
 */
export type DangerousIaCOperation =
  | 'delete_table'
  | 'delete_bucket'
  | 'modify_iam'
  | 'modify_vpc'
  | 'modify_security_group'
  | 'delete_runtime';

/**
 * Infrastructure change proposal
 */
export interface InfrastructureChangeProposal {
  tenantId: string;
  changeDescription: string;
  changeType: IaCChangeType;
  parameters: Record<string, unknown>;
  estimatedMonthlyCostDelta: number;
  iacDiff?: string;  // CDK diff output
  cedarDecision?: 'ALLOW' | 'DENY';
  cedarReason?: string;
}

/**
 * Infrastructure change result
 */
export interface InfrastructureChangeResult {
  status: 'auto_applied' | 'pr_created' | 'denied';
  branch?: string;
  prId?: string;
  cedarDecision: 'ALLOW' | 'DENY';
  changeType: IaCChangeType;
  reason?: string;
}

/**
 * Emergency self-heal action
 */
export type SelfHealAction =
  | 'restart_runtime'
  | 'clear_cache'
  | 'reset_session';

// ============================================================
// Memory Evolution Types
// ============================================================

/**
 * Memory lifecycle states
 */
export type MemoryLifecycle =
  | 'active'
  | 'hot'
  | 'warm'
  | 'cold'
  | 'archived';

/**
 * Memory entry types
 */
export type MemoryType =
  | 'fact'
  | 'procedure'
  | 'preference'
  | 'decision';

/**
 * Memory entry source
 */
export type MemorySource =
  | 'user_stated'
  | 'agent_inferred'
  | 'tool_output';

/**
 * Memory entry in DynamoDB
 */
export interface EvolutionMemoryEntry {
  tenantId: string;
  agentId: string;
  memoryId: string;
  content: string;  // Max 2000 chars
  contentHash: string;  // SHA-256 for dedup
  embedding?: Buffer;  // 1536-dim vector (binary)
  type: MemoryType;
  source: MemorySource;
  createdAt: ISOTimestamp;
  lastAccessed: ISOTimestamp;
  accessCount: number;
  lifecycle: MemoryLifecycle;
  relatedMemories?: string[];
  tags?: string[];
}

/**
 * Memory evolution actions
 */
export interface MemoryEvolutionActions {
  pruned: Array<{ memoryId: string; reason: string }>;
  promoted: Array<{ memoryId: string; contentPreview: string; recommendation: string }>;
  merged: Array<{ keep: string; remove: string; reason: string }>;
  archived: Array<{ memoryId: string; reason: string }>;
  contradictions: Array<{
    memoryA: string;
    memoryB: string;
    similarity: number;
    recommendation: string;
  }>;
}

/**
 * Memory evolution result
 */
export interface MemoryEvolutionResult {
  tenantId: string;
  agentId: string;
  totalMemories: number;
  dryRun: boolean;
  actions: Record<keyof MemoryEvolutionActions, number>;
  details: MemoryEvolutionActions;
}

// ============================================================
// Cron Self-Scheduling Types
// ============================================================

/**
 * Scheduling opportunity suggestion
 */
export interface CronSuggestion {
  promptPattern: string;
  suggestedSchedule: string;  // Cron expression
  scheduleDescription: string;
  confidence: number;
  occurrences: number;
  sampleDates: string[];
}

/**
 * Scheduling pattern analysis
 */
export interface SchedulingAnalysis {
  tenantId: string;
  analysisPeriodDays: number;
  sessionsAnalyzed: number;
  suggestions: CronSuggestion[];
}

/**
 * Cron job creation request
 */
export interface CronJobRequest {
  tenantId: string;
  jobName: string;
  scheduleExpression: string;
  prompt: string;
  outputPath: string;
}

/**
 * Cron job creation result
 */
export interface CronJobResult {
  status: 'created' | 'denied';
  jobName?: string;
  schedule?: string;
  tenantId: string;
  reason?: string;
  policyErrors?: string[];
}

// ============================================================
// Feedback & User Signals Types
// ============================================================

/**
 * User feedback types
 */
export type FeedbackType =
  | 'thumbs_up'
  | 'thumbs_down'
  | 'correction'
  | 'remember'
  | 'rating';

/**
 * Feedback event
 */
export interface FeedbackEvent {
  tenantId: string;
  sessionId: string;
  turnIndex: number;
  feedbackType: FeedbackType;
  feedbackValue?: string;  // Correction text, rating, or memory
  modelUsed: ModelId;
  taskCategory: TaskCategory;
  agentResponse: string;  // Truncated
  userMessage: string;    // Truncated
  processed: boolean;
  consumedBy: string[];   // Which subsystems consumed it
  timestamp: ISOTimestamp;
}

/**
 * Feedback processing result
 */
export interface FeedbackProcessingResult {
  routedTo: string[];
  total: number;
}

// ============================================================
// Safety & Audit Types
// ============================================================

/**
 * Evolution event types
 */
export type EvolutionEventType =
  | 'evolution_prompt'
  | 'evolution_skill'
  | 'evolution_infra'
  | 'evolution_routing'
  | 'evolution_memory'
  | 'evolution_cron';

/**
 * Evolution action types
 */
export type EvolutionAction =
  | 'create'
  | 'update'
  | 'delete'
  | 'promote'
  | 'rollback';

/**
 * Cedar authorization result
 */
export interface CedarAuthResult {
  decision: 'ALLOW' | 'DENY';
  policyIds?: string[];
  errors?: string[];
}

/**
 * Evolution audit event
 */
export interface EvolutionAuditEvent {
  tenantId: string;
  eventType: EvolutionEventType;
  action: EvolutionAction;
  actor: string;  // agent_id or "system"
  cedarDecision: 'ALLOW' | 'DENY';
  cedarPolicyIds: string[];
  preStateS3?: string;   // S3 key for pre-change snapshot
  postStateS3?: string;  // S3 key for post-change snapshot
  changeSummary: string;
  costImpact: number;    // Estimated monthly cost delta
  rollbackAvailable: boolean;
  rolledBack: boolean;
  rolledBackAt?: ISOTimestamp;
  rollbackReason?: string;
  timestamp: ISOTimestamp;
  ttl?: number;  // Auto-expire after retention period
}

/**
 * Rollback request
 */
export interface RollbackRequest {
  tenantId: string;
  eventId: string;
  reason: string;
}

/**
 * Rollback result
 */
export interface RollbackResult {
  status: 'rolled_back' | 'error';
  eventId: string;
  eventType?: EvolutionEventType;
  reason?: string;
}

/**
 * Rate limit state for evolution operations
 */
export interface EvolutionRateLimits {
  tenantId: string;
  evolutionChangesToday: number;
  infraChangesToday: number;
  promptChangesThisWeek: number;
  lastResetDate: ISOTimestamp;
}

// ============================================================
// Evolution Metrics Types
// ============================================================

/**
 * Evolution health metrics
 */
export interface EvolutionMetrics {
  tenantId: string;
  date: ISOTimestamp;
  responseQuality: number;       // 0-1, thumbs up ratio
  taskCompletionRate: number;    // 0-1, tool success rate
  costEfficiency: number;        // current cost / baseline cost
  correctionRate: number;        // 0-1, user corrections / responses
  skillReuseRate: number;        // avg uses per week
  memoryHitRate: number;         // 0-1, useful memory retrieval rate
  rollbackRate: number;          // 0-1, rolled back changes / total changes
  healthScore: number;           // 0-100 composite score
}

/**
 * Evolution health score calculation weights
 */
export interface HealthScoreWeights {
  responseQuality: number;       // 0.25
  taskCompletion: number;        // 0.20
  costEfficiency: number;        // 0.15
  correctionRateInv: number;     // 0.15 (inverted)
  skillReuse: number;            // 0.10
  memoryHitRate: number;         // 0.10
  rollbackRateInv: number;       // 0.05 (inverted)
}

/**
 * Tenant metrics for health calculation
 */
export interface TenantMetrics {
  thumbsUpRatio: number;
  toolSuccessRate: number;
  baselineCost: number;
  currentCost: number;
  correctionRate: number;
  skillUsesPerWeek: number;
  memoryHitRate: number;
  rollbackRate: number;
}

// ============================================================
// Configuration Types
// ============================================================

/**
 * Evolution engine configuration
 */
export interface EvolutionConfig {
  /** DynamoDB table for evolution state */
  evolutionStateTable: string;

  /** S3 bucket for artifacts (prompts, snapshots) */
  artifactsBucket: string;

  /** Cedar policy store ID */
  policyStoreId: string;

  /** Maximum evolution changes per tenant per day */
  maxChangesPerDay: number;

  /** Maximum infrastructure changes per tenant per day */
  maxInfraChangesPerDay: number;

  /** Maximum prompt changes per tenant per week */
  maxPromptChangesPerWeek: number;

  /** Cost threshold requiring human approval ($) */
  humanApprovalCostThreshold: number;

  /** Default cost sensitivity (0=quality, 1=cost) */
  defaultCostSensitivity: number;

  /** Prompt A/B test duration (hours) */
  abTestDurationHours: number;

  /** Minimum pattern occurrences for skill generation */
  minPatternOccurrences: number;

  /** Memory GC stale threshold (days) */
  memoryStaleThresholdDays: number;
}

/** Cost per 1K tokens by model ID (USD) */
export const BEDROCK_MODELS: Record<string, number> = {
  'anthropic.claude-3-haiku-20240307-v1:0': 0.00025,
  'anthropic.claude-3-sonnet-20240229-v1:0': 0.003,
  'anthropic.claude-3-5-sonnet-20240620-v1:0': 0.003,
  'anthropic.claude-3-5-sonnet-20241022-v2:0': 0.003,
  'anthropic.claude-3-opus-20240229-v1:0': 0.015,
  'anthropic.claude-3-5-haiku-20241022-v1:0': 0.0008,
  'us.anthropic.claude-3-haiku-20240307-v1:0': 0.00025,
  'us.anthropic.claude-3-sonnet-20240229-v1:0': 0.003,
  'us.anthropic.claude-3-5-sonnet-20240620-v1:0': 0.003,
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': 0.003,
  'us.anthropic.claude-3-opus-20240229-v1:0': 0.015,
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': 0.0008,
  'us.amazon.nova-micro-v1:0': 0.000088,
  'us.amazon.nova-lite-v1:0': 0.00024,
  'us.anthropic.claude-sonnet-4-6-v1:0': 0.009,
  'us.anthropic.claude-opus-4-6-v1:0': 0.045,
};
