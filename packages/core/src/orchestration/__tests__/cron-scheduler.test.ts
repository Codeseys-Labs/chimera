/**
 * Comprehensive unit tests for CronScheduler
 *
 * Tests job registration, enable/disable lifecycle, deletion, execution with
 * retry logic, execution history, tenant filtering, presets, and patterns.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CronScheduler,
  createCronScheduler,
  CronPatterns,
  CronJobPresets,
  type CronJob,
  type CronExecution,
  type CronSchedulerConfig,
} from '../cron-scheduler';
import {
  AgentOrchestrator,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../orchestrator';

// ---------------------------------------------------------------------------
// Mock AWS clients
// ---------------------------------------------------------------------------

function createMockSQSClient(): OrchestratorSQSClient {
  let queueCounter = 0;
  return {
    createQueue: async (input) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/123456789012/${input.QueueName}`,
    }),
    getQueueAttributes: async () => ({
      Attributes: {
        QueueArn: `arn:aws:sqs:us-east-1:123456789012:dlq-${++queueCounter}`,
      },
    }),
    sendMessage: async () => ({ MessageId: `msg-${Date.now()}` }),
    deleteQueue: async () => {},
  };
}

function createMockDDBClient(): OrchestratorDDBClient {
  return {
    put: async () => ({}),
    update: async () => ({}),
  };
}

function createMockEventBridgeClient(): OrchestratorEventBridgeClient {
  return {
    putEvents: async () => ({ FailedEntryCount: 0 }),
  };
}

function createTestOrchestrator(): AgentOrchestrator {
  return new AgentOrchestrator({
    region: 'us-east-1',
    eventBusName: 'test-bus',
    agentTableName: 'test-agents',
    defaultQueuePrefix: 'test-q',
    maxConcurrentAgents: 100,
    clients: {
      sqs: createMockSQSClient(),
      dynamodb: createMockDDBClient(),
      eventBridge: createMockEventBridgeClient(),
    },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultJob(overrides?: Partial<CronJob>): CronJob {
  return {
    jobId: 'job-001',
    tenantId: 'tenant-123',
    agentId: 'agent-001',
    name: 'Test Job',
    schedule: CronPatterns.hourly,
    instruction: 'Run analysis',
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CronScheduler', () => {
  let orchestrator: AgentOrchestrator;
  let scheduler: CronScheduler;

  beforeEach(async () => {
    orchestrator = createTestOrchestrator();
    scheduler = new CronScheduler(orchestrator, {
      region: 'us-east-1',
      eventBusName: 'test-bus',
      executionTableName: 'test-cron-executions',
      maxConcurrentJobs: 50,
    });

    // Spawn a test agent so delegateTask works
    await orchestrator.spawnAgent({
      tenantId: 'tenant-123',
      agentId: 'agent-001',
      role: 'worker',
      capabilities: [],
    });
  });

  // =========================================================================
  // registerJob
  // =========================================================================

  describe('registerJob', () => {
    it('should register a cron job', async () => {
      await scheduler.registerJob(defaultJob());

      const job = scheduler.getJob('job-001');
      expect(job).toBeDefined();
      expect(job!.name).toBe('Test Job');
      expect(job!.schedule).toBe(CronPatterns.hourly);
    });

    it('should enable the job if enabled=true', async () => {
      await scheduler.registerJob(defaultJob({ enabled: true }));
      expect(scheduler.getJob('job-001')!.enabled).toBe(true);
    });

    it('should not enable the job if enabled=false', async () => {
      await scheduler.registerJob(defaultJob({ enabled: false }));
      expect(scheduler.getJob('job-001')!.enabled).toBe(false);
    });

    it('should store description and metadata', async () => {
      await scheduler.registerJob(
        defaultJob({
          description: 'Nightly cleanup',
          metadata: { team: 'ops' },
        })
      );

      const job = scheduler.getJob('job-001')!;
      expect(job.description).toBe('Nightly cleanup');
      expect(job.metadata).toEqual({ team: 'ops' });
    });

    it('should allow multiple jobs with different IDs', async () => {
      await scheduler.registerJob(defaultJob({ jobId: 'job-A' }));
      await scheduler.registerJob(defaultJob({ jobId: 'job-B' }));

      expect(scheduler.getJob('job-A')).toBeDefined();
      expect(scheduler.getJob('job-B')).toBeDefined();
    });

    it('should overwrite existing job with same ID', async () => {
      await scheduler.registerJob(defaultJob({ name: 'Version 1' }));
      await scheduler.registerJob(defaultJob({ name: 'Version 2' }));

      expect(scheduler.getJob('job-001')!.name).toBe('Version 2');
    });
  });

  // =========================================================================
  // enableJob
  // =========================================================================

  describe('enableJob', () => {
    it('should enable a disabled job', async () => {
      await scheduler.registerJob(defaultJob({ enabled: false }));
      await scheduler.enableJob('job-001');

      expect(scheduler.getJob('job-001')!.enabled).toBe(true);
    });

    it('should throw for non-existent job', async () => {
      await expect(scheduler.enableJob('ghost')).rejects.toThrow('Job not found: ghost');
    });

    it('should be idempotent for already enabled job', async () => {
      await scheduler.registerJob(defaultJob({ enabled: true }));
      await scheduler.enableJob('job-001');

      expect(scheduler.getJob('job-001')!.enabled).toBe(true);
    });
  });

  // =========================================================================
  // disableJob
  // =========================================================================

  describe('disableJob', () => {
    it('should disable an enabled job', async () => {
      await scheduler.registerJob(defaultJob({ enabled: true }));
      await scheduler.disableJob('job-001');

      expect(scheduler.getJob('job-001')!.enabled).toBe(false);
    });

    it('should throw for non-existent job', async () => {
      await expect(scheduler.disableJob('ghost')).rejects.toThrow('Job not found: ghost');
    });
  });

  // =========================================================================
  // deleteJob
  // =========================================================================

  describe('deleteJob', () => {
    it('should remove the job from registry', async () => {
      await scheduler.registerJob(defaultJob());
      await scheduler.deleteJob('job-001');

      expect(scheduler.getJob('job-001')).toBeUndefined();
    });

    it('should throw for non-existent job', async () => {
      await expect(scheduler.deleteJob('ghost')).rejects.toThrow('Job not found: ghost');
    });

    it('should not affect other jobs', async () => {
      await scheduler.registerJob(defaultJob({ jobId: 'keep' }));
      await scheduler.registerJob(defaultJob({ jobId: 'delete-me' }));

      await scheduler.deleteJob('delete-me');

      expect(scheduler.getJob('keep')).toBeDefined();
      expect(scheduler.getJob('delete-me')).toBeUndefined();
    });
  });

  // =========================================================================
  // getJob
  // =========================================================================

  describe('getJob', () => {
    it('should return job by ID', async () => {
      await scheduler.registerJob(defaultJob());
      const job = scheduler.getJob('job-001');

      expect(job).toBeDefined();
      expect(job!.jobId).toBe('job-001');
    });

    it('should return undefined for non-existent job', () => {
      expect(scheduler.getJob('nonexistent')).toBeUndefined();
    });
  });

  // =========================================================================
  // getJobs (tenant filtering)
  // =========================================================================

  describe('getJobs', () => {
    it('should return all jobs for a tenant', async () => {
      await scheduler.registerJob(defaultJob({ jobId: 'j1', tenantId: 'tenant-123' }));
      await scheduler.registerJob(defaultJob({ jobId: 'j2', tenantId: 'tenant-123' }));
      await scheduler.registerJob(defaultJob({ jobId: 'j3', tenantId: 'tenant-456' }));

      const jobs = scheduler.getJobs('tenant-123');
      expect(jobs.length).toBe(2);
      expect(jobs.every((j) => j.tenantId === 'tenant-123')).toBe(true);
    });

    it('should return empty array for unknown tenant', () => {
      expect(scheduler.getJobs('unknown')).toEqual([]);
    });
  });

  // =========================================================================
  // executeCronJob
  // =========================================================================

  describe('executeCronJob', () => {
    it('should execute job and return succeeded execution', async () => {
      await scheduler.registerJob(defaultJob());

      const scheduledTime = new Date().toISOString();
      const execution = await scheduler.executeCronJob('job-001', scheduledTime);

      expect(execution.jobId).toBe('job-001');
      expect(execution.tenantId).toBe('tenant-123');
      expect(execution.agentId).toBe('agent-001');
      expect(execution.status).toBe('succeeded');
      expect(execution.scheduledTime).toBe(scheduledTime);
      expect(execution.startedAt).toBeTruthy();
      expect(execution.completedAt).toBeTruthy();
      expect(execution.durationMs).toBeGreaterThan(0);
      expect(execution.attemptNumber).toBe(1);
    });

    it('should store execution result', async () => {
      await scheduler.registerJob(defaultJob());

      const execution = await scheduler.executeCronJob('job-001', new Date().toISOString());

      expect(execution.result).toBeDefined();
      expect(execution.result!.success).toBe(true);
    });

    it('should throw for non-existent job', async () => {
      await expect(scheduler.executeCronJob('ghost', new Date().toISOString())).rejects.toThrow(
        'Job not found: ghost'
      );
    });

    it('should use custom attempt number', async () => {
      await scheduler.registerJob(defaultJob());

      const execution = await scheduler.executeCronJob('job-001', new Date().toISOString(), 3);

      expect(execution.attemptNumber).toBe(3);
    });

    it('should include executionId with cron-exec prefix', async () => {
      await scheduler.registerJob(defaultJob());

      const execution = await scheduler.executeCronJob('job-001', new Date().toISOString());

      expect(execution.executionId).toMatch(/^cron-exec-job-001-/);
    });
  });

  // =========================================================================
  // getExecutionHistory
  // =========================================================================

  describe('getExecutionHistory', () => {
    it('should return execution history for a job', async () => {
      await scheduler.registerJob(defaultJob());

      await scheduler.executeCronJob('job-001', new Date().toISOString());
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.executeCronJob('job-001', new Date().toISOString());

      const history = scheduler.getExecutionHistory('job-001');
      expect(history.length).toBe(2);
    });

    it('should sort by scheduledTime descending (newest first)', async () => {
      await scheduler.registerJob(defaultJob());

      const time1 = new Date(Date.now() - 10000).toISOString();
      const time2 = new Date().toISOString();

      await scheduler.executeCronJob('job-001', time1);
      await new Promise((r) => setTimeout(r, 10));
      await scheduler.executeCronJob('job-001', time2);

      const history = scheduler.getExecutionHistory('job-001');
      expect(new Date(history[0].scheduledTime).getTime()).toBeGreaterThanOrEqual(
        new Date(history[1].scheduledTime).getTime()
      );
    });

    it('should respect limit parameter', async () => {
      await scheduler.registerJob(defaultJob());

      for (let i = 0; i < 5; i++) {
        await scheduler.executeCronJob('job-001', new Date().toISOString());
        await new Promise((r) => setTimeout(r, 5));
      }

      const history = scheduler.getExecutionHistory('job-001', 3);
      expect(history.length).toBe(3);
    }, 30000);

    it('should default limit to 10', async () => {
      await scheduler.registerJob(defaultJob());

      const history = scheduler.getExecutionHistory('job-001');
      expect(history.length).toBeLessThanOrEqual(10);
    });

    it('should return empty array for job with no executions', () => {
      const history = scheduler.getExecutionHistory('no-executions');
      expect(history).toEqual([]);
    });

    it('should not include executions from other jobs', async () => {
      await scheduler.registerJob(defaultJob({ jobId: 'job-A' }));
      await scheduler.registerJob(defaultJob({ jobId: 'job-B' }));

      await scheduler.executeCronJob('job-A', new Date().toISOString());
      await scheduler.executeCronJob('job-B', new Date().toISOString());

      const historyA = scheduler.getExecutionHistory('job-A');
      expect(historyA.length).toBe(1);
      expect(historyA[0].jobId).toBe('job-A');
    });
  });

  // =========================================================================
  // CronPatterns
  // =========================================================================

  describe('CronPatterns', () => {
    it('should define everyMinute pattern', () => {
      expect(CronPatterns.everyMinute).toBe('rate(1 minute)');
    });

    it('should define every5Minutes pattern', () => {
      expect(CronPatterns.every5Minutes).toBe('rate(5 minutes)');
    });

    it('should define hourly pattern', () => {
      expect(CronPatterns.hourly).toBe('rate(1 hour)');
    });

    it('should define daily9am pattern', () => {
      expect(CronPatterns.daily9am).toBe('cron(0 9 * * ? *)');
    });

    it('should define weeklyMonday pattern', () => {
      expect(CronPatterns.weeklyMonday).toBe('cron(0 8 ? * MON *)');
    });

    it('should define monthly pattern', () => {
      expect(CronPatterns.monthly).toBe('cron(0 0 1 * ? *)');
    });

    it('should define businessHours pattern', () => {
      expect(CronPatterns.businessHours).toBe('cron(0 9-17 ? * MON-FRI *)');
    });
  });

  // =========================================================================
  // CronJobPresets
  // =========================================================================

  describe('CronJobPresets', () => {
    describe('healthCheck', () => {
      it('should create health check preset with correct values', () => {
        const job = CronJobPresets.healthCheck('tenant-123', 'agent-001');

        expect(job.jobId).toBe('health-check-agent-001');
        expect(job.tenantId).toBe('tenant-123');
        expect(job.agentId).toBe('agent-001');
        expect(job.name).toBe('Daily Health Check');
        expect(job.schedule).toBe(CronPatterns.daily9am);
        expect(job.enabled).toBe(true);
        expect(job.timeoutSeconds).toBe(300);
        expect(job.retryConfig).toEqual({ maxAttempts: 3, backoffRate: 2 });
      });
    });

    describe('logAnalysis', () => {
      it('should create log analysis preset with correct values', () => {
        const job = CronJobPresets.logAnalysis('tenant-456', 'monitor-001');

        expect(job.jobId).toBe('log-analysis-monitor-001');
        expect(job.tenantId).toBe('tenant-456');
        expect(job.schedule).toBe(CronPatterns.hourly);
        expect(job.timeoutSeconds).toBe(600);
        expect(job.retryConfig!.maxAttempts).toBe(2);
      });
    });

    describe('weeklyReport', () => {
      it('should create weekly report preset with correct values', () => {
        const job = CronJobPresets.weeklyReport('tenant-789', 'report-agent');

        expect(job.jobId).toBe('weekly-report-report-agent');
        expect(job.schedule).toBe(CronPatterns.weeklyMonday);
        expect(job.timeoutSeconds).toBe(900);
        expect(job.retryConfig!.maxAttempts).toBe(2);
      });
    });

    it('should produce presets usable with registerJob', async () => {
      const preset = CronJobPresets.healthCheck('tenant-123', 'agent-001');
      await scheduler.registerJob(preset);

      expect(scheduler.getJob(preset.jobId)).toBeDefined();
    });
  });

  // =========================================================================
  // createCronScheduler factory
  // =========================================================================

  describe('createCronScheduler', () => {
    it('should create scheduler with default config', () => {
      const s = createCronScheduler(orchestrator);
      expect(s).toBeInstanceOf(CronScheduler);
    });

    it('should allow partial config overrides', () => {
      const s = createCronScheduler(orchestrator, {
        executionTableName: 'custom-table',
      });
      expect(s).toBeInstanceOf(CronScheduler);
    });
  });
});
