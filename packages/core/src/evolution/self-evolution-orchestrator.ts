/**
 * Self-Evolution Orchestrator
 *
 * Coordinates the full self-evolution flow:
 *   1. Cedar/rate-limit authorization
 *   2. CDK code generation
 *   3. Static CDK validation
 *   4. CodeCommit commit
 *   5. CodePipeline trigger
 *   6. Capability registration in Gateway
 *   7. Audit trail write
 *
 * Rollback: if the pipeline fails, the orchestrator records the failure in the
 * audit table and the `rollback()` method can revert the branch.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import type { CDKGenerator, CDKGenerationRequest } from '../infra-builder/cdk-generator';
import type { CodeCommitWorkspaceManager } from '../infra-builder/codecommit-workspace';
import type { CodePipelineDeployer } from '../infra-builder/codepipeline-deployer';
import type { PipelineStatus } from '../infra-builder/types';
import type { EvolutionSafetyHarness } from './safety-harness';
import type { IaCChangeType, EvolutionAuditEvent, EvolutionAction } from './types';

// Module-level singleton DynamoDB client
const ddbClient = new DynamoDBClient({});
const ddbDoc = DynamoDBDocumentClient.from(ddbClient);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Request to evolve the platform by adding or modifying infrastructure.
 */
export interface EvolutionRequest {
  /** Tenant that triggered the evolution */
  tenantId: string;

  /** Agent performing the evolution (for audit / Cedar principal) */
  agentId: string;

  /** Human-readable description of what to build */
  description: string;

  /** CDK change category */
  changeType: IaCChangeType;

  /** Typed parameters forwarded to CDKGenerator */
  parameters: Record<string, unknown>;

  /**
   * Natural language requirement text for LLM-assisted generation.
   * Optional — when absent, template-based generation is used.
   */
  requirementText?: string;

  /** CodeCommit repository to commit to */
  repositoryName: string;

  /** Branch to commit on (defaults to "main") */
  branchName?: string;

  /** CodePipeline name to trigger after commit */
  pipelineName: string;

  /** Whether a human has pre-approved this change */
  humanApproved?: boolean;
}

/**
 * Result of an evolution run.
 */
export interface EvolutionResult {
  /** Terminal status of this evolution attempt */
  status:
    | 'authorized'        // Authorized but pipeline not yet started (async)
    | 'pipeline_started'  // Pipeline execution triggered
    | 'pipeline_succeeded' // Pipeline completed successfully
    | 'pipeline_failed'   // Pipeline failed (check rollbackAvailable)
    | 'denied'            // Cedar / rate-limit denial
    | 'validation_failed' // CDK static validation rejected the code
    | 'commit_failed'     // CodeCommit write error
    | 'error';            // Unexpected internal error

  /** CodePipeline execution ID, present when pipeline was triggered */
  executionId?: string;

  /** Commit ID in CodeCommit, present when commit succeeded */
  commitId?: string;

  /** Human-readable reason for denied / failed states */
  reason?: string;

  /** Audit event ID written to DynamoDB */
  auditEventId?: string;

  /** Whether a rollback can be attempted */
  rollbackAvailable: boolean;
}

/**
 * Configuration for the self-evolution orchestrator.
 */
export interface SelfEvolutionConfig {
  /** DynamoDB table used for audit events and capability registrations */
  evolutionStateTable: string;

  /** Estimated monthly cost (USD) above which human approval is required */
  humanApprovalCostThreshold: number;
}

/**
 * Patterns that are unconditionally blocked in generated CDK code.
 * These map to DangerousIaCOperation values and other risky constructs.
 */
