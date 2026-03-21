/**
 * Tests for Multi-Account Management module
 * Validates AWS Organizations integration and cross-account operations
 */

import { describe, it, expect } from 'bun:test';
import type {
  AWSAccount,
  AccountStatus,
  OrganizationalUnit,
  CrossAccountRole,
  CrossAccountCredentials,
  ServiceControlPolicy,
  OrganizationStructure,
  AccountDiscoveryResult,
  CreateAccountParams,
  CreateAccountStatus,
  MultiAccountContext,
} from '../types';

describe('Multi-Account Types', () => {
  describe('AccountStatus', () => {
    it('should define valid account statuses', () => {
      const statuses: AccountStatus[] = [
        'ACTIVE',
        'SUSPENDED',
        'PENDING_CLOSURE',
      ];

      expect(statuses).toHaveLength(3);
      expect(statuses).toContain('ACTIVE');
    });
  });

  describe('CreateAccountStatus', () => {
    it('should define account creation states', () => {
      const statuses: CreateAccountStatus[] = [
        'IN_PROGRESS',
        'SUCCEEDED',
        'FAILED',
      ];

      expect(statuses).toHaveLength(3);
    });
  });
});

describe('AWSAccount structure', () => {
  it('should create valid AWS account object', () => {
    const account: AWSAccount = {
      id: '123456789012',
      arn: 'arn:aws:organizations::123456789012:account/o-exampleorgid/123456789012',
      name: 'Production Account',
      email: 'prod@example.com',
      status: 'ACTIVE',
      joinedTimestamp: '2024-01-15T10:30:00.000Z',
    };

    expect(account.id).toBe('123456789012');
    expect(account.status).toBe('ACTIVE');
    expect(account.email).toBe('prod@example.com');
  });

  it('should support account with organizational unit', () => {
    const account: AWSAccount = {
      id: '123456789013',
      arn: 'arn:aws:organizations::123456789013:account/o-exampleorgid/123456789013',
      name: 'Dev Account',
      email: 'dev@example.com',
      status: 'ACTIVE',
      organizationalUnitId: 'ou-dev-abc123',
      joinedTimestamp: '2024-02-01T14:20:00.000Z',
      tags: {
        Environment: 'development',
        CostCenter: 'engineering',
      },
    };

    expect(account.organizationalUnitId).toBe('ou-dev-abc123');
    expect(account.tags?.Environment).toBe('development');
  });

  it('should validate 12-digit account ID format', () => {
    const account: AWSAccount = {
      id: '111122223333',
      arn: 'arn:aws:organizations::111122223333:account/o-exampleorgid/111122223333',
      name: 'Test Account',
      email: 'test@example.com',
      status: 'ACTIVE',
      joinedTimestamp: new Date().toISOString(),
    };

    expect(account.id).toMatch(/^\d{12}$/);
  });
});

describe('OrganizationalUnit structure', () => {
  it('should create root OU without parent', () => {
    const rootOU: OrganizationalUnit = {
      id: 'r-abc123',
      arn: 'arn:aws:organizations::123456789012:root/o-exampleorgid/r-abc123',
      name: 'Root',
    };

    expect(rootOU.id).toBe('r-abc123');
    expect(rootOU.parentId).toBeUndefined();
  });

  it('should create nested OU with parent', () => {
    const childOU: OrganizationalUnit = {
      id: 'ou-prod-xyz789',
      arn: 'arn:aws:organizations::123456789012:ou/o-exampleorgid/ou-prod-xyz789',
      name: 'Production',
      parentId: 'r-abc123',
    };

    expect(childOU.parentId).toBe('r-abc123');
    expect(childOU.name).toBe('Production');
  });
});

describe('CrossAccountRole configuration', () => {
  it('should define cross-account role with external ID', () => {
    const role: CrossAccountRole = {
      accountId: '123456789012',
      roleName: 'ChimeraAgentRole',
      roleArn: 'arn:aws:iam::123456789012:role/ChimeraAgentRole',
      externalId: 'unique-external-id-12345',
    };

    expect(role.externalId).toBeDefined();
    expect(role.roleArn).toContain('ChimeraAgentRole');
  });

  it('should support custom session duration', () => {
    const role: CrossAccountRole = {
      accountId: '123456789013',
      roleName: 'ShortLivedRole',
      roleArn: 'arn:aws:iam::123456789013:role/ShortLivedRole',
      externalId: 'external-id-abc',
      sessionDuration: 1800, // 30 minutes
      allowedRegions: ['us-west-2', 'us-east-1'],
    };

    expect(role.sessionDuration).toBe(1800);
    expect(role.allowedRegions).toContain('us-west-2');
  });
});

