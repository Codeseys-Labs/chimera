/**
 * Tests for chat platform integration routes
 */

import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import request from 'supertest';
import integrationsRouter from '../../routes/integrations';
import type { AuthContext } from '../../middleware/auth';

function createTestApp(tenantContext?: { tenantId: string; userId?: string }) {
  const app = new Hono();
  if (tenantContext) {
    app.use('/integrations/*', async (c, next) => {
      (c as any).set('auth', {
        sub: tenantContext.userId || 'user-anonymous',
        tenantId: tenantContext.tenantId,
        tenantTier: 'enterprise',
      } as AuthContext);
      await next();
    });
  }
  app.route('/integrations', integrationsRouter);
  return createAdaptorServer({ fetch: app.fetch });
}

describe('Integration Routes', () => {
  describe('GET /integrations/:tenantId', () => {
    it('should return list of integrations for tenant', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app).get(`/integrations/${tenantId}`).expect(200);

      expect(response.body).toHaveProperty('integrations');
      expect(response.body).toHaveProperty('count');
      expect(response.body).toHaveProperty('timestamp');
      expect(Array.isArray(response.body.integrations)).toBe(true);
    });

    it('should reject request for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app).get('/integrations/tenant-b').expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('should allow platform admin to access any tenant', async () => {
      const app = createTestApp({ tenantId: 'chimera-platform', userId: 'admin-123' });

      const response = await request(app).get('/integrations/tenant-b').expect(200);

      expect(response.body).toHaveProperty('integrations');
    });

    it('should not expose access tokens in list', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app).get(`/integrations/${tenantId}`).expect(200);

      // Access tokens should be undefined (not exposed)
      response.body.integrations.forEach((integration: any) => {
        expect(integration.accessToken).toBeUndefined();
      });
    });
  });

  describe('POST /integrations/:tenantId/slack', () => {
    it('should initiate Slack OAuth flow', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      // Set Slack client ID for test
      process.env.SLACK_CLIENT_ID = 'test-client-id';

      const response = await request(app)
        .post(`/integrations/${tenantId}/slack`)
        .send({ redirectUri: 'https://example.com/admin' })
        .expect(200);

      expect(response.body).toHaveProperty('authUrl');
      expect(response.body).toHaveProperty('state');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body.authUrl).toContain('slack.com/oauth');
      expect(response.body.authUrl).toContain('test-client-id');
    });

    it('should reject request without redirectUri', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/slack`)
        .send({})
        .expect(400);

      expect(response.body.error.code).toBe('INVALID_REDIRECT_URI');
    });

    it('should reject request for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app)
        .post('/integrations/tenant-b/slack')
        .send({ redirectUri: 'https://example.com/admin' })
        .expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });

    it('should return error if Slack client ID not configured', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      // Clear Slack client ID
      delete process.env.SLACK_CLIENT_ID;

      const response = await request(app)
        .post(`/integrations/${tenantId}/slack`)
        .send({ redirectUri: 'https://example.com/admin' })
        .expect(500);

      expect(response.body.error.code).toBe('CONFIGURATION_ERROR');
    });
  });

  describe('POST /integrations/:tenantId/slack/callback', () => {
    it('should handle Slack OAuth callback', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/slack/callback`)
        .send({
          code: 'oauth-code-123',
          state: 'csrf-state-abc',
        })
        .expect(201);

      expect(response.body).toHaveProperty('integration');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body.integration.platform).toBe('slack');
      expect(response.body.integration.accessToken).toBeUndefined(); // Never exposed
    });

    it('should reject callback without code', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/slack/callback`)
        .send({ state: 'csrf-state-abc' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_OAUTH_PARAMS');
    });

    it('should reject callback without state', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/slack/callback`)
        .send({ code: 'oauth-code-123' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_OAUTH_PARAMS');
    });

    it('should reject callback for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app)
        .post('/integrations/tenant-b/slack/callback')
        .send({
          code: 'oauth-code-123',
          state: 'csrf-state-abc',
        })
        .expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('DELETE /integrations/:tenantId/slack/:workspaceId', () => {
    it('should remove integration', async () => {
      const tenantId = 'test-tenant';
      const workspaceId = 'T01234567';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .delete(`/integrations/${tenantId}/slack/${workspaceId}`)
        .expect(200);

      expect(response.body.message).toBe('Integration removed');
      expect(response.body.tenantId).toBe(tenantId);
      expect(response.body.workspaceId).toBe(workspaceId);
    });

    it('should reject removal for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app)
        .delete('/integrations/tenant-b/slack/T01234567')
        .expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('GET /integrations/:tenantId/users', () => {
    it('should return list of user pairings', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .get(`/integrations/${tenantId}/users`)
        .expect(200);

      expect(response.body).toHaveProperty('pairings');
      expect(response.body).toHaveProperty('count');
      expect(response.body).toHaveProperty('timestamp');
      expect(Array.isArray(response.body.pairings)).toBe(true);
    });

    it('should filter by platform', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .get(`/integrations/${tenantId}/users?platform=slack`)
        .expect(200);

      expect(response.body).toHaveProperty('pairings');
      // All pairings should be for slack platform
      response.body.pairings.forEach((pairing: any) => {
        expect(pairing.platform).toBe('slack');
      });
    });

    it('should reject request for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app).get('/integrations/tenant-b/users').expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('POST /integrations/:tenantId/users', () => {
    it('should create user pairing', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/users`)
        .send({
          platform: 'slack',
          platformUserId: 'U12345',
          cognitoSub: 'abc-123-cognito-sub',
        })
        .expect(201);

      expect(response.body).toHaveProperty('pairing');
      expect(response.body).toHaveProperty('timestamp');
      expect(response.body.pairing.platform).toBe('slack');
      expect(response.body.pairing.platformUserId).toBe('U12345');
      expect(response.body.pairing.cognitoSub).toBe('abc-123-cognito-sub');
    });

    it('should reject request without required fields', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/users`)
        .send({ platform: 'slack' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_REQUIRED_FIELDS');
    });

    it('should reject invalid platform', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .post(`/integrations/${tenantId}/users`)
        .send({
          platform: 'invalid',
          platformUserId: 'U12345',
          cognitoSub: 'abc-123-cognito-sub',
        })
        .expect(400);

      expect(response.body.error.code).toBe('INVALID_PLATFORM');
    });

    it('should reject request for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app)
        .post('/integrations/tenant-b/users')
        .send({
          platform: 'slack',
          platformUserId: 'U12345',
          cognitoSub: 'abc-123-cognito-sub',
        })
        .expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('DELETE /integrations/:tenantId/users/:platform/:platformUserId', () => {
    test('should remove user pairing', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      const response = await request(app)
        .delete(`/integrations/${tenantId}/users/slack/U12345`)
        .expect(200);

      expect(response.body.message).toBe('User pairing removed');
      expect(response.body.tenantId).toBe(tenantId);
      expect(response.body.platform).toBe('slack');
      expect(response.body.platformUserId).toBe('U12345');
    });

    it('should reject removal for different tenant', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app)
        .delete('/integrations/tenant-b/users/slack/U12345')
        .expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('POST /integrations/resolve-user', () => {
    it('should resolve platform user to Cognito sub', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

      const response = await request(app)
        .post('/integrations/resolve-user')
        .send({
          tenantId: 'test-tenant',
          platform: 'slack',
          platformUserId: 'U12345',
        })
        .expect(200);

      expect(response.body).toHaveProperty('cognitoSub');
      expect(response.body).toHaveProperty('found');
      expect(response.body.found).toBe(true);
    });

    it('should reject request without required fields', async () => {
      const app = createTestApp({ tenantId: 'test-tenant', userId: 'user-123' });

      const response = await request(app)
        .post('/integrations/resolve-user')
        .send({ tenantId: 'test-tenant' })
        .expect(400);

      expect(response.body.error.code).toBe('MISSING_REQUIRED_FIELDS');
    });
  });

  describe('Authorization', () => {
    it('platform admin can manage any tenant integrations', async () => {
      const app = createTestApp({ tenantId: 'chimera-platform', userId: 'admin-123' });

      // Should be able to access tenant-b integrations
      const response = await request(app).get('/integrations/tenant-b').expect(200);

      expect(response.body).toHaveProperty('integrations');
    });

    it('regular tenant cannot manage other tenants', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      // Should NOT be able to access tenant-b integrations
      const response = await request(app).get('/integrations/tenant-b').expect(403);

      expect(response.body.error.code).toBe('INSUFFICIENT_PERMISSIONS');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors gracefully', async () => {
      const tenantId = 'test-tenant';
      const app = createTestApp({ tenantId, userId: 'user-123' });

      // All routes should return proper error response format
      const response = await request(app).get(`/integrations/${tenantId}`).expect(200);

      expect(response.body).toHaveProperty('timestamp');
    });

    it('should return consistent error format', async () => {
      const app = createTestApp({ tenantId: 'tenant-a', userId: 'user-123' });

      const response = await request(app).get('/integrations/tenant-b').expect(403);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});
