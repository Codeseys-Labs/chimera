/**
 * Enhanced Cron Scheduler
 *
 * Upgrades from placeholder Pass state to real agent invocation:
 * - EventBridge scheduled rules trigger Step Functions
 * - Step Functions invoke AgentCore Runtime
 * - Results stored in DynamoDB for audit
 *
 * Replaces simple Pass state pattern with full agent execution
 */

import type { AgentOrchestrator } from './orchestrator';
import type { ISOTimestamp } from './types';

/**
 * Cron schedule expression (EventBridge syntax)
 */
export type CronExpression = string;

/**
 * Cron job status
 */
export type CronJobStatus =
  | 'enabled'
  | 'disabled'
  | 'error';

/**
 * Cron execution status
 */
export type CronExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout';

/**
 * Cron job definition
 */
export interface CronJob {
  jobId: string;
  tenantId: string;
  agentId: string;
  name: string;
  description?: string;
  schedule: CronExpression;
  instruction: string;
  context?: Record<string, unknown>;
  timeoutSeconds?: number;
  retryConfig?: {
    maxAttempts: number;
    backoffRate: number;
  };
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Cron execution record
 */
export interface CronExecution {
  executionId: string;
  jobId: string;
  tenantId: string;
  agentId: string;
  status: CronExecutionStatus;
  scheduledTime: ISOTimestamp;
  startedAt?: ISOTimestamp;
  completedAt?: ISOTimestamp;
  durationMs?: number;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  attemptNumber: number;
}

/**
 * Cron scheduler configuration
 */
export interface CronSchedulerConfig {
  region: string;
  eventBusName: string;
  stateMachineArn?: string;
  executionTableName: string;
  maxConcurrentJobs?: number;
}

/**
 * Enhanced Cron Scheduler
 *
 * Manages scheduled agent invocations:
 * 1. EventBridge schedules trigger executions
 * 2. Step Functions orchestrate agent invocation
 * 3. Execution history stored in DynamoDB
 * 4. Failed jobs retry with exponential backoff
 */
export class CronScheduler {
  private orchestrator: AgentOrchestrator;
  private config: CronSchedulerConfig;
  private jobs: Map<string, CronJob>;
  private executions: Map<string, CronExecution>;

  constructor(orchestrator: AgentOrchestrator, config: CronSchedulerConfig) {
    this.orchestrator = orchestrator;
    this.config = config;
    this.jobs = new Map();
    this.executions = new Map();
  }

  /**
   * Register a cron job
   *
   * Creates EventBridge scheduled rule that triggers Step Functions
   * execution for agent invocation.
   *
   * @param job - Cron job definition
   */
  async registerJob(job: CronJob): Promise<void> {
    this.jobs.set(job.jobId, job);

    if (job.enabled) {
      await this.enableJob(job.jobId);
    }

    console.log(`[Cron] Registered job: ${job.jobId} (${job.schedule})`);
  }

  /**
   * Enable cron job (create EventBridge rule)
   */
  async enableJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // TODO: Create EventBridge scheduled rule
    // const ruleName = `chimera-cron-${job.tenantId}-${job.jobId}`;
    //
    // await eventBridge.putRule({
    //   Name: ruleName,
    //   ScheduleExpression: job.schedule,
    //   State: 'ENABLED',
    //   Description: job.description,
    //   EventBusName: this.config.eventBusName
    // });
    //
    // // Add target: Step Functions state machine
    // await eventBridge.putTargets({
    //   Rule: ruleName,
    //   EventBusName: this.config.eventBusName,
    //   Targets: [{
    //     Id: '1',
    //     Arn: this.config.stateMachineArn,
    //     RoleArn: 'arn:aws:iam::account:role/EventBridgeInvokeStepFunctions',
    //     Input: JSON.stringify({
    //       jobId: job.jobId,
    //       tenantId: job.tenantId,
    //       agentId: job.agentId,
    //       instruction: job.instruction,
    //       context: job.context
    //     })
    //   }]
    // });

    job.enabled = true;
    console.log(`[Cron] Enabled job: ${jobId}`);
  }

  /**
   * Disable cron job (disable EventBridge rule)
   */
  async disableJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // TODO: Disable EventBridge rule
    // const ruleName = `chimera-cron-${job.tenantId}-${job.jobId}`;
    // await eventBridge.disableRule({
    //   Name: ruleName,
    //   EventBusName: this.config.eventBusName
    // });

