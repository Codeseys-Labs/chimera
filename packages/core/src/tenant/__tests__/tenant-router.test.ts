/**
 * Tests for TenantRouter
 *
 * Validates JWT extraction, tenant lookup, and routing logic
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { TenantRouter } from '../tenant-router';
import { TenantService } from '../tenant-service';
import { createMockDynamoDBClient, createMockTenantConfig, createMockJWT } from './test-helpers';

describe('TenantRouter', () => {
  let router: TenantRouter;
  let mockTenantService: TenantService;

  beforeEach(() => {
    const mockDdb = createMockDynamoDBClient();
    mockTenantService = new TenantService({
      tenantsTableName: 'test-tenants',
      dynamodb: mockDdb,
    });

    router = new TenantRouter({
      tenantService: mockTenantService,
      cognitoUserPoolId: 'us-east-1_ABC123',
      cognitoRegion: 'us-east-1',
    });
  });

  describe('extractToken', () => {
    it('should extract token from Bearer header', () => {
      const token = router.extractToken('Bearer eyJhbGciOiJSUzI1NiJ9.test.sig');
      expect(token).toBe('eyJhbGciOiJSUzI1NiJ9.test.sig');
    });

    it('should return null for missing header', () => {
      const token = router.extractToken(undefined);
      expect(token).toBeNull();
    });

    it('should return null for invalid format', () => {
      const token = router.extractToken('InvalidHeader');
      expect(token).toBeNull();
    });

    it('should return null for non-Bearer scheme', () => {
      const token = router.extractToken('Basic dXNlcjpwYXNz');
      expect(token).toBeNull();
    });
  });

  describe('decodeToken', () => {
    it('should decode valid JWT', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        email: 'alice@example.com',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);
      const decoded = router.decodeToken(token);

      expect(decoded).not.toBeNull();
      expect(decoded?.sub).toBe('user-123');
      expect(decoded?.['cognito:username']).toBe('alice');
    });

    it('should return null for invalid JWT format', () => {
      const decoded = router.decodeToken('not.a.valid.jwt');
      expect(decoded).toBeNull();
    });

    it('should return null for malformed base64', () => {
      const decoded = router.decodeToken('invalid.@@@.sig');
      expect(decoded).toBeNull();
    });
  });

  describe('validateClaims', () => {
    it('should validate correct claims', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const result = router.validateClaims(claims);
      expect(result.valid).toBe(true);
    });

    it('should reject expired token', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) - 3600, // Expired 1 hour ago
        iat: Math.floor(Date.now() / 1000) - 7200,
        token_use: 'id' as const,
      };

      const result = router.validateClaims(claims);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('expired');
    });

    it('should reject wrong issuer', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        iss: 'https://evil.com/cognito',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const result = router.validateClaims(claims);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('issuer');
    });

    it('should reject invalid token type', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'refresh' as any,
      };

      const result = router.validateClaims(claims);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('token type');
    });
  });

  describe('extractTenantId', () => {
    it('should extract from custom attribute', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'acme-corp',
        iss: '',
        exp: 0,
        iat: 0,
        token_use: 'id' as const,
      };

      const tenantId = router.extractTenantId(claims);
      expect(tenantId).toBe('acme-corp');
    });

    it('should extract from cognito groups', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'cognito:groups': ['Users', 'TENANT#acme-corp', 'Viewers'],
        iss: '',
        exp: 0,
        iat: 0,
        token_use: 'id' as const,
      };

      const tenantId = router.extractTenantId(claims);
      expect(tenantId).toBe('acme-corp');
    });

    it('should return null if tenant ID not found', () => {
      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        iss: '',
        exp: 0,
        iat: 0,
        token_use: 'id' as const,
      };

      const tenantId = router.extractTenantId(claims);
      expect(tenantId).toBeNull();
    });
  });

  describe('authenticate', () => {
    it('should authenticate valid request', async () => {
      // Mock tenant service to return config
      mockTenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

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
      const result = await router.authenticate(`Bearer ${token}`);

      expect(result.authenticated).toBe(true);
      expect(result.context).toBeDefined();
      expect(result.context?.tenantId).toBe('acme-corp');
      expect(result.context?.userId).toBe('user-123');
      expect(result.context?.userEmail).toBe('alice@acme-corp.com');
      expect(result.context?.isAdmin).toBe(false);
    });

    it('should reject suspended tenant', async () => {
      mockTenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'suspended-corp') {
          const config = createMockTenantConfig('suspended-corp');
          config.profile.status = 'SUSPENDED';
          return config;
        }
        return null;
      };

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'suspended-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);
      const result = await router.authenticate(`Bearer ${token}`);

      expect(result.authenticated).toBe(false);
      expect(result.error?.code).toBe('TENANT_SUSPENDED');
    });

    it('should reject churned tenant', async () => {
      mockTenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'churned-corp') {
          const config = createMockTenantConfig('churned-corp');
          config.profile.status = 'CHURNED';
          return config;
        }
        return null;
      };

      const claims = {
        sub: 'user-123',
        'cognito:username': 'alice',
        'custom:tenantId': 'churned-corp',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);
      const result = await router.authenticate(`Bearer ${token}`);

      expect(result.authenticated).toBe(false);
      expect(result.error?.code).toBe('TENANT_CHURNED');
    });

    it('should identify admin users', async () => {
      mockTenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'acme-corp') {
          return createMockTenantConfig('acme-corp');
        }
        return null;
      };

      const claims = {
        sub: 'admin-456',
        'cognito:username': 'bob',
        'custom:tenantId': 'acme-corp',
        'cognito:groups': ['Administrators', 'Users'],
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const token = createMockJWT(claims);
      const result = await router.authenticate(`Bearer ${token}`);

      expect(result.authenticated).toBe(true);
      expect(result.context?.isAdmin).toBe(true);
    });
  });

  describe('routeToEndpoint', () => {
    it('should route dedicated deploymentModel to dedicated cluster', () => {
      const context = {
        tenantId: 'premium-corp',
        userId: 'user-123',
        userGroups: [],
        tenantConfig: createMockTenantConfig('premium-corp', 'premium', 'dedicated'),
        isAdmin: false,
      };

      const endpoint = router.routeToEndpoint(context);
      expect(endpoint).toBe('https://premium-corp.agentcore.us-east-1.chimera.aws');
    });

    it('should route shared tiers to shared cluster', () => {
      const context = {
        tenantId: 'acme-corp',
        userId: 'user-123',
        userGroups: [],
        tenantConfig: createMockTenantConfig('acme-corp', 'advanced'),
        isAdmin: false,
      };

      const endpoint = router.routeToEndpoint(context);
      expect(endpoint).toBe('https://agentcore.us-east-1.chimera.aws/tenants/acme-corp');
    });

    it('should include session ID in route when provided', () => {
      const context = {
        tenantId: 'acme-corp',
        userId: 'user-123',
        userGroups: [],
        tenantConfig: createMockTenantConfig('acme-corp', 'advanced'),
        isAdmin: false,
      };

      const endpoint = router.routeToEndpoint(context, 'session-789');
      expect(endpoint).toBe('https://agentcore.us-east-1.chimera.aws/tenants/acme-corp/sessions/session-789');
    });
  });

  describe('cross-tenant isolation', () => {
    it('should prevent tenant A from accessing tenant B config', async () => {
      mockTenantService.getTenantConfig = async (tenantId: string) => {
        if (tenantId === 'tenant-a') {
          return createMockTenantConfig('tenant-a');
        }
        if (tenantId === 'tenant-b') {
          return createMockTenantConfig('tenant-b');
        }
        return null;
      };

      // User from tenant-a tries to authenticate
      const claimsTenantA = {
        sub: 'user-a',
        'cognito:username': 'alice',
        'custom:tenantId': 'tenant-a',
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        token_use: 'id' as const,
      };

      const tokenA = createMockJWT(claimsTenantA);
      const resultA = await router.authenticate(`Bearer ${tokenA}`);

      expect(resultA.authenticated).toBe(true);
      expect(resultA.context?.tenantId).toBe('tenant-a');
      expect(resultA.context?.tenantConfig.profile.tenantId).toBe('tenant-a');

      // Verify context does not expose tenant-b data
      expect(resultA.context?.tenantConfig.profile.name).toBe('tenant-a Corp');
      expect(resultA.context?.tenantConfig.profile.name).not.toBe('tenant-b Corp');
    });
  });
});
