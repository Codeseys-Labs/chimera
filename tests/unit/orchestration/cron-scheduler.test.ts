/**
 * Tests for CronScheduler (top-level smoke)
 *
 * EventBridge rule + DynamoDB persistence are skeletons (Wave-14 audit M2).
 * `enableJob`, `disableJob`, `deleteJob`, `executeCronJob`, and the private
 * `storeExecution` all throw `not implemented`. Authoritative unit tests
 * live under `packages/core/src/orchestration/__tests__/cron-scheduler.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CronScheduler,
  createCronScheduler,
  CronPatterns,
  CronJobPresets,
  type CronJob,
} from '../../../packages/core/src/orchestration/cron-scheduler';
import {
  createOrchestrator,
  type OrchestratorSQSClient,
  type OrchestratorDDBClient,
  type OrchestratorEventBridgeClient,
} from '../../../packages/core/src/orchestration/orchestrator';

function createMockSQS(): OrchestratorSQSClient {
  return {
    async createQueue(input) {
      return { QueueUrl: `https://sqs.us-east-1.amazonaws.com/TESTACCT/${input.QueueName}` };
    },
    async getQueueAttributes() {
      return { Attributes: { QueueArn: 'arn:aws:sqs:us-east-1:TESTACCT:dlq' } };
    },
    async sendMessage() {
      return { MessageId: `msg-${Date.now()}` };
    },
    async deleteQueue() {
      return {};
    },
  };
}

function createMockDDB(): OrchestratorDDBClient {
  return {
    async put() {
      return {};
    },
    async update() {
      return {};
    },
  };
}

function createMockEventBridge(): OrchestratorEventBridgeClient {
  return {
    async putEvents() {
      return { FailedEntryCount: 0 };
    },
  };
}

function defaultJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    jobId: 'job-001',
    tenantId: 'tenant-123',
    agentId: 'agent-001',
    name: 'Daily Report',
    schedule: CronPatterns.daily9am,
    instruction: 'Generate daily report',
    enabled: true,
    ...overrides,
  };
}

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let orchestrator: ReturnType<typeof createOrchestrator>;

  beforeEach(() => {
    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue',
      clients: {
        sqs: createMockSQS(),
        dynamodb: createMockDDB(),
        eventBridge: createMockEventBridge(),
      },
    });

    scheduler = createCronScheduler(orchestrator, {
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      executionTableName: 'test-executions',
    });
  });

  describe('registerJob', () => {
    it('should register cron job in the in-memory registry', async () => {
      await scheduler.registerJob(defaultJob());
      expect(scheduler.getJob('job-001')).toBeDefined();
      expect(scheduler.getJob('job-001')!.schedule).toBe(CronPatterns.daily9am);
    });

    it('should honour enabled:false without calling enableJob', async () => {
      await scheduler.registerJob(defaultJob({ enabled: false }));
      expect(scheduler.getJob('job-001')!.enabled).toBe(false);
    });
  });

  describe('AWS lifecycle methods throw "not implemented"', () => {
    beforeEach(async () => {
      await scheduler.registerJob(defaultJob());
    });

    it('enableJob should throw', async () => {
      await expect(scheduler.enableJob('job-001')).rejects.toThrow('not implemented');
    });

    it('disableJob should throw', async () => {
      await expect(scheduler.disableJob('job-001')).rejects.toThrow('not implemented');
    });

    it('deleteJob should throw', async () => {
      await expect(scheduler.deleteJob('job-001')).rejects.toThrow('not implemented');
    });

    it('executeCronJob should throw', async () => {
      await expect(
        scheduler.executeCronJob('job-001', new Date().toISOString())
      ).rejects.toThrow('not implemented');
    });
  });

  describe('getter methods still work', () => {
    it('should return jobs filtered by tenant', async () => {
      await scheduler.registerJob(defaultJob({ jobId: 'a', tenantId: 't1' }));
      await scheduler.registerJob(defaultJob({ jobId: 'b', tenantId: 't1' }));
      await scheduler.registerJob(defaultJob({ jobId: 'c', tenantId: 't2' }));

      expect(scheduler.getJobs('t1').length).toBe(2);
      expect(scheduler.getJobs('t2').length).toBe(1);
    });

    it('should return empty execution history when nothing has executed', () => {
      expect(scheduler.getExecutionHistory('unknown')).toEqual([]);
    });
  });

  describe('CronPatterns and CronJobPresets are pure data', () => {
    it('should define standard patterns', () => {
      expect(CronPatterns.hourly).toBe('rate(1 hour)');
      expect(CronPatterns.daily9am).toBe('cron(0 9 * * ? *)');
    });

    it('should create valid healthCheck preset', () => {
      const job = CronJobPresets.healthCheck('tenant-1', 'agent-1');
      expect(job.jobId).toBe('health-check-agent-1');
      expect(job.schedule).toBe(CronPatterns.daily9am);
    });
  });

  describe('createCronScheduler factory', () => {
    it('should build a CronScheduler instance', () => {
      const s = createCronScheduler(orchestrator);
      expect(s).toBeInstanceOf(CronScheduler);
    });
  });
});
