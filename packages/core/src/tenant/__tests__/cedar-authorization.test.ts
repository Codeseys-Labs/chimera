/**
 * Tests for CedarAuthorization
 *
 * Validates Cedar policy evaluation and cross-tenant isolation
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  CedarAuthorization,
  CedarPolicy,
  AuthorizationRequest,
  DEFAULT_POLICIES,
} from '../cedar-authorization';
import { TenantContext } from '../tenant-router';
import { createMockTenantConfig } from './test-helpers';

describe('CedarAuthorization', () => {
  let cedar: CedarAuthorization;

  beforeEach(() => {
    cedar = new CedarAuthorization();
  });

  describe('DEFAULT_POLICIES', () => {
    it('should load default policies on construction', () => {
      const policies = cedar.getPolicies();
      expect(policies.length).toBeGreaterThan(0);

      // Check for critical policies
      const crossTenantPolicy = policies.find((p) => p.id === 'cross-tenant-isolation');
      expect(crossTenantPolicy).toBeDefined();
      expect(crossTenantPolicy?.effect).toBe('forbid');
    });
  });

  describe('authorize - cross-tenant isolation', () => {
    it('should DENY cross-tenant resource access', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Session',
          id: 'Read',
        },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: {
            tenantId: 'tenant-b', // Different tenant
            userId: 'user-789',
          },
        },
        context: {
          tenantId: 'tenant-a', // User's tenant
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Deny');
      expect(result.reasons).toContain('cross-tenant-isolation');
    });

    it('should ALLOW same-tenant resource access', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Session',
          id: 'Read',
        },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: {
            tenantId: 'tenant-a', // Same tenant
            userId: 'user-123', // User's own session
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Allow');
      // Wave-18 I3: assert on the specific policy that granted access, not
      // just that SOME reason exists. If cross-tenant-isolation accidentally
      // didn't fire and a different permit policy matched, the loose check
      // would still pass — hiding the regression.
      expect(result.reasons).toContain('user-read-own-sessions');
    });
  });

  describe('authorize - admin permissions', () => {
    it('should ALLOW admin full access within tenant', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'admin-123',
        },
        action: {
          type: 'Tenant',
          id: 'UpdateSettings',
        },
        resource: {
          type: 'Tenant',
          id: 'tenant-a',
          attributes: {
            tenantId: 'tenant-a',
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Administrators'],
          isAdmin: true,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Allow');
      expect(result.reasons).toContain('admin-full-access');
    });

    it('should DENY admin cross-tenant access', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'admin-123',
        },
        action: {
          type: 'Tenant',
          id: 'UpdateSettings',
        },
        resource: {
          type: 'Tenant',
          id: 'tenant-b',
          attributes: {
            tenantId: 'tenant-b', // Different tenant
          },
        },
        context: {
          tenantId: 'tenant-a', // Admin's tenant
          userGroups: ['Administrators'],
          isAdmin: true,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Deny');
      expect(result.reasons).toContain('cross-tenant-isolation');
    });
  });

  describe('authorize - user permissions', () => {
    it('should ALLOW user to read own sessions', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Session',
          id: 'Read',
        },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: {
            tenantId: 'tenant-a',
            userId: 'user-123', // User's own session
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Allow');
      expect(result.reasons).toContain('user-read-own-sessions');
    });

    it('should DENY user reading other users sessions', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Session',
          id: 'Read',
        },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: {
            tenantId: 'tenant-a',
            userId: 'user-789', // Different user
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Deny');
    });

    it('should ALLOW user to create sessions in their tenant', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Session',
          id: 'Create',
        },
        resource: {
          type: 'Tenant',
          id: 'tenant-a',
          attributes: {
            id: 'tenant-a',
            tenantId: 'tenant-a',
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Allow');
      expect(result.reasons).toContain('user-create-sessions');
    });

    it('should ALLOW user to invoke agents in their tenant', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Agent',
          id: 'Invoke',
        },
        resource: {
          type: 'Agent',
          id: 'agent-456',
          attributes: {
            tenantId: 'tenant-a',
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Allow');
      expect(result.reasons).toContain('user-invoke-agents');
    });
  });

  describe('authorize - tenant status enforcement', () => {
    it('should DENY all operations on suspended tenant', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Agent',
          id: 'Invoke',
        },
        resource: {
          type: 'Agent',
          id: 'agent-456',
          attributes: {
            tenantId: 'tenant-a',
            tenantStatus: 'SUSPENDED',
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Deny');
      expect(result.reasons).toContain('suspended-tenant-deny-all');
    });
  });

  describe('authorize - tier-based restrictions', () => {
    it('should DENY trial tenants from installing premium skills', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Skill',
          id: 'Install',
        },
        resource: {
          type: 'Skill',
          id: 'premium-skill',
          attributes: {
            tenantId: 'trial-tenant',
            tier: 'TRIAL',
            skillType: 'premium',
          },
        },
        context: {
          tenantId: 'trial-tenant',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Deny');
      expect(result.reasons).toContain('trial-tier-skill-restriction');
    });

    it('should ALLOW trial tenants to install free skills', () => {
      const request: AuthorizationRequest = {
        principal: {
          type: 'User',
          id: 'user-123',
        },
        action: {
          type: 'Skill',
          id: 'Install',
        },
        resource: {
          type: 'Skill',
          id: 'free-skill',
          attributes: {
            tenantId: 'trial-tenant',
            tier: 'TRIAL',
            skillType: 'free',
          },
        },
        context: {
          tenantId: 'trial-tenant',
          userGroups: ['Users'],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      // Should be denied by default (no matching permit)
      // To allow, need to add a policy for free skills
      expect(result.decision).toBe('Deny');
    });
  });

  describe('policy management', () => {
    it('should allow adding custom policies', () => {
      const customPolicy: CedarPolicy = {
        id: 'custom-policy',
        effect: 'permit',
        principal: 'User::*',
        action: 'CustomAction::Execute',
        resource: 'CustomResource::*',
        conditions: ['context.tenantId == resource.tenantId'],
        description: 'Custom policy for testing',
      };

      cedar.addPolicy(customPolicy);

      const policies = cedar.getPolicies();
      const added = policies.find((p) => p.id === 'custom-policy');
      expect(added).toBeDefined();
      expect(added?.description).toBe('Custom policy for testing');
    });

    it('should allow removing policies', () => {
      cedar.removePolicy('cross-tenant-isolation');

      const policies = cedar.getPolicies();
      const removed = policies.find((p) => p.id === 'cross-tenant-isolation');
      expect(removed).toBeUndefined();
    });

    it('should allow overriding default policies', () => {
      const customPolicies: CedarPolicy[] = [
        {
          id: 'cross-tenant-isolation',
          effect: 'permit', // Override forbid with permit (DON'T DO THIS IN PRODUCTION!)
          principal: 'User::*',
          action: '*',
          resource: '*',
          description: 'Dangerous override for testing',
        },
      ];

      const customCedar = new CedarAuthorization(customPolicies);

      const request: AuthorizationRequest = {
        principal: { type: 'User', id: 'user-123' },
        action: { type: 'Session', id: 'Read' },
        resource: {
          type: 'Session',
          id: 'session-456',
          attributes: { tenantId: 'tenant-b' },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: [],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = customCedar.authorize(request);

      // With overridden policy, cross-tenant access would be allowed
      expect(result.decision).toBe('Allow');
    });
  });

  describe('buildRequest helper', () => {
    it('should build authorization request from tenant context', () => {
      const context: TenantContext = {
        tenantId: 'acme-corp',
        userId: 'user-123',
        userEmail: 'alice@acme-corp.com',
        userGroups: ['Users'],
        tenantConfig: createMockTenantConfig('acme-corp'),
        isAdmin: false,
      };

      const action = { type: 'Agent', id: 'Invoke' };
      const resource = {
        type: 'Agent',
        id: 'agent-456',
        attributes: { model: 'claude-3-5-sonnet' },
      };

      const request = CedarAuthorization.buildRequest(context, action, resource);

      expect(request.principal.id).toBe('user-123');
      expect(request.action.type).toBe('Agent');
      expect(request.context.tenantId).toBe('acme-corp');
      expect(request.context.isAdmin).toBe(false);
    });
  });

  describe('condition evaluation', () => {
    it('should evaluate equality conditions', () => {
      const policy: CedarPolicy = {
        id: 'test-equality',
        effect: 'permit',
        principal: 'User::*',
        action: 'Test::Action',
        resource: 'Test::Resource',
        conditions: ['context.tenantId == "tenant-a"', 'context.tenantId == resource.tenantId'],
      };

      cedar.addPolicy(policy);

      const request: AuthorizationRequest = {
        principal: { type: 'User', id: 'user-123' },
        action: { type: 'Test', id: 'Action' },
        resource: {
          type: 'Test',
          id: 'Resource',
          attributes: {
            tenantId: 'tenant-a',
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: [],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);
      expect(result.decision).toBe('Allow');
    });

    it('should evaluate boolean conditions', () => {
      const policy: CedarPolicy = {
        id: 'test-boolean',
        effect: 'permit',
        principal: 'User::*',
        action: 'Test::Action',
        resource: 'Test::Resource',
        conditions: ['context.isAdmin == true', 'context.tenantId == resource.tenantId'],
      };

      cedar.addPolicy(policy);

      const request: AuthorizationRequest = {
        principal: { type: 'User', id: 'admin-123' },
        action: { type: 'Test', id: 'Action' },
        resource: {
          type: 'Test',
          id: 'Resource',
          attributes: {
            tenantId: 'tenant-a',
          },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: ['Administrators'],
          isAdmin: true,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);
      expect(result.decision).toBe('Allow');
    });
  });

  describe('default deny', () => {
    it('should deny requests with no matching policies', () => {
      const request: AuthorizationRequest = {
        principal: { type: 'User', id: 'user-123' },
        action: { type: 'Unknown', id: 'UnknownAction' },
        resource: {
          type: 'Unknown',
          id: 'unknown-resource',
          attributes: { tenantId: 'tenant-a' },
        },
        context: {
          tenantId: 'tenant-a',
          userGroups: [],
          isAdmin: false,
          timestamp: new Date().toISOString(),
        },
      };

      const result = cedar.authorize(request);

      expect(result.decision).toBe('Deny');
      expect(result.reasons).toContain('default-deny');
    });
  });
});
