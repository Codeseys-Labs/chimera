/**
 * Tests for CronScheduler
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CronScheduler,
  createCronScheduler,
  CronPatterns,
  CronJobPresets,
  type CronJob
} from '../../../packages/core/src/orchestration/cron-scheduler';
import { createOrchestrator } from '../../../packages/core/src/orchestration/orchestrator';

describe('CronScheduler', () => {
  let scheduler: CronScheduler;
  let orchestrator: ReturnType<typeof createOrchestrator>;

  beforeEach(() => {
    orchestrator = createOrchestrator({
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      agentTableName: 'test-agents',
      defaultQueuePrefix: 'test-queue'
    });

    scheduler = createCronScheduler(orchestrator, {
      region: 'us-east-1',
      eventBusName: 'test-event-bus',
      executionTableName: 'test-executions'
    });
  });

  describe('registerJob', () => {
    it('should register cron job', async () => {
      const job: CronJob = {
        jobId: 'job-001',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Daily Report',
        schedule: CronPatterns.daily9am,
        instruction: 'Generate daily report',
        enabled: true
      };

      await scheduler.registerJob(job);

      const retrievedJob = scheduler.getJob('job-001');
      expect(retrievedJob).toBeDefined();
      expect(retrievedJob?.name).toBe('Daily Report');
    });

    it('should enable job if enabled flag is true', async () => {
      const job: CronJob = {
        jobId: 'job-002',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Hourly Check',
        schedule: CronPatterns.hourly,
        instruction: 'Check system status',
        enabled: true
      };

      await scheduler.registerJob(job);

      const retrievedJob = scheduler.getJob('job-002');
      expect(retrievedJob?.enabled).toBe(true);
    });

    it('should not enable job if enabled flag is false', async () => {
      const job: CronJob = {
        jobId: 'job-003',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Disabled Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test job',
        enabled: false
      };

      await scheduler.registerJob(job);

      const retrievedJob = scheduler.getJob('job-003');
      expect(retrievedJob?.enabled).toBe(false);
    });
  });

  describe('enableJob', () => {
    it('should enable registered job', async () => {
      const job: CronJob = {
        jobId: 'job-004',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test',
        enabled: false
      };

      await scheduler.registerJob(job);
      await scheduler.enableJob('job-004');

      const retrievedJob = scheduler.getJob('job-004');
      expect(retrievedJob?.enabled).toBe(true);
    });

    it('should throw error for non-existent job', async () => {
      await expect(
        scheduler.enableJob('non-existent')
      ).rejects.toThrow('Job not found: non-existent');
    });
  });

  describe('disableJob', () => {
    it('should disable enabled job', async () => {
      const job: CronJob = {
        jobId: 'job-005',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test',
        enabled: true
      };

      await scheduler.registerJob(job);
      await scheduler.disableJob('job-005');

      const retrievedJob = scheduler.getJob('job-005');
      expect(retrievedJob?.enabled).toBe(false);
    });

    it('should throw error for non-existent job', async () => {
      await expect(
        scheduler.disableJob('non-existent')
      ).rejects.toThrow('Job not found: non-existent');
    });
  });

  describe('deleteJob', () => {
    it('should delete registered job', async () => {
      const job: CronJob = {
        jobId: 'job-006',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test',
        enabled: true
      };

      await scheduler.registerJob(job);
      await scheduler.deleteJob('job-006');

      const retrievedJob = scheduler.getJob('job-006');
      expect(retrievedJob).toBeUndefined();
    });

    it('should throw error for non-existent job', async () => {
      await expect(
        scheduler.deleteJob('non-existent')
      ).rejects.toThrow('Job not found: non-existent');
    });
  });

  describe('executeCronJob', () => {
    it('should execute job and return success execution', async () => {
      // Spawn agent first
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      const job: CronJob = {
        jobId: 'job-007',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test task',
        enabled: true,
        timeoutSeconds: 60
      };

      await scheduler.registerJob(job);

      const scheduledTime = new Date().toISOString();
      const execution = await scheduler.executeCronJob('job-007', scheduledTime);

      expect(execution.jobId).toBe('job-007');
      expect(execution.status).toBe('succeeded');
      expect(execution.startedAt).toBeTruthy();
      expect(execution.completedAt).toBeTruthy();
      expect(execution.durationMs).toBeGreaterThan(0);
    });

    it('should include execution metadata', async () => {
      // Spawn agent first
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      const job: CronJob = {
        jobId: 'job-008',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test task',
        enabled: true
      };

      await scheduler.registerJob(job);

      const scheduledTime = new Date().toISOString();
      const execution = await scheduler.executeCronJob('job-008', scheduledTime);

      expect(execution.tenantId).toBe('tenant-123');
      expect(execution.agentId).toBe('agent-001');
      expect(execution.scheduledTime).toBe(scheduledTime);
      expect(execution.attemptNumber).toBe(1);
    });

    it('should throw error for non-existent job', async () => {
      const scheduledTime = new Date().toISOString();

      await expect(
        scheduler.executeCronJob('non-existent', scheduledTime)
      ).rejects.toThrow('Job not found: non-existent');
    });
  });

  describe('getExecutionHistory', () => {
    it('should return execution history for job', async () => {
      // Spawn agent first
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      const job: CronJob = {
        jobId: 'job-009',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test task',
        enabled: true
      };

      await scheduler.registerJob(job);

      // Execute multiple times
      await scheduler.executeCronJob('job-009', new Date().toISOString());
      await new Promise(resolve => setTimeout(resolve, 10));
      await scheduler.executeCronJob('job-009', new Date().toISOString());

      const history = scheduler.getExecutionHistory('job-009');
      expect(history.length).toBe(2);
    });

    it('should sort executions by scheduled time (newest first)', async () => {
      // Spawn agent first
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      const job: CronJob = {
        jobId: 'job-010',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test task',
        enabled: true
      };

      await scheduler.registerJob(job);

      const time1 = new Date().toISOString();
      await scheduler.executeCronJob('job-010', time1);

      await new Promise(resolve => setTimeout(resolve, 10));

      const time2 = new Date().toISOString();
      await scheduler.executeCronJob('job-010', time2);

      const history = scheduler.getExecutionHistory('job-010');
      expect(new Date(history[0].scheduledTime).getTime())
        .toBeGreaterThanOrEqual(new Date(history[1].scheduledTime).getTime());
    });

    it('should respect limit parameter', async () => {
      // Spawn agent first
      await orchestrator.spawnAgent({
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        role: 'worker',
        capabilities: []
      });

      const job: CronJob = {
        jobId: 'job-011',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Test Job',
        schedule: CronPatterns.hourly,
        instruction: 'Test task',
        enabled: true
      };

      await scheduler.registerJob(job);

      // Execute 5 times
      for (let i = 0; i < 5; i++) {
        await scheduler.executeCronJob('job-011', new Date().toISOString());
        await new Promise(resolve => setTimeout(resolve, 5));
      }

      const history = scheduler.getExecutionHistory('job-011', 3);
      expect(history.length).toBe(3);
    }, 30000);
  });

  describe('getJobs', () => {
    it('should return all jobs for tenant', async () => {
      const job1: CronJob = {
        jobId: 'job-012',
        tenantId: 'tenant-123',
        agentId: 'agent-001',
        name: 'Job 1',
        schedule: CronPatterns.hourly,
        instruction: 'Test 1',
        enabled: true
      };

      const job2: CronJob = {
        jobId: 'job-013',
        tenantId: 'tenant-123',
        agentId: 'agent-002',
        name: 'Job 2',
        schedule: CronPatterns.daily9am,
        instruction: 'Test 2',
        enabled: true
      };

      const job3: CronJob = {
        jobId: 'job-014',
        tenantId: 'tenant-456',
        agentId: 'agent-003',
        name: 'Job 3',
        schedule: CronPatterns.hourly,
        instruction: 'Test 3',
        enabled: true
      };

      await scheduler.registerJob(job1);
      await scheduler.registerJob(job2);
      await scheduler.registerJob(job3);

      const jobs = scheduler.getJobs('tenant-123');
      expect(jobs.length).toBe(2);
    });
  });

  describe('CronPatterns', () => {
    it('should provide common cron patterns', () => {
      expect(CronPatterns.everyMinute).toBe('rate(1 minute)');
      expect(CronPatterns.every5Minutes).toBe('rate(5 minutes)');
      expect(CronPatterns.hourly).toBe('rate(1 hour)');
      expect(CronPatterns.daily9am).toBe('cron(0 9 * * ? *)');
      expect(CronPatterns.weeklyMonday).toBe('cron(0 8 ? * MON *)');
      expect(CronPatterns.monthly).toBe('cron(0 0 1 * ? *)');
      expect(CronPatterns.businessHours).toBe('cron(0 9-17 ? * MON-FRI *)');
    });
  });

  describe('CronJobPresets', () => {
    it('should provide health check preset', () => {
      const job = CronJobPresets.healthCheck('tenant-123', 'agent-001');

      expect(job.jobId).toBe('health-check-agent-001');
      expect(job.tenantId).toBe('tenant-123');
      expect(job.agentId).toBe('agent-001');
      expect(job.schedule).toBe(CronPatterns.daily9am);
      expect(job.enabled).toBe(true);
      expect(job.retryConfig).toBeDefined();
      expect(job.retryConfig?.maxAttempts).toBe(3);
    });

    it('should provide log analysis preset', () => {
      const job = CronJobPresets.logAnalysis('tenant-456', 'monitor-001');

      expect(job.jobId).toBe('log-analysis-monitor-001');
      expect(job.schedule).toBe(CronPatterns.hourly);
      expect(job.timeoutSeconds).toBe(600);
    });

    it('should provide weekly report preset', () => {
      const job = CronJobPresets.weeklyReport('tenant-789', 'report-agent');

      expect(job.jobId).toBe('weekly-report-report-agent');
      expect(job.schedule).toBe(CronPatterns.weeklyMonday);
      expect(job.timeoutSeconds).toBe(900);
    });
  });
});