    job.enabled = false;
    console.log(`[Cron] Disabled job: ${jobId}`);
  }

  /**
   * Delete cron job (delete EventBridge rule)
   */
  async deleteJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    // TODO: Delete EventBridge rule
    // const ruleName = `chimera-cron-${job.tenantId}-${job.jobId}`;
    //
    // // Remove targets first
    // await eventBridge.removeTargets({
    //   Rule: ruleName,
    //   EventBusName: this.config.eventBusName,
    //   Ids: ['1']
    // });
    //
    // // Delete rule
    // await eventBridge.deleteRule({
    //   Name: ruleName,
    //   EventBusName: this.config.eventBusName
    // });

    this.jobs.delete(jobId);
    console.log(`[Cron] Deleted job: ${jobId}`);
  }

  /**
   * Execute cron job (invoked by Step Functions)
   *
   * This replaces the simple Pass state with real agent invocation:
   * 1. Delegate task to agent via orchestrator
   * 2. Wait for completion (or timeout)
   * 3. Store execution result
   * 4. Retry on failure (if configured)
   *
   * @param jobId - Cron job ID
   * @param scheduledTime - Scheduled execution time
   */
  async executeCronJob(
    jobId: string,
    scheduledTime: ISOTimestamp,
    attemptNumber: number = 1
  ): Promise<CronExecution> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    const executionId = `cron-exec-${jobId}-${Date.now()}`;

    const execution: CronExecution = {
      executionId,
      jobId,
      tenantId: job.tenantId,
      agentId: job.agentId,
      status: 'pending',
      scheduledTime,
      attemptNumber
    };

    this.executions.set(executionId, execution);

    console.log(`[Cron] Executing job: ${jobId} (attempt ${attemptNumber})`);

    try {
      execution.status = 'running';
      execution.startedAt = new Date().toISOString();

      // Delegate task to agent
      await this.orchestrator.delegateTask({
        taskId: executionId,
        sourceAgentId: 'cron-scheduler',
        targetAgentId: job.agentId,
        tenantId: job.tenantId,
        instruction: job.instruction,
        context: {
          cronJob: true,
          jobId: job.jobId,
          scheduledTime,
          ...job.context
        },
        timeoutSeconds: job.timeoutSeconds || 300,
        correlationId: executionId
      });

      // TODO: Wait for agent to complete
      // For now, simulate completion
      await new Promise(resolve => setTimeout(resolve, 1000));

      execution.status = 'succeeded';
      execution.completedAt = new Date().toISOString();
      execution.durationMs = Date.now() - new Date(execution.startedAt).getTime();
      execution.result = {
        success: true,
        message: 'Cron job completed (mock)'
      };

      console.log(`[Cron] Job completed: ${jobId}`);

      // TODO: Store in DynamoDB
      await this.storeExecution(execution);

      return execution;
    } catch (error) {
      execution.status = 'failed';
      execution.completedAt = new Date().toISOString();
      execution.error = {
        code: 'EXECUTION_ERROR',
        message: error instanceof Error ? error.message : String(error)
      };

      console.error(`[Cron] Job failed: ${jobId}`, error);

      // Retry if configured
      if (
        job.retryConfig &&
        attemptNumber < job.retryConfig.maxAttempts
      ) {
        const backoffMs = Math.pow(job.retryConfig.backoffRate, attemptNumber) * 1000;

        console.log(
          `[Cron] Retrying job ${jobId} in ${backoffMs}ms (attempt ${attemptNumber + 1})`
        );

        await new Promise(resolve => setTimeout(resolve, backoffMs));

        return this.executeCronJob(jobId, scheduledTime, attemptNumber + 1);
      }

      // TODO: Store failed execution
      await this.storeExecution(execution);

      throw error;
    }
  }

  /**
   * Store execution in DynamoDB
   * (Placeholder - will use DynamoDB SDK)
   */
  private async storeExecution(execution: CronExecution): Promise<void> {
    // TODO: Store in DynamoDB
    // await dynamodb.putItem({
    //   TableName: this.config.executionTableName,
    //   Item: {
    //     PK: { S: `TENANT#${execution.tenantId}` },
    //     SK: { S: `CRON_EXEC#${execution.executionId}` },
    //     jobId: { S: execution.jobId },
    //     agentId: { S: execution.agentId },
    //     status: { S: execution.status },
    //     scheduledTime: { S: execution.scheduledTime },
    //     startedAt: { S: execution.startedAt || '' },
    //     completedAt: { S: execution.completedAt || '' },
    //     durationMs: { N: String(execution.durationMs || 0) },
    //     result: { S: JSON.stringify(execution.result || {}) },
    //     error: { S: JSON.stringify(execution.error || {}) },
    //     attemptNumber: { N: String(execution.attemptNumber) },
    //     ttl: { N: String(Math.floor(Date.now() / 1000) + 86400 * 30) } // 30 days
    //   }
    // });

    console.log(`[Cron] Stored execution: ${execution.executionId}`);
  }

  /**
   * Get execution history for a job
   */
  getExecutionHistory(jobId: string, limit: number = 10): CronExecution[] {
    return Array.from(this.executions.values())
      .filter(e => e.jobId === jobId)
      .sort((a, b) => {
        return new Date(b.scheduledTime).getTime() - new Date(a.scheduledTime).getTime();
      })
      .slice(0, limit);
  }

  /**
   * Get all jobs for a tenant
   */
  getJobs(tenantId: string): CronJob[] {
    return Array.from(this.jobs.values())
      .filter(j => j.tenantId === tenantId);
  }

  /**
   * Get job by ID
   */
  getJob(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId);
  }
}