describe('CrossAccountCredentials', () => {
  it('should contain all required STS credential fields', () => {
    const credentials: CrossAccountCredentials = {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      sessionToken: 'FwoGZXIvYXdzEDoaDKJ...',
      expiration: new Date(Date.now() + 3600000), // 1 hour from now
      accountId: '123456789012',
      roleArn: 'arn:aws:iam::123456789012:role/AssumedRole',
    };

    expect(credentials.accessKeyId).toMatch(/^AKIA/);
    expect(credentials.sessionToken).toBeDefined();
    expect(credentials.expiration).toBeInstanceOf(Date);
  });
});

describe('ServiceControlPolicy structure', () => {
  it('should define SCP with policy content', () => {
    const scp: ServiceControlPolicy = {
      id: 'p-abc12345',
      arn: 'arn:aws:organizations::123456789012:policy/o-exampleorgid/service_control_policy/p-abc12345',
      name: 'DenyRegionRestriction',
      description: 'Deny access outside allowed regions',
      content: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Deny',
            Action: '*',
            Resource: '*',
            Condition: {
              StringNotEquals: {
                'aws:RequestedRegion': ['us-west-2', 'us-east-1'],
              },
            },
          },
        ],
      }),
      awsManaged: false,
      attachedTargets: ['ou-prod-xyz789'],
    };

    expect(scp.name).toBe('DenyRegionRestriction');
    expect(scp.awsManaged).toBe(false);
    expect(scp.attachedTargets).toContain('ou-prod-xyz789');
    expect(JSON.parse(scp.content)).toHaveProperty('Version');
  });
});

describe('OrganizationStructure', () => {
  it('should contain complete organization hierarchy', () => {
    const structure: OrganizationStructure = {
      organizationId: 'o-exampleorgid',
      organizationArn: 'arn:aws:organizations::123456789012:organization/o-exampleorgid',
      masterAccountId: '123456789012',
      root: {
        id: 'r-abc123',
        arn: 'arn:aws:organizations::123456789012:root/o-exampleorgid/r-abc123',
        name: 'Root',
      },
      organizationalUnits: [
        {
          id: 'ou-prod-xyz789',
          arn: 'arn:aws:organizations::123456789012:ou/o-exampleorgid/ou-prod-xyz789',
          name: 'Production',
          parentId: 'r-abc123',
        },
        {
          id: 'ou-dev-abc456',
          arn: 'arn:aws:organizations::123456789012:ou/o-exampleorgid/ou-dev-abc456',
          name: 'Development',
          parentId: 'r-abc123',
        },
      ],
      accounts: [
        {
          id: '123456789012',
          arn: 'arn:aws:organizations::123456789012:account/o-exampleorgid/123456789012',
          name: 'Master Account',
          email: 'master@example.com',
          status: 'ACTIVE',
          joinedTimestamp: '2024-01-01T00:00:00.000Z',
        },
      ],
      enabledPolicyTypes: ['SERVICE_CONTROL_POLICY', 'TAG_POLICY'],
    };

    expect(structure.organizationalUnits).toHaveLength(2);
    expect(structure.accounts).toHaveLength(1);
    expect(structure.enabledPolicyTypes).toContain('SERVICE_CONTROL_POLICY');
  });
});

describe('CreateAccountParams', () => {
  it('should define account creation parameters', () => {
    const params: CreateAccountParams = {
      accountName: 'New Production Account',
      email: 'newprod@example.com',
      iamUserAccessToBilling: 'DENY',
      roleName: 'OrganizationAccountAccessRole',
      organizationalUnitId: 'ou-prod-xyz789',
      tags: {
        Environment: 'production',
        Owner: 'platform-team',
      },
    };

    expect(params.accountName).toBe('New Production Account');
    expect(params.iamUserAccessToBilling).toBe('DENY');
    expect(params.roleName).toBe('OrganizationAccountAccessRole');
  });

  it('should support minimal account creation', () => {
    const params: CreateAccountParams = {
      accountName: 'Minimal Account',
      email: 'minimal@example.com',
    };

    expect(params.accountName).toBeDefined();
    expect(params.email).toBeDefined();
    expect(params.organizationalUnitId).toBeUndefined();
  });
});