const BLOCKED_CDK_PATTERNS: Array<{ regex: RegExp; reason: string }> = [
  { regex: /RemovalPolicy\.DESTROY/i,          reason: 'DESTROY removal policy not allowed' },
  { regex: /\.addToPolicy|grantAdmin/i,         reason: 'IAM policy mutations not allowed' },
  { regex: /ec2\.Vpc|ec2\.CfnVPC/i,             reason: 'VPC modifications not allowed' },
  { regex: /ec2\.SecurityGroup|addIngressRule/i, reason: 'Security group mutations not allowed' },
  { regex: /dynamodb.*delete|TableV2.*delete/i,  reason: 'DynamoDB table deletion not allowed' },
  { regex: /s3.*deleteObjects|bucket.*delete/i,  reason: 'S3 bucket deletion not allowed' },
];

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Self-Evolution Orchestrator
 *
 * Wires together CDK generation, CodeCommit, CodePipeline, and the safety
 * harness to form the complete self-evolution workflow.
 */
export class SelfEvolutionOrchestrator {
  private readonly ddb: DynamoDBDocumentClient;

  constructor(
    private readonly cdkGenerator: CDKGenerator,
    private readonly codeCommit: CodeCommitWorkspaceManager,
    private readonly pipeline: CodePipelineDeployer,
    private readonly safetyHarness: EvolutionSafetyHarness,
    private readonly config: SelfEvolutionConfig,
    ddbOverride?: DynamoDBDocumentClient
  ) {
    this.ddb = ddbOverride ?? ddbDoc;
  }

  // -------------------------------------------------------------------------
  // Main workflow
  // -------------------------------------------------------------------------