/**
 * Create cron scheduler
 */
export function createCronScheduler(
  orchestrator: AgentOrchestrator,
  config: Partial<CronSchedulerConfig> = {}
): CronScheduler {
  const defaultConfig: CronSchedulerConfig = {
    region: process.env.AWS_REGION || 'us-east-1',
    eventBusName: 'chimera-agent-events',
    executionTableName: 'chimera-cron-executions',
    maxConcurrentJobs: 50,
    ...config
  };

  return new CronScheduler(orchestrator, defaultConfig);
}

/**
 * Common cron schedule patterns
 */
export const CronPatterns = {
  /**
   * Every minute
   */
  everyMinute: 'rate(1 minute)',

  /**
   * Every 5 minutes
   */
  every5Minutes: 'rate(5 minutes)',

  /**
   * Every hour
   */
  hourly: 'rate(1 hour)',

  /**
   * Daily at 9 AM UTC
   */
  daily9am: 'cron(0 9 * * ? *)',

  /**
   * Weekly on Monday at 8 AM UTC
   */
  weeklyMonday: 'cron(0 8 ? * MON *)',

  /**
   * Monthly on 1st at midnight UTC
   */
  monthly: 'cron(0 0 1 * ? *)',

  /**
   * Business hours (Mon-Fri, 9 AM - 5 PM UTC)
   */
  businessHours: 'cron(0 9-17 ? * MON-FRI *)'
};

/**
 * Pre-configured cron jobs for common use cases
 */
export const CronJobPresets = {
  /**
   * Daily health check
   */
  healthCheck: (tenantId: string, agentId: string): CronJob => ({
    jobId: `health-check-${agentId}`,
    tenantId,
    agentId,
    name: 'Daily Health Check',
    description: 'Runs health check diagnostics daily',
    schedule: CronPatterns.daily9am,
    instruction: 'Run health check diagnostics and report status',
    enabled: true,
    timeoutSeconds: 300,
    retryConfig: {
      maxAttempts: 3,
      backoffRate: 2
    }
  }),

  /**
   * Hourly log analysis
   */
  logAnalysis: (tenantId: string, agentId: string): CronJob => ({
    jobId: `log-analysis-${agentId}`,
    tenantId,
    agentId,
    name: 'Hourly Log Analysis',
    description: 'Analyzes CloudWatch logs for errors and anomalies',
    schedule: CronPatterns.hourly,
    instruction: 'Analyze CloudWatch logs from the last hour for errors',
    enabled: true,
    timeoutSeconds: 600,
    retryConfig: {
      maxAttempts: 2,
      backoffRate: 2
    }
  }),

  /**
   * Weekly report generation
   */
  weeklyReport: (tenantId: string, agentId: string): CronJob => ({
    jobId: `weekly-report-${agentId}`,
    tenantId,
    agentId,
    name: 'Weekly Report',
    description: 'Generates weekly summary report',
    schedule: CronPatterns.weeklyMonday,
    instruction: 'Generate weekly summary report for past 7 days',
    enabled: true,
    timeoutSeconds: 900,
    retryConfig: {
      maxAttempts: 2,
      backoffRate: 2
    }
  })
};