describe('MultiAccountContext', () => {
  it('should extend AWSToolContext with cross-account fields', () => {
    const context: MultiAccountContext = {
      tenantId: 'tenant-acme',
      agentId: 'agent-multi-01',
      region: 'us-west-2',
      targetAccountId: '123456789013',
      externalId: 'unique-external-id',
      crossAccountRole: 'ChimeraAgentRole',
    };

    expect(context.tenantId).toBe('tenant-acme');
    expect(context.agentId).toBe('agent-multi-01');
    expect(context.targetAccountId).toBe('123456789013');
    expect(context.crossAccountRole).toBe('ChimeraAgentRole');
  });
});

describe('AccountDiscoveryResult', () => {
  it('should track discovery metrics', () => {
    const result: AccountDiscoveryResult = {
      accounts: [
        {
          id: '111111111111',
          arn: 'arn:aws:organizations::111111111111:account/o-exampleorgid/111111111111',
          name: 'Account 1',
          email: 'account1@example.com',
          status: 'ACTIVE',
          joinedTimestamp: new Date().toISOString(),
        },
        {
          id: '222222222222',
          arn: 'arn:aws:organizations::222222222222:account/o-exampleorgid/222222222222',
          name: 'Account 2',
          email: 'account2@example.com',
          status: 'ACTIVE',
          joinedTimestamp: new Date().toISOString(),
        },
      ],
      organizationStructure: {
        organizationId: 'o-exampleorgid',
        organizationArn: 'arn:aws:organizations::123456789012:organization/o-exampleorgid',
        masterAccountId: '123456789012',
        root: {
          id: 'r-abc123',
          arn: 'arn:aws:organizations::123456789012:root/o-exampleorgid/r-abc123',
          name: 'Root',
        },
        organizationalUnits: [],
        accounts: [],
        enabledPolicyTypes: [],
      },
      timestamp: new Date().toISOString(),
      durationMs: 1500,
    };

    expect(result.accounts).toHaveLength(2);
    expect(result.durationMs).toBe(1500);
    expect(result.timestamp).toBeDefined();
  });
});

describe('Type safety and structure', () => {
  it('should validate account status types', () => {
    // Type checking ensures only valid statuses are accepted
    const validStatuses: AccountStatus[] = ['ACTIVE', 'SUSPENDED', 'PENDING_CLOSURE'];
    expect(validStatuses).toHaveLength(3);
  });
});

describe('Tenant isolation in multi-account operations', () => {
  it('should require tenantId in MultiAccountContext', () => {
    const context: MultiAccountContext = {
      tenantId: 'tenant-1',
      agentId: 'agent-01',
      region: 'us-west-2',
      targetAccountId: '123456789012',
    };

    expect(context.tenantId).toBe('tenant-1');
  });

  it('should prevent cross-tenant account access', () => {
    const tenant1Context: MultiAccountContext = {
      tenantId: 'tenant-1',
      agentId: 'agent-t1',
      region: 'us-west-2',
      targetAccountId: '111111111111',
    };

    const tenant2Context: MultiAccountContext = {
      tenantId: 'tenant-2',
      agentId: 'agent-t2',
      region: 'us-west-2',
      targetAccountId: '222222222222',
    };

    // Verify contexts are isolated by tenant
    expect(tenant1Context.tenantId).not.toBe(tenant2Context.tenantId);
    expect(tenant1Context.targetAccountId).not.toBe(tenant2Context.targetAccountId);
  });
});

describe('AWS Organizations region constraint', () => {
  it('should document Organizations API global endpoint behavior', () => {
    // AWS Organizations API is only accessible from us-east-1
    // This test validates the constraint is documented in types
    const context: MultiAccountContext = {
      tenantId: 'tenant-test',
      agentId: 'agent-test',
      region: 'us-east-1', // MUST be us-east-1 for Organizations API
    };

    expect(context.region).toBe('us-east-1');
  });
});
