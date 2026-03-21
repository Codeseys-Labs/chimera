/**
 * Tests for Discovery module
 *
 * Verifies:
 * - Resource Explorer query builder (inline implementation)
 * - Type definitions and interfaces
 * - Discovery error handling
 *
 * Note: Tool creation tests are skipped because @strands-agents/sdk is not
 * published. Query builder functionality is tested via inline implementation.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  DiscoveryError,
  type ResourceFilter,
  type ResourceTag,
  type ResourceInventoryEntry,
  type AWSResourceType,
  type ResourceStatus,
  type StackStatus,
  type DriftStatus,
  type AWSRegion,
} from '../types';

// Inline QueryBuilder implementation for testing (mirrors resource-explorer.ts)
class ExplorerQueryBuilder {
  private parts: string[] = [];

  withTag(key: string, value?: string): this {
    if (value) {
      this.parts.push(`tag:${key}=${value}`);
    } else {
      this.parts.push(`tag:${key}`);
    }
    return this;
  }

  withResourceType(service: string, type: string): this {
    this.parts.push(`resourcetype:${service}:${type}`);
    return this;
  }

  withRegion(region: AWSRegion): this {
    this.parts.push(`region:${region}`);
    return this;
  }

  withSearchTerm(term: string): this {
    this.parts.push(term);
    return this;
  }

  build(): string {
    return this.parts.join(' ');
  }

  static fromFilter(filter: ResourceFilter): string {
    const builder = new ExplorerQueryBuilder();

    if (filter.tags) {
      filter.tags.forEach((tag) => builder.withTag(tag.key, tag.value));
    }

    if (filter.regions) {
      filter.regions.forEach((region) => builder.withRegion(region));
    }

    if (filter.resourceTypes) {
      filter.resourceTypes.forEach((type) => {
        const [service, resourceType] = ExplorerQueryBuilder.parseResourceType(type);
        if (service && resourceType) {
          builder.withResourceType(service, resourceType);
        }
      });
    }

    const query = builder.build();
    return query || '*';
  }

  private static parseResourceType(awsType: string): [string | null, string | null] {
    const match = awsType.match(/^AWS::([^:]+)::(.+)$/);
    if (!match) return [null, null];

    const service = match[1].toLowerCase();
    const type = match[2]
      .replace(/([A-Z])/g, '-$1')
      .toLowerCase()
      .replace(/^-/, '');

    return [service, type];
  }
}

describe('ExplorerQueryBuilder', () => {
  let builder: ExplorerQueryBuilder;

  beforeEach(() => {
    builder = new ExplorerQueryBuilder();
  });

  describe('query string construction', () => {
    it('should build tag query', () => {
      const query = builder.withTag('Environment', 'production').build();
      expect(query).toBe('tag:Environment=production');
    });

    it('should build tag query without value', () => {
      const query = builder.withTag('Project').build();
      expect(query).toBe('tag:Project');
    });

    it('should build resource type query', () => {
      const query = builder.withResourceType('lambda', 'function').build();
      expect(query).toBe('resourcetype:lambda:function');
    });

    it('should build region query', () => {
      const query = builder.withRegion('us-east-1').build();
      expect(query).toBe('region:us-east-1');
    });

    it('should combine multiple query parts', () => {
      const query = builder
        .withTag('Environment', 'production')
        .withResourceType('dynamodb', 'table')
        .withRegion('us-west-2')
        .build();

      expect(query).toBe(
        'tag:Environment=production resourcetype:dynamodb:table region:us-west-2'
      );
    });

    it('should support wildcard in tag values', () => {
      const query = builder.withTag('Project', 'chimera*').build();
      expect(query).toBe('tag:Project=chimera*');
    });

    it('should support search terms', () => {
      const query = builder.withSearchTerm('my-resource-name').build();
      expect(query).toBe('my-resource-name');
    });

    it('should build complex queries', () => {
      const query = builder
        .withTag('Team', 'platform')
        .withTag('Environment', 'prod*')
        .withResourceType('ec2', 'instance')
        .withRegion('us-east-1')
        .withSearchTerm('web-server')
        .build();

      expect(query).toContain('tag:Team=platform');
      expect(query).toContain('tag:Environment=prod*');
      expect(query).toContain('resourcetype:ec2:instance');
      expect(query).toContain('region:us-east-1');
      expect(query).toContain('web-server');
    });
  });

  describe('fromFilter', () => {
    it('should convert filter with tags', () => {
      const filter: ResourceFilter = {
        tags: [
          { key: 'Environment', value: 'production' },
          { key: 'Team', value: 'backend' },
        ],
      };

      const query = ExplorerQueryBuilder.fromFilter(filter);
      expect(query).toContain('tag:Environment=production');
      expect(query).toContain('tag:Team=backend');
    });

    it('should convert filter with regions', () => {
      const filter: ResourceFilter = {
        regions: ['us-east-1', 'us-west-2'],
      };

      const query = ExplorerQueryBuilder.fromFilter(filter);
      expect(query).toContain('region:us-east-1');
      expect(query).toContain('region:us-west-2');
    });

    it('should convert filter with resource types', () => {
      const filter: ResourceFilter = {
        resourceTypes: ['AWS::Lambda::Function', 'AWS::DynamoDB::Table'],
      };

      const query = ExplorerQueryBuilder.fromFilter(filter);
      expect(query).toContain('resourcetype:lambda:function');
      expect(query).toContain('resourcetype:dynamodb:table');
    });

    it('should handle empty filter with wildcard', () => {
      const filter: ResourceFilter = {};
      const query = ExplorerQueryBuilder.fromFilter(filter);
      expect(query).toBe('*');
    });

    it('should convert complex filter', () => {
      const filter: ResourceFilter = {
        resourceTypes: ['AWS::EC2::Instance'],
        regions: ['us-east-1'],
        tags: [{ key: 'Environment', value: 'staging' }],
      };

      const query = ExplorerQueryBuilder.fromFilter(filter);
      expect(query).toContain('resourcetype:ec2:instance');
      expect(query).toContain('region:us-east-1');
      expect(query).toContain('tag:Environment=staging');
    });

    it('should handle tag without value', () => {
      const filter: ResourceFilter = {
        tags: [{ key: 'HasBackup' }],
      };

      const query = ExplorerQueryBuilder.fromFilter(filter);
      expect(query).toBe('tag:HasBackup');
    });
  });
});


describe('DiscoveryError', () => {
  it('should create error with code and message', () => {
    const error = new DiscoveryError(
      'RESOURCE_NOT_FOUND',
      'Resource with ARN arn:aws:... not found'
    );

    expect(error.code).toBe('RESOURCE_NOT_FOUND');
    expect(error.message).toBe('Resource with ARN arn:aws:... not found');
    expect(error.name).toBe('DiscoveryError');
  });

  it('should store error details', () => {
    const details = { arn: 'arn:aws:ec2:us-east-1:123456789012:instance/i-abc123' };
    const error = new DiscoveryError('PERMISSION_DENIED', 'Access denied', details);

    expect(error.details).toEqual(details);
  });

  it('should support all error codes', () => {
    const codes = [
      'SERVICE_UNAVAILABLE',
      'PERMISSION_DENIED',
      'RESOURCE_NOT_FOUND',
      'REGION_NOT_ENABLED',
      'INVALID_QUERY',
      'AGGREGATOR_NOT_FOUND',
      'INDEX_NOT_FOUND',
      'RATE_LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
    ] as const;

    codes.forEach(code => {
      const error = new DiscoveryError(code, 'Test error');
      expect(error.code).toBe(code);
    });
  });
});

describe('type definitions', () => {
  describe('ResourceTag', () => {
    it('should define tag structure', () => {
      const tag: ResourceTag = {
        key: 'Environment',
        value: 'production',
      };

      expect(tag.key).toBe('Environment');
      expect(tag.value).toBe('production');
    });
  });

  describe('ResourceStatus', () => {
    it('should support all status values', () => {
      const statuses: ResourceStatus[] = [
        'OK',
        'INSUFFICIENT_DATA',
        'NOT_APPLICABLE',
        'ResourceDeleted',
        'ResourceNotRecorded',
      ];

      statuses.forEach(status => {
        const entry: Partial<ResourceInventoryEntry> = { status };
        expect(entry.status).toBe(status);
      });
    });
  });

  describe('StackStatus', () => {
    it('should support CloudFormation stack statuses', () => {
      const statuses: StackStatus[] = [
        'CREATE_COMPLETE',
        'UPDATE_IN_PROGRESS',
        'DELETE_COMPLETE',
        'ROLLBACK_COMPLETE',
      ];

      statuses.forEach(status => {
        expect(typeof status).toBe('string');
      });
    });
  });

  describe('DriftStatus', () => {
    it('should support drift detection statuses', () => {
      const statuses: DriftStatus[] = [
        'DRIFTED',
        'IN_SYNC',
        'UNKNOWN',
        'NOT_CHECKED',
      ];

      statuses.forEach(status => {
        expect(typeof status).toBe('string');
      });
    });
  });

  describe('AWSResourceType', () => {
    it('should include compute resources', () => {
      const types: AWSResourceType[] = [
        'AWS::EC2::Instance',
        'AWS::Lambda::Function',
        'AWS::ECS::Service',
      ];

      types.forEach(type => {
        expect(type).toContain('AWS::');
      });
    });

    it('should include storage resources', () => {
      const types: AWSResourceType[] = [
        'AWS::S3::Bucket',
        'AWS::DynamoDB::Table',
        'AWS::RDS::DBInstance',
      ];

      types.forEach(type => {
        expect(type).toContain('AWS::');
      });
    });

    it('should include networking resources', () => {
      const types: AWSResourceType[] = [
        'AWS::EC2::VPC',
        'AWS::EC2::SecurityGroup',
        'AWS::ElasticLoadBalancingV2::LoadBalancer',
      ];

      // Verify networking resource types are valid AWS resource identifiers
      types.forEach(type => {
        expect(type).toContain('AWS::');
        expect(type.split('::').length).toBe(3); // Format: AWS::<Service>::<Type>
      });
    });
  });

  describe('ResourceInventoryEntry', () => {
    it('should define complete inventory entry', () => {
      const entry: ResourceInventoryEntry = {
        arn: 'arn:aws:lambda:us-east-1:123456789012:function:my-function',
        resourceType: 'AWS::Lambda::Function',
        resourceId: 'my-function',
        region: 'us-east-1',
        accountId: '123456789012',
        status: 'OK',
        tags: [
          { key: 'Environment', value: 'production' },
          { key: 'Project', value: 'chimera' },
        ],
        lastUpdatedAt: '2026-03-21T10:00:00Z',
        cloudFormationStack: 'chimera-lambda-stack',
        managedBy: 'cloudformation',
        weeklyCost: 15.50,
        dailyCostAvg: 2.21,
        costCurrency: 'USD',
        compliant: true,
        lastComplianceCheck: '2026-03-21T09:00:00Z',
      };

      expect(entry.arn).toContain('arn:aws:');
      expect(entry.resourceType).toBe('AWS::Lambda::Function');
      expect(entry.tags).toHaveLength(2);
      expect(entry.weeklyCost).toBeGreaterThan(0);
      expect(entry.managedBy).toBe('cloudformation');
    });
  });

  describe('ResourceFilter', () => {
    it('should define filter structure', () => {
      const filter: ResourceFilter = {
        resourceTypes: ['AWS::Lambda::Function', 'AWS::DynamoDB::Table'],
        regions: ['us-east-1', 'us-west-2'],
        tags: [
          { key: 'Environment', value: 'production' },
          { key: 'Team' },
        ],
        statuses: ['OK'],
        createdAfter: '2026-01-01T00:00:00Z',
        updatedBefore: '2026-03-21T23:59:59Z',
      };

      expect(filter.resourceTypes).toHaveLength(2);
      expect(filter.regions).toHaveLength(2);
      expect(filter.tags).toHaveLength(2);
      expect(filter.createdAfter).toMatch(/^\d{4}-\d{2}-\d{2}/);
    });

    it('should support partial filters', () => {
      const filter: ResourceFilter = {
        tags: [{ key: 'HasBackup', value: 'true' }],
      };

      expect(filter.tags).toHaveLength(1);
      expect(filter.resourceTypes).toBeUndefined();
      expect(filter.regions).toBeUndefined();
    });
  });
});

describe('resource relationships', () => {
  it('should define relationship types', () => {
    const types = [
      'Is associated with',
      'Is accessed by',
      'Is attached to',
      'Is contained in',
      'Contains',
      'Depends on',
    ] as const;

    types.forEach(type => {
      expect(typeof type).toBe('string');
    });
  });
});

describe('pagination support', () => {
  it('should include pagination in query results', () => {
    const result = {
      items: [
        {
          arn: 'arn:aws:s3:::my-bucket',
          resourceType: 'AWS::S3::Bucket' as AWSResourceType,
          resourceId: 'my-bucket',
          region: 'us-east-1' as const,
          accountId: '123456789012',
          status: 'OK' as ResourceStatus,
          tags: [],
          lastUpdatedAt: '2026-03-21T10:00:00Z',
        },
      ],
      pagination: {
        nextToken: 'token-abc123',
        hasMore: true,
        totalCount: 150,
        pageSize: 100,
      },
    };

    expect(result.pagination.hasMore).toBe(true);
    expect(result.pagination.totalCount).toBe(150);
    expect(result.pagination.nextToken).toBe('token-abc123');
  });
});
