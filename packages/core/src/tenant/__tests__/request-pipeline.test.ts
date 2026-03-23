/**
 * Tests for RequestPipeline
 *
 * Validates end-to-end request processing through all stages
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { RequestPipeline, RequestMetadata } from '../request-pipeline';
import { TenantRouter } from '../tenant-router';
import { CedarAuthorization } from '../cedar-authorization';
import { RateLimiter } from '../rate-limiter';
import { QuotaManager } from '../quota-manager';
import { TenantService } from '../tenant-service';
import { createMockDynamoDBClient, createMockTenantConfig, createMockJWT } from './test-helpers';
import { RateLimitCheckResult } from '@chimera/shared';

describe('RequestPipeline', () => {
  let pipeline: RequestPipeline;
  let tenantService: TenantService;
  let tenantRouter: TenantRouter;
  let cedarAuthorization: CedarAuthorization;
  let rateLimiter: RateLimiter;
  let quotaManager: QuotaManager;

  beforeEach(() => {
    const mockDdb = createMockDynamoDBClient();

    // Initialize services
    tenantService = new TenantService({
      tenantsTableName: 'test-tenants',
      dynamodb: mockDdb,
    });

    tenantRouter = new TenantRouter({
      tenantService,
      cognitoUserPoolId: 'us-east-1_ABC123',
      cognitoRegion: 'us-east-1',
    });

    cedarAuthorization = new CedarAuthorization();

    rateLimiter = new RateLimiter({
      rateLimitsTableName: 'test-rate-limits',
      dynamodb: mockDdb,
    });

    quotaManager = new QuotaManager({
      tenantsTableName: 'test-tenants',
      dynamodb: mockDdb,
    });

    // Create pipeline
    pipeline = new RequestPipeline({
      tenantRouter,
      cedarAuthorization,
      rateLimiter,
      quotaManager,
    });
  });

  describe('process - full pipeline', () => {
    it('should process valid request through all stages', async () => {
      // Mock tenant config
      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      // Mock rate limiter (allow request)
      rateLimiter.checkRateLimit = async () => ({
        allowed: true,
        remainingTokens: 9999,
      });

      // Mock quota manager (allow request)
      quotaManager.checkAndConsume = async () => ({
        allowed: true,
        remaining: 100,
        limit: 1000,
        period: 'monthly' as const,
      });

      // Create valid JWT
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        email: 'alice@acme-corp.com',
        'cognito:groups': ['Users'],
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: {
          type: 'Agent',
          id: 'agent-456',
          attributes: {},
        },
        rateLimitResource: 'api-requests',
        quotaResource: 'agent-sessions',
      };

      const result = await pipeline.process(metadata);

      expect(result.allowed).toBe(true);
      expect(result.context).toBeDefined();
      expect(result.context?.tenantId).toBe('acme-corp');
      expect(result.stages.length).toBe(4); // Auth, Authz, Rate, Quota
      expect(result.stages[0].stage).toBe('authentication');
      expect(result.stages[0].allowed).toBe(true);
      expect(result.stages[1].stage).toBe('authorization');
      expect(result.stages[1].allowed).toBe(true);
      expect(result.stages[2].stage).toBe('rate-limiting');
      expect(result.stages[2].allowed).toBe(true);
      expect(result.stages[3].stage).toBe('quota-checking');
      expect(result.stages[3].allowed).toBe(true);
    });

    it('should fail at authentication stage for invalid JWT', async () => {
      const metadata: RequestMetadata = {
        authHeader: 'Bearer invalid-token',
        action: { type: 'Agent', id: 'Invoke' },
        resource: { type: 'Agent', id: 'agent-456' },
      };

      const result = await pipeline.process(metadata);

      expect(result.allowed).toBe(false);
      expect(result.stages[0].stage).toBe('authentication');
      expect(result.stages[0].allowed).toBe(false);
      expect(result.stages.length).toBe(1); // Only auth stage executed
    });

    it('should fail at authorization stage for cross-tenant access', async () => {
      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'tenant-a') {
          return createMockTenantConfig('tenant-a');
        }
        return null;
      };

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'tenant-a',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Session', id: 'Read' },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: {
            tenantId: 'tenant-b', // Cross-tenant access!
          },
        },
      };

      const result = await pipeline.process(metadata);

      expect(result.allowed).toBe(false);
      expect(result.stages[0].stage).toBe('authentication');
      expect(result.stages[0].allowed).toBe(true);
      expect(result.stages[1].stage).toBe('authorization');
      expect(result.stages[1].allowed).toBe(false);
      expect(result.stages[1].error?.code).toBe('AUTHORIZATION_DENIED');
      expect(result.authorizationResult?.reasons).toContain('cross-tenant-isolation');
      expect(result.stages.length).toBe(2); // Auth and authz only
    });

    it('should fail at rate limiting stage when quota exceeded', async () => {
      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      // Mock rate limiter (deny request)
      rateLimiter.checkRateLimit = async (): Promise<RateLimitCheckResult> => ({
        allowed: false,
        remainingTokens: 0,
        resetAt: new Date(Date.now() + 60000).toISOString(),
        retryAfter: 60,
      });

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: {
          type: 'Agent',
          id: 'agent-456',
        },
        rateLimitResource: 'api-requests',
      };

      const result = await pipeline.process(metadata);

      expect(result.allowed).toBe(false);
      expect(result.stages[2].stage).toBe('rate-limiting');
      expect(result.stages[2].allowed).toBe(false);
      expect(result.stages[2].error?.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(result.rateLimitResult?.resetAt).toBeDefined();
    });

    it('should fail at quota checking stage when quota exceeded', async () => {
      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      // Mock rate limiter (allow)
      rateLimiter.checkRateLimit = async () => ({
        allowed: true,
        remainingTokens: 9999,
      });

      // Mock quota manager (deny)
      quotaManager.checkAndConsume = async () => ({
        allowed: false,
        remaining: 0,
        limit: 100,
        period: 'monthly' as const,
      });

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: { type: 'Agent', id: 'agent-456' },
        rateLimitResource: 'api-requests',
        quotaResource: 'agent-sessions',
      };

      const result = await pipeline.process(metadata);

      expect(result.allowed).toBe(false);
      expect(result.stages[3].stage).toBe('quota-checking');
      expect(result.stages[3].allowed).toBe(false);
      expect(result.stages[3].error?.code).toBe('QUOTA_EXCEEDED');
    });
  });

  describe('skipRateLimiting option', () => {
    it('should skip rate limiting when configured', async () => {
      const pipelineNoRate = new RequestPipeline({
        tenantRouter,
        cedarAuthorization,
        rateLimiter,
        quotaManager,
        skipRateLimiting: true,
      });

      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      quotaManager.checkAndConsume = async () => ({
        allowed: true,
        remaining: 100,
        limit: 1000,
        period: 'monthly' as const,
      });

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: { type: 'Agent', id: 'agent-456' },
        rateLimitResource: 'api-requests', // Should be ignored
        quotaResource: 'agent-sessions',
      };

      const result = await pipelineNoRate.process(metadata);

      expect(result.allowed).toBe(true);
      expect(result.stages.length).toBe(3); // Auth, Authz, Quota (no rate limiting)
      expect(result.stages.find((s) => s.stage === 'rate-limiting')).toBeUndefined();
    });
  });

  describe('skipQuotaChecking option', () => {
    it('should skip quota checking when configured', async () => {
      const pipelineNoQuota = new RequestPipeline({
        tenantRouter,
        cedarAuthorization,
        rateLimiter,
        quotaManager,
        skipQuotaChecking: true,
      });

      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      rateLimiter.checkRateLimit = async () => ({
        allowed: true,
        remainingTokens: 9999,
      });

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: { type: 'Agent', id: 'agent-456' },
        rateLimitResource: 'api-requests',
        quotaResource: 'agent-sessions', // Should be ignored
      };

      const result = await pipelineNoQuota.process(metadata);

      expect(result.allowed).toBe(true);
      expect(result.stages.length).toBe(3); // Auth, Authz, Rate (no quota)
      expect(result.stages.find((s) => s.stage === 'quota-checking')).toBeUndefined();
    });
  });

  describe('forReadOnlyOperations', () => {
    it('should create pipeline with both rate limiting and quota checking skipped', async () => {
      const readOnlyPipeline = RequestPipeline.forReadOnlyOperations({
        tenantRouter,
        cedarAuthorization,
        rateLimiter,
        quotaManager,
      });

      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Session', id: 'Read' },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: { userId: 'user-123' },
        },
      };

      const result = await readOnlyPipeline.process(metadata);

      expect(result.allowed).toBe(true);
      expect(result.stages.length).toBe(2); // Only Auth and Authz
    });
  });

  describe('forAdminOperations', () => {
    it('should create pipeline with rate limiting skipped', async () => {
      const adminPipeline = RequestPipeline.forAdminOperations({
        tenantRouter,
        cedarAuthorization,
        rateLimiter,
        quotaManager,
        skipQuotaChecking: false,
      });

      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      quotaManager.checkAndConsume = async () => ({
        allowed: true,
        remaining: 100,
        limit: 1000,
        period: 'monthly' as const,
      });

      const claims = {
        sub: 'admin-123',
        'cognito:username': 'bob',
        'custom:tenantId': 'acme-corp',
        'cognito:groups': ['Administrators'],
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Tenant', id: 'UpdateSettings' },
        resource: { type: 'Tenant', id: 'acme-corp' },
        quotaResource: 'admin-operations',
      };

      const result = await adminPipeline.process(metadata);

      expect(result.allowed).toBe(true);
      expect(result.stages.length).toBe(3); // Auth, Authz, Quota (no rate limiting)
      expect(result.stages.find((s) => s.stage === 'rate-limiting')).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('should fail closed on rate limiter errors', async () => {
      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      // Mock rate limiter to throw error
      rateLimiter.checkRateLimit = async () => {
        throw new Error('DynamoDB unavailable');
      };

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: { type: 'Agent', id: 'agent-456' },
        rateLimitResource: 'api-requests',
      };

      const result = await pipeline.process(metadata);

      // Should deny request on rate limiter error
      expect(result.allowed).toBe(false);
      expect(result.stages[2].error?.code).toBe('RATE_LIMITER_ERROR');
    });

    it('should fail closed on quota manager errors', async () => {
      tenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      rateLimiter.checkRateLimit = async () => ({
        allowed: true,
        remainingTokens: 9999,
      });

      // Mock quota manager to throw error
      quotaManager.checkAndConsume = async () => {
        throw new Error('DynamoDB unavailable');
      };

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);

      const metadata: RequestMetadata = {
        authHeader: `Bearer ${token}`,
        action: { type: 'Agent', id: 'Invoke' },
        resource: { type: 'Agent', id: 'agent-456' },
        rateLimitResource: 'api-requests',
        quotaResource: 'agent-sessions',
      };

      const result = await pipeline.process(metadata);

      // Should deny request on quota manager error
      expect(result.allowed).toBe(false);
      expect(result.stages[3].error?.code).toBe('QUOTA_MANAGER_ERROR');
    });
  });
});
