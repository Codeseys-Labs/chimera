/**
 * Tests for /tenants/:tenantId/schedules routes (chimera-2b2a).
 *
 * Stubs ScheduleService via the `__setScheduleServiceForTests` test seam so
 * the routes can be exercised without AWS credentials or env setup. Covers:
 *   - Tenant isolation: URL :tenantId must match JWT claim.
 *   - Happy path for POST / GET / GET/:id / PATCH/:id / DELETE/:id / GET/:id/runs.
 *   - Error mapping: InvalidScheduleExpressionError → 400, LimitExceeded → 403, NotFound → 404.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import schedulesRouter, { __setScheduleServiceForTests } from '../../routes/schedules';
import type { AuthContext } from '../../middleware/auth';
import {
  ScheduleLimitExceededError,
  InvalidScheduleExpressionError,
  ScheduleNotFoundError,
} from '@chimera/core';

interface FakeScheduleServiceState {
  created: any[];
  listResult: any[];
  getResult: any | null;
  runsResult: any[];
  runsNextToken?: string;
  lastRunsOptions?: { limit?: number; nextToken?: string };
  nextCreateError: Error | null;
  nextListError: Error | null;
}

function makeFakeScheduleService(state: FakeScheduleServiceState) {
  return {
    async createSchedule(input: any, _tier: any) {
      if (state.nextCreateError) {
        const err = state.nextCreateError;
        state.nextCreateError = null;
        throw err;
      }
      const record = {
        scheduleId: 'sched-fake-1',
        ...input,
        enabled: input.enabled ?? true,
        expressionType: 'rate',
        createdAt: '2026-04-27T12:00:00Z',
        updatedAt: '2026-04-27T12:00:00Z',
      };
      state.created.push(record);
      return record;
    },
    async updateSchedule(tenantId: string, scheduleId: string, updates: any) {
      if (!state.getResult || state.getResult.scheduleId !== scheduleId) {
        throw new ScheduleNotFoundError(tenantId, scheduleId);
      }
      return { ...state.getResult, ...updates, updatedAt: '2026-04-27T12:05:00Z' };
    },
    async deleteSchedule(tenantId: string, scheduleId: string) {
      if (!state.getResult || state.getResult.scheduleId !== scheduleId) {
        throw new ScheduleNotFoundError(tenantId, scheduleId);
      }
    },
    async getSchedule(_tenantId: string, scheduleId: string) {
      if (state.getResult && state.getResult.scheduleId === scheduleId) return state.getResult;
      return null;
    },
    async listSchedules(_tenantId: string) {
      if (state.nextListError) {
        const err = state.nextListError;
        state.nextListError = null;
        throw err;
      }
      return state.listResult;
    },
    async getScheduleRuns(
      _tenantId: string,
      _scheduleId: string,
      options?: { limit?: number; nextToken?: string }
    ) {
      state.lastRunsOptions = options;
      return { runs: state.runsResult, nextToken: state.runsNextToken };
    },
  } as any;
}

function createTestApp(authContext: { tenantId: string; userId: string; tier?: string; isAdmin?: boolean } | null) {
  const app = new Hono();
  if (authContext) {
    app.use('/tenants/*', async (c, next) => {
      c.set('auth', {
        sub: authContext.userId,
        tenantId: authContext.tenantId,
        tenantTier: authContext.tier ?? 'enterprise',
      } as AuthContext);
      c.set('tenantContext', {
        tenantId: authContext.tenantId,
        userId: authContext.userId,
        tier: (authContext.tier ?? 'enterprise') as any,
      });
      await next();
    });
  }
  app.route('/tenants/:tenantId/schedules', schedulesRouter);
  return createAdaptorServer({ fetch: app.fetch });
}

describe('Schedule Routes', () => {
  let state: FakeScheduleServiceState;

  beforeEach(() => {
    state = {
      created: [],
      listResult: [],
      getResult: null,
      runsResult: [],
      runsNextToken: undefined,
      lastRunsOptions: undefined,
      nextCreateError: null,
      nextListError: null,
    };
    __setScheduleServiceForTests(makeFakeScheduleService(state));
  });

  describe('POST /tenants/:tenantId/schedules', () => {
    it('creates a schedule when tenant matches JWT claim', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'admin-1' });
      const response = await request(app)
        .post('/tenants/acme/schedules')
        .send({
          name: 'Daily summary',
          expression: 'rate(1 day)',
          prompt: 'Summarize',
          agentId: 'jira-agent',
        })
        .expect(201);

      expect(response.body.schedule.scheduleId).toBe('sched-fake-1');
      expect(state.created).toHaveLength(1);
      expect(state.created[0].tenantId).toBe('acme');
      expect(state.created[0].createdBy).toBe('admin-1');
    });

    it('rejects cross-tenant creation with 403', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-1' });
      const response = await request(app)
        .post('/tenants/tenant-b/schedules')
        .send({
          name: 'Evil schedule',
          expression: 'rate(1 day)',
          prompt: 'p',
          agentId: 'a',
        })
        .expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
      expect(state.created).toHaveLength(0);
    });

    it('returns 400 for missing required fields', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'admin-1' });
      const response = await request(app)
        .post('/tenants/acme/schedules')
        .send({ name: 'incomplete' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('maps InvalidScheduleExpressionError to 400 INVALID_EXPRESSION', async () => {
      state.nextCreateError = new InvalidScheduleExpressionError('rate(30 seconds)');
      const app = createTestApp({ tenantId: 'acme', userId: 'admin-1' });
      const response = await request(app)
        .post('/tenants/acme/schedules')
        .send({
          name: 'bad',
          expression: 'rate(30 seconds)',
          prompt: 'p',
          agentId: 'a',
        })
        .expect(400);
      expect(response.body.error.code).toBe('INVALID_EXPRESSION');
    });

    it('maps ScheduleLimitExceededError to 403 SCHEDULE_LIMIT_EXCEEDED', async () => {
      state.nextCreateError = new ScheduleLimitExceededError('basic', 5);
      const app = createTestApp({ tenantId: 'acme', userId: 'admin-1', tier: 'basic' });
      const response = await request(app)
        .post('/tenants/acme/schedules')
        .send({ name: 'x', expression: 'rate(1 day)', prompt: 'p', agentId: 'a' })
        .expect(403);
      expect(response.body.error.code).toBe('SCHEDULE_LIMIT_EXCEEDED');
      expect(response.body.error.details.limit).toBe(5);
    });

    it('rejects unauthenticated requests with 401', async () => {
      const app = createTestApp(null);
      const response = await request(app)
        .post('/tenants/acme/schedules')
        .send({ name: 'x', expression: 'rate(1 day)', prompt: 'p', agentId: 'a' })
        .expect(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /tenants/:tenantId/schedules', () => {
    it('lists schedules for own tenant', async () => {
      state.listResult = [
        { scheduleId: 's1', tenantId: 'acme', name: 'one', expression: 'rate(1 day)' },
        { scheduleId: 's2', tenantId: 'acme', name: 'two', expression: 'cron(0 9 * * ? *)' },
      ];
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app).get('/tenants/acme/schedules').expect(200);
      expect(response.body.count).toBe(2);
      expect(response.body.schedules).toHaveLength(2);
    });

    it('rejects cross-tenant list with 403', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app).get('/tenants/tenant-b/schedules').expect(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('GET /tenants/:tenantId/schedules/:id', () => {
    it('returns schedule when found', async () => {
      state.getResult = {
        scheduleId: 's1',
        tenantId: 'acme',
        name: 'one',
        expression: 'rate(1 day)',
      };
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app).get('/tenants/acme/schedules/s1').expect(200);
      expect(response.body.schedule.scheduleId).toBe('s1');
    });

    it('returns 404 when not found', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app).get('/tenants/acme/schedules/nope').expect(404);
      expect(response.body.error.code).toBe('SCHEDULE_NOT_FOUND');
    });
  });

  describe('PATCH /tenants/:tenantId/schedules/:id', () => {
    it('updates schedule', async () => {
      state.getResult = {
        scheduleId: 's1',
        tenantId: 'acme',
        name: 'one',
        expression: 'rate(1 day)',
      };
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app)
        .patch('/tenants/acme/schedules/s1')
        .send({ enabled: false })
        .expect(200);
      expect(response.body.schedule.enabled).toBe(false);
    });

    it('returns 404 for missing schedule', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app)
        .patch('/tenants/acme/schedules/nope')
        .send({ enabled: false })
        .expect(404);
      expect(response.body.error.code).toBe('SCHEDULE_NOT_FOUND');
    });
  });

  describe('DELETE /tenants/:tenantId/schedules/:id', () => {
    it('deletes schedule', async () => {
      state.getResult = { scheduleId: 's1', tenantId: 'acme' };
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app).delete('/tenants/acme/schedules/s1').expect(200);
      expect(response.body.scheduleId).toBe('s1');
    });

    it('returns 404 for missing schedule', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app).delete('/tenants/acme/schedules/nope').expect(404);
      expect(response.body.error.code).toBe('SCHEDULE_NOT_FOUND');
    });
  });

  describe('GET /tenants/:tenantId/schedules/:id/runs', () => {
    it('returns run history', async () => {
      state.runsResult = [
        {
          runId: 'r1',
          scheduleId: 's1',
          tenantId: 'acme',
          scheduledTime: '2026-04-27T09:00:00Z',
          attemptNumber: 1,
          status: 'SUCCESS',
        },
      ];
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app)
        .get('/tenants/acme/schedules/s1/runs')
        .expect(200);
      expect(response.body.count).toBe(1);
      expect(response.body.runs[0].status).toBe('SUCCESS');
    });

    it('rejects cross-tenant run fetch with 403', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app)
        .get('/tenants/tenant-b/schedules/s1/runs')
        .expect(403);
      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    // Design-review MED 2: pagination cursor.
    it('propagates limit + nextToken query params to the service', async () => {
      state.runsNextToken = 'next-cursor-abc';
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      const response = await request(app)
        .get('/tenants/acme/schedules/s1/runs?limit=50&nextToken=prev-cursor')
        .expect(200);
      expect(state.lastRunsOptions).toEqual({ limit: 50, nextToken: 'prev-cursor' });
      expect(response.body.nextToken).toBe('next-cursor-abc');
    });

    it('defaults limit to 20 when not specified', async () => {
      const app = createTestApp({ tenantId: 'acme', userId: 'u1' });
      await request(app).get('/tenants/acme/schedules/s1/runs').expect(200);
      expect(state.lastRunsOptions?.limit).toBe(20);
    });
  });
});
