/**
 * Unit tests for CronScheduler
 *
 * EventBridge rule creation and DynamoDB execution storage are skeletons
 * (Wave-14 audit M2). `enableJob`, `disableJob`, `deleteJob`,
 * `executeCronJob`, and the private `storeExecution` now throw
 * `not implemented`; the previous stubs flipped local booleans and
 * fabricated "succeeded" results while nothing reached AWS. These tests
 * codify the new contract and preserve coverage for the still-real
 * surface: `registerJob` (registry write), getters, presets, and
 * `CronPatterns`.
 *
 * Note: `AgentOrchestrator.spawnAgent` is also gated (M1), so no tenant
 * agents can be registered from tests. Tests here no longer rely on a
 * spawned agent — the scheduler is exercised in isolation.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CronScheduler,
  createCronScheduler,
  CronPatterns,
  CronJobPresets,
  type CronJob,
} from '../cron-scheduler';
import {
  AgentOrchestrator,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../orchestrator';

// ---------------------------------------------------------------------------
// Mock AWS clients (only required for AgentOrchestrator construction)
// ---------------------------------------------------------------------------

function createMockSQSClient(): OrchestratorSQSClient {
  return {
    createQueue: async (input) => ({
      QueueUrl: `https://sqs.us-east-1.amazonaws.com/TESTACCT/${input.QueueName}`,
    }),
    getQueueAttributes: async () => ({
      Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:TESTACCT:test-dlq' },
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

  beforeEach(() => {
    orchestrator = createTestOrchestrator();
    scheduler = new CronScheduler(orchestrator, {
      region: 'us-east-1',
      eventBusName: 'test-bus',
      executionTableName: 'test-cron-executions',
      maxConcurrentJobs: 50,
    });
  });

  // =========================================================================
  // registerJob — still a real local-registry write
  // =========================================================================

  describe('registerJob', () => {
    it('should register a cron job', async () => {
      await scheduler.registerJob(defaultJob());

      const job = scheduler.getJob('job-001');
      expect(job).toBeDefined();
      expect(job!.name).toBe('Test Job');
      expect(job!.schedule).toBe(CronPatterns.hourly);
    });

    it('should store the enabled flag as provided (no EventBridge call)', async () => {
      await scheduler.registerJob(defaultJob({ enabled: true }));
      expect(scheduler.getJob('job-001')!.enabled).toBe(true);

      await scheduler.registerJob(defaultJob({ jobId: 'job-002', enabled: false }));
      expect(scheduler.getJob('job-002')!.enabled).toBe(false);
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
  // AWS lifecycle methods throw "not implemented"
  // =========================================================================

  describe('enableJob', () => {
    it('should throw "not implemented" for a registered job', async () => {
      await scheduler.registerJob(defaultJob({ enabled: false }));
      await expect(scheduler.enableJob('job-001')).rejects.toThrow('not implemented');
    });

    it('should still throw "Job not found" for missing jobs (validation runs first)', async () => {
      await expect(scheduler.enableJob('ghost')).rejects.toThrow('Job not found: ghost');
    });
  });

  describe('disableJob', () => {
    it('should throw "not implemented" for a registered job', async () => {
      await scheduler.registerJob(defaultJob());
      await expect(scheduler.disableJob('job-001')).rejects.toThrow('not implemented');
    });

    it('should still throw "Job not found" for missing jobs', async () => {
      await expect(scheduler.disableJob('ghost')).rejects.toThrow('Job not found: ghost');
    });
  });

  describe('deleteJob', () => {
    it('should throw "not implemented" for a registered job', async () => {
      await scheduler.registerJob(defaultJob());
      await expect(scheduler.deleteJob('job-001')).rejects.toThrow('not implemented');
    });

    it('should still throw "Job not found" for missing jobs', async () => {
      await expect(scheduler.deleteJob('ghost')).rejects.toThrow('Job not found: ghost');
    });
  });

  describe('executeCronJob', () => {
    it('should throw "not implemented" for a registered job', async () => {
      await scheduler.registerJob(defaultJob());
      await expect(
        scheduler.executeCronJob('job-001', new Date().toISOString())
      ).rejects.toThrow('not implemented');
    });

    it('should still throw "Job not found" for missing jobs', async () => {
      await expect(
        scheduler.executeCronJob('ghost', new Date().toISOString())
      ).rejects.toThrow('Job not found: ghost');
    });
  });

  // =========================================================================
  // getJob / getJobs — real, no AWS
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
  // getExecutionHistory — real (reads from in-memory map)
  // =========================================================================

  describe('getExecutionHistory', () => {
    it('should return empty array for job with no executions', () => {
      const history = scheduler.getExecutionHistory('no-executions');
      expect(history).toEqual([]);
    });
  });

  // =========================================================================
  // CronPatterns (pure constants)
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
  // CronJobPresets (pure data)
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