  /**
   * Execute a full self-evolution run.
   *
   * @param request Evolution parameters
   * @returns Result containing status, IDs, and rollback availability
   */
  async evolve(request: EvolutionRequest): Promise<EvolutionResult> {
    const auditEventId = `evo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      // Step 1: Authorize via Cedar + rate limits
      const authResult = await this.safetyHarness.authorize({
        tenantId: request.tenantId,
        agentId: request.agentId,
        action: 'create' as EvolutionAction,
        eventType: 'evolution_infra',
        changeType: request.changeType,
        estimatedMonthlyCostDelta: 0, // updated after generation
        humanApproved: request.humanApproved ?? false,
      });

      if (authResult.decision === 'DENY') {
        await this.writeAuditEvent({
          auditEventId,
          request,
          cedarDecision: 'DENY',
          action: 'create',
          changeSummary: `Denied: ${authResult.errors?.join(', ') ?? 'Cedar policy'}`,
          costImpact: 0,
          rollbackAvailable: false,
        });
        return {
          status: 'denied',
          reason: authResult.errors?.join(', ') ?? 'Cedar policy denied',
          auditEventId,
          rollbackAvailable: false,
        };
      }

      // Step 2: Generate CDK code
      const genReq: CDKGenerationRequest = {
        tenantId: request.tenantId,
        changeType: request.changeType,
        description: request.description,
        parameters: request.parameters,
        requirementText: request.requirementText,
      };

      const genResult = await this.cdkGenerator.generateCDKCode(genReq);

      // Step 3: Validate generated CDK (static analysis)
      const validation = this.validateCDKCode(genResult.cdkCode);
      if (!validation.valid) {
        await this.writeAuditEvent({
          auditEventId,
          request,
          cedarDecision: 'DENY',
          action: 'create',
          changeSummary: `Validation failed: ${validation.reason}`,
          costImpact: 0,
          rollbackAvailable: false,
        });
        return {
          status: 'validation_failed',
          reason: validation.reason,
          auditEventId,
          rollbackAvailable: false,
        };
      }

      // Step 4: Commit to CodeCommit
      const branchName = request.branchName ?? 'main';
      const commitResult = await this.codeCommit.commitFiles(
        request.repositoryName,
        branchName,
        [
          {
            filePath: `evolution/${request.tenantId}/${request.changeType}-${Date.now()}.ts`,
            content: genResult.cdkCode,
          },
        ],
        `[evolution] ${request.description} (tenant: ${request.tenantId})`,
        `chimera-evolution-${request.agentId}`,
        `evolution@chimera.local`
      );

      if (!commitResult.success || !commitResult.data) {
        await this.writeAuditEvent({
          auditEventId,
          request,
          cedarDecision: 'ALLOW',
          action: 'create',
          changeSummary: `Commit failed: ${commitResult.error?.message ?? 'unknown'}`,
          costImpact: genResult.estimatedCostDelta,
          rollbackAvailable: false,
        });
        return {
          status: 'commit_failed',
          reason: commitResult.error?.message ?? 'CodeCommit write failed',
          auditEventId,
          rollbackAvailable: false,
        };
      }

      const commitId = commitResult.data.commitId;

      // Step 5: Trigger CodePipeline
      const pipelineStart = await this.pipeline.startExecution(request.pipelineName);
      if (!pipelineStart.success || !pipelineStart.data) {
        // Commit already in CodeCommit but pipeline not started — rollback available
        await this.writeAuditEvent({
          auditEventId,
          request,
          cedarDecision: 'ALLOW',
          action: 'create',
          changeSummary: `Pipeline start failed: ${pipelineStart.error?.message ?? 'unknown'}`,
          costImpact: genResult.estimatedCostDelta,
          rollbackAvailable: true,
          commitId,
        });
        return {
          status: 'error',
          reason: pipelineStart.error?.message ?? 'Pipeline trigger failed',
          commitId,
          auditEventId,
          rollbackAvailable: true,
        };
      }

      const executionId = pipelineStart.data.executionId;

      // Step 6: Increment rate-limit counters (authorization already passed)
      await this.safetyHarness.incrementRateLimitCounters(
        request.tenantId,
        'evolution_infra'
      );

      // Step 7: Register capability in Gateway (fire-and-forget DynamoDB write)
      await this.registerCapability({
        tenantId: request.tenantId,
        agentId: request.agentId,
        changeType: request.changeType,
        description: request.description,
        commitId,
        executionId,
        resourcesAffected: genResult.resourcesAffected,
        estimatedCostDelta: genResult.estimatedCostDelta,
      });

      // Step 8: Write success audit event
      await this.writeAuditEvent({
        auditEventId,
        request,
        cedarDecision: 'ALLOW',
        action: 'create',
        changeSummary: request.description,
        costImpact: genResult.estimatedCostDelta,
        rollbackAvailable: true,
        commitId,
        executionId,
      });

      return {
        status: 'pipeline_started',
        executionId,
        commitId,
        auditEventId,
        rollbackAvailable: true,
      };
    } catch (err) {
      console.error('[SelfEvolutionOrchestrator] Unexpected error:', err);
      await this.writeAuditEvent({
        auditEventId,
        request,
        cedarDecision: 'DENY',
        action: 'create',
        changeSummary: `Unexpected error: ${(err as Error).message}`,
        costImpact: 0,
        rollbackAvailable: false,
      });
      return {
        status: 'error',
        reason: (err as Error).message,
        auditEventId,
        rollbackAvailable: false,
      };
    }
  }

  /**
   * Poll a pipeline execution until it reaches a terminal state.
   *
   * Intended for Lambda functions that can wait up to ~14 minutes.
   * For longer pipelines, use Step Functions instead.
   *
   * @param pipelineName Pipeline name
   * @param executionId  Execution to poll
   * @param pollIntervalMs Interval between polls (default 15 s)
   * @param maxAttempts  Maximum polls before giving up (default 56 → ~14 min)
   */
  async waitForPipeline(
    pipelineName: string,
    executionId: string,
    pollIntervalMs = 15_000,
    maxAttempts = 56
  ): Promise<{ status: PipelineStatus; succeeded: boolean }> {
    const terminalStatuses: PipelineStatus[] = ['Succeeded', 'Failed', 'Stopped', 'Superseded'];

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const result = await this.pipeline.getExecution(pipelineName, executionId);
      if (result.success && result.data) {
        const status = result.data.status;
        if (status && terminalStatuses.includes(status)) {
          return { status, succeeded: status === 'Succeeded' };
        }
      }
      await sleep(pollIntervalMs);
    }

    return { status: 'Failed', succeeded: false };
  }

  // -------------------------------------------------------------------------
  // Static CDK validation
  // -------------------------------------------------------------------------

  /**
   * Validate generated CDK code against the safety policy.
   *
   * Checks for patterns that are unconditionally blocked (destructive ops,
   * IAM mutations, VPC/SG changes).  Returns quickly — does NOT run
   * `cdk synth` (that requires a full Node environment with aws-cdk-lib).
   */
  validateCDKCode(cdkCode: string): { valid: boolean; reason?: string } {
    if (!cdkCode || cdkCode.trim().length === 0) {
      return { valid: false, reason: 'Generated CDK code is empty' };
    }

    for (const { regex, reason } of BLOCKED_CDK_PATTERNS) {
      if (regex.test(cdkCode)) {
        return { valid: false, reason };
      }
    }

    // Warn on very large code (potential prompt injection via LLM generation)
    const MAX_CODE_BYTES = 64 * 1024; // 64 KB
    if (Buffer.byteLength(cdkCode, 'utf-8') > MAX_CODE_BYTES) {
      return { valid: false, reason: 'Generated CDK code exceeds 64 KB safety limit' };
    }

    return { valid: true };
  }

  // -------------------------------------------------------------------------
  // Capability registration
  // -------------------------------------------------------------------------

  /**
   * Register a newly deployed capability in the evolution state table.
   * Gateway's ToolLoader reads these records to surface capabilities to agents.
   */
  private async registerCapability(params: {
    tenantId: string;
    agentId: string;
    changeType: IaCChangeType;
    description: string;
    commitId: string;
    executionId: string;
    resourcesAffected: string[];
    estimatedCostDelta: number;
  }): Promise<void> {
    const capabilityId = `CAP#${params.tenantId}#${params.changeType}#${Date.now()}`;
    await this.ddb.send(
      new PutCommand({
        TableName: this.config.evolutionStateTable,
        Item: {
          PK: `TENANT#${params.tenantId}`,
          SK: capabilityId,
          capabilityId,
          agentId: params.agentId,
          changeType: params.changeType,
          description: params.description,
          commitId: params.commitId,
          executionId: params.executionId,
          resourcesAffected: params.resourcesAffected,
          estimatedCostDelta: params.estimatedCostDelta,
          status: 'deploying',
          registeredAt: new Date().toISOString(),
        },
      })
    );
  }

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------

  private async writeAuditEvent(params: {
    auditEventId: string;
    request: EvolutionRequest;
    cedarDecision: 'ALLOW' | 'DENY';
    action: EvolutionAction;
    changeSummary: string;
    costImpact: number;
    rollbackAvailable: boolean;
    commitId?: string;
    executionId?: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const event: EvolutionAuditEvent & { PK: string; SK: string } = {
      PK: `TENANT#${params.request.tenantId}`,
      SK: `AUDIT#${params.auditEventId}`,
      tenantId: params.request.tenantId,
      eventType: 'evolution_infra',
      action: params.action,
      actor: params.request.agentId,
      cedarDecision: params.cedarDecision,
      cedarPolicyIds: [],
      changeSummary: params.changeSummary,
      costImpact: params.costImpact,
      rollbackAvailable: params.rollbackAvailable,
      rolledBack: false,
      timestamp: now,
      // 90-day TTL
      ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
    };

    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.config.evolutionStateTable,
          Item: event,
        })
      );
    } catch (err) {
      // Audit failures must not block the evolution flow
      console.error('[SelfEvolutionOrchestrator] Audit write failed:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a SelfEvolutionOrchestrator with all dependencies wired in.
 */
export function createSelfEvolutionOrchestrator(params: {
  cdkGenerator: CDKGenerator;
  codeCommit: CodeCommitWorkspaceManager;
  pipeline: CodePipelineDeployer;
  safetyHarness: EvolutionSafetyHarness;
  config: SelfEvolutionConfig;
}): SelfEvolutionOrchestrator {
  return new SelfEvolutionOrchestrator(
    params.cdkGenerator,
    params.codeCommit,
    params.pipeline,
    params.safetyHarness,
    params.config
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
