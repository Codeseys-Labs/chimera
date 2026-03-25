/**
 * Tests for CostAttributionService
 *
 * Validates resource tagging, untagging, pagination, and
 * Cost Explorer query interfaces for per-tenant billing reports.
 */

import { describe, it, expect } from 'bun:test';
import {
  CostAttributionService,
  TENANT_TAG_KEY,
  TaggingAPIClient,
  CostExplorerAPIClient,
} from '../cost-attribution-service';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTaggingClient(overrides: Partial<TaggingAPIClient> = {}): TaggingAPIClient {
  return {
    tagResources: async () => ({ FailedResourcesMap: {} }),
    untagResources: async () => ({ FailedResourcesMap: {} }),
    getResources: async () => ({ ResourceTagMappingList: [], PaginationToken: undefined }),
    ...overrides,
  };
}

function makeCostExplorerClient(overrides: Partial<CostExplorerAPIClient> = {}): CostExplorerAPIClient {
  return {
    getCostAndUsage: async () => ({ ResultsByTime: [] }),
    ...overrides,
  };
}

function makeService(
  taggingClient?: Partial<TaggingAPIClient>,
  costExplorerClient?: Partial<CostExplorerAPIClient>,
): CostAttributionService {
  return new CostAttributionService({
    taggingClient: makeTaggingClient(taggingClient),
    costExplorerClient: makeCostExplorerClient(costExplorerClient),
  });
}

// ---------------------------------------------------------------------------
// tagResources
// ---------------------------------------------------------------------------

describe('CostAttributionService.tagResources', () => {
  it('should apply the tenant tag to all provided ARNs', async () => {
    const calls: Array<{ ResourceARNList: string[]; Tags: Record<string, string> }> = [];

    const svc = makeService({
      tagResources: async (params) => {
        calls.push(params);
        return { FailedResourcesMap: {} };
      },
    });

    const arns = ['arn:aws:dynamodb:us-east-1:123:table/foo'];
    const result = await svc.tagResources('acme', arns);

    expect(result.tagged).toBe(1);
    expect(result.failures).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].Tags).toEqual({ [TENANT_TAG_KEY]: 'acme' });
    expect(calls[0].ResourceARNList).toEqual(arns);
  });

  it('should batch ARNs in groups of 20', async () => {
    const batchSizes: number[] = [];
    const arns = Array.from({ length: 45 }, (_, i) => `arn:aws:s3:::bucket-${i}`);

    const svc = makeService({
      tagResources: async (params) => {
        batchSizes.push(params.ResourceARNList.length);
        return { FailedResourcesMap: {} };
      },
    });

    await svc.tagResources('tenant-x', arns);

    expect(batchSizes).toHaveLength(3);
    expect(batchSizes[0]).toBe(20);
    expect(batchSizes[1]).toBe(20);
    expect(batchSizes[2]).toBe(5);
  });

  it('should report partial failures without throwing', async () => {
    const failedArn = 'arn:aws:s3:::restricted-bucket';
    const goodArn = 'arn:aws:s3:::allowed-bucket';

    const svc = makeService({
      tagResources: async () => ({
        FailedResourcesMap: {
          [failedArn]: { StatusCode: 403, ErrorCode: 'AccessDenied', ErrorMessage: 'Access denied' },
        },
      }),
    });

    const result = await svc.tagResources('tenant-y', [goodArn, failedArn]);

    expect(result.tagged).toBe(1);
    expect(result.failures[failedArn]).toBeDefined();
    expect(result.failures[failedArn].ErrorCode).toBe('AccessDenied');
  });

  it('should return zero tagged when given empty ARN list', async () => {
    const svc = makeService();
    const result = await svc.tagResources('tenant-z', []);
    expect(result.tagged).toBe(0);
    expect(result.failures).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// untagResources
// ---------------------------------------------------------------------------

describe('CostAttributionService.untagResources', () => {
  it('should remove the tenant tag key from all provided ARNs', async () => {
    const calls: Array<{ ResourceARNList: string[]; TagKeys: string[] }> = [];

    const svc = makeService({
      untagResources: async (params) => {
        calls.push(params);
        return { FailedResourcesMap: {} };
      },
    });

    const arns = ['arn:aws:lambda:us-east-1:123:function:myFn'];
    const result = await svc.untagResources('acme', arns);

    expect(result.untagged).toBe(1);
    expect(result.failures).toEqual({});
    expect(calls[0].TagKeys).toContain(TENANT_TAG_KEY);
  });

  it('should batch untagging in groups of 20', async () => {
    const batchSizes: number[] = [];
    const arns = Array.from({ length: 25 }, (_, i) => `arn:aws:lambda:::fn-${i}`);

    const svc = makeService({
      untagResources: async (params) => {
        batchSizes.push(params.ResourceARNList.length);
        return { FailedResourcesMap: {} };
      },
    });

    await svc.untagResources('tenant', arns);

    expect(batchSizes).toHaveLength(2);
    expect(batchSizes[0]).toBe(20);
    expect(batchSizes[1]).toBe(5);
  });

  it('should report untag failures without throwing', async () => {
    const failedArn = 'arn:aws:iam:::role/protected';
    const svc = makeService({
      untagResources: async () => ({
        FailedResourcesMap: {
          [failedArn]: { StatusCode: 403, ErrorCode: 'AccessDenied' },
        },
      }),
    });

    const result = await svc.untagResources('tenant', [failedArn, 'arn:aws:s3:::ok-bucket']);

    expect(result.untagged).toBe(1);
    expect(result.failures[failedArn]).toBeDefined();
  });

  it('should return zero untagged for empty ARN list', async () => {
    const svc = makeService();
    const result = await svc.untagResources('tenant', []);
    expect(result.untagged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTaggedResources
// ---------------------------------------------------------------------------

describe('CostAttributionService.getTaggedResources', () => {
  it('should return resources tagged with the tenant id', async () => {
    const svc = makeService({
      getResources: async () => ({
        ResourceTagMappingList: [
          { ResourceARN: 'arn:aws:s3:::bucket-1', Tags: [{ Key: TENANT_TAG_KEY, Value: 'acme' }] },
          { ResourceARN: 'arn:aws:s3:::bucket-2', Tags: [{ Key: TENANT_TAG_KEY, Value: 'acme' }] },
        ],
      }),
    });

    const resources = await svc.getTaggedResources('acme');
    expect(resources).toHaveLength(2);
    expect(resources[0].ResourceARN).toBe('arn:aws:s3:::bucket-1');
  });

  it('should filter by tenant id tag', async () => {
    const capturedFilters: Array<Array<{ Key: string; Values: string[] }>> = [];

    const svc = makeService({
      getResources: async (params) => {
        capturedFilters.push(params.TagFilters);
        return { ResourceTagMappingList: [] };
      },
    });

    await svc.getTaggedResources('tenant-abc');

    expect(capturedFilters[0]).toEqual([{ Key: TENANT_TAG_KEY, Values: ['tenant-abc'] }]);
  });

  it('should paginate through all results', async () => {
    let callCount = 0;
    const svc = makeService({
      getResources: async (params) => {
        callCount++;
        if (!params.PaginationToken) {
          return {
            ResourceTagMappingList: [{ ResourceARN: 'arn:aws:s3:::page-1' }],
            PaginationToken: 'token-page-2',
          };
        }
        return {
          ResourceTagMappingList: [{ ResourceARN: 'arn:aws:s3:::page-2' }],
          PaginationToken: undefined,
        };
      },
    });

    const resources = await svc.getTaggedResources('tenant');

    expect(callCount).toBe(2);
    expect(resources).toHaveLength(2);
    expect(resources.map((r) => r.ResourceARN)).toEqual([
      'arn:aws:s3:::page-1',
      'arn:aws:s3:::page-2',
    ]);
  });

  it('should return empty array when no resources are tagged', async () => {
    const svc = makeService();
    const resources = await svc.getTaggedResources('unknown-tenant');
    expect(resources).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getTenantCostReport
// ---------------------------------------------------------------------------

describe('CostAttributionService.getTenantCostReport', () => {
  it('should build a cost report with service breakdown and monthly totals', async () => {
    const svc = makeService(
      {},
      {
        getCostAndUsage: async () => ({
          ResultsByTime: [
            {
              TimePeriod: { Start: '2026-01-01', End: '2026-02-01' },
              Groups: [
                {
                  Keys: ['Amazon Bedrock'],
                  Metrics: { UnblendedCost: { Amount: '45.00', Unit: 'USD' } },
                },
                {
                  Keys: ['Amazon DynamoDB'],
                  Metrics: { UnblendedCost: { Amount: '5.50', Unit: 'USD' } },
                },
              ],
              Estimated: false,
            },
          ],
        }),
      },
    );

    const report = await svc.getTenantCostReport('acme', '2026-01-01', '2026-02-01');

    expect(report.tenantId).toBe('acme');
    expect(report.totalCostUsd).toBeCloseTo(50.5);
    expect(report.byService).toHaveLength(2);
    // Sorted descending by cost
    expect(report.byService[0].service).toBe('Amazon Bedrock');
    expect(report.byService[0].costUsd).toBeCloseTo(45.0);
    expect(report.byMonth).toHaveLength(1);
    expect(report.byMonth[0].period).toBe('2026-01-01');
    expect(report.byMonth[0].costUsd).toBeCloseTo(50.5);
  });

  it('should pass the correct tag filter to Cost Explorer', async () => {
    let capturedFilter: { Tags: { Key: string; Values: string[] } } | undefined;

    const svc = makeService(
      {},
      {
        getCostAndUsage: async (params) => {
          capturedFilter = params.Filter;
          return { ResultsByTime: [] };
        },
      },
    );

    await svc.getTenantCostReport('my-tenant', '2026-01-01', '2026-02-01');

    expect(capturedFilter).toEqual({
      Tags: { Key: TENANT_TAG_KEY, Values: ['my-tenant'] },
    });
  });

  it('should return zero totals when Cost Explorer returns no results', async () => {
    const svc = makeService();
    const report = await svc.getTenantCostReport('empty-tenant', '2026-01-01', '2026-02-01');

    expect(report.totalCostUsd).toBe(0);
    expect(report.byService).toEqual([]);
    expect(report.byMonth).toEqual([]);
  });

  it('should aggregate service costs across multiple months', async () => {
    const svc = makeService(
      {},
      {
        getCostAndUsage: async () => ({
          ResultsByTime: [
            {
              TimePeriod: { Start: '2026-01-01', End: '2026-02-01' },
              Groups: [
                { Keys: ['Amazon Bedrock'], Metrics: { UnblendedCost: { Amount: '10.00', Unit: 'USD' } } },
              ],
              Estimated: false,
            },
            {
              TimePeriod: { Start: '2026-02-01', End: '2026-03-01' },
              Groups: [
                { Keys: ['Amazon Bedrock'], Metrics: { UnblendedCost: { Amount: '20.00', Unit: 'USD' } } },
              ],
              Estimated: false,
            },
          ],
        }),
      },
    );

    const report = await svc.getTenantCostReport('tenant', '2026-01-01', '2026-03-01');

    expect(report.totalCostUsd).toBeCloseTo(30.0);
    expect(report.byService).toHaveLength(1);
    expect(report.byService[0].costUsd).toBeCloseTo(30.0);
    expect(report.byMonth).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// getMonthlyTenantCosts
// ---------------------------------------------------------------------------

describe('CostAttributionService.getMonthlyTenantCosts', () => {
  it('should return monthly cost totals', async () => {
    const svc = makeService(
      {},
      {
        getCostAndUsage: async () => ({
          ResultsByTime: [
            {
              TimePeriod: { Start: '2026-01-01', End: '2026-02-01' },
              Total: { UnblendedCost: { Amount: '123.45', Unit: 'USD' } },
              Estimated: false,
            },
            {
              TimePeriod: { Start: '2026-02-01', End: '2026-03-01' },
              Total: { UnblendedCost: { Amount: '200.00', Unit: 'USD' } },
              Estimated: true,
            },
          ],
        }),
      },
    );

    const costs = await svc.getMonthlyTenantCosts('acme', 3);

    expect(costs).toHaveLength(2);
    expect(costs[0].period).toBe('2026-01-01');
    expect(costs[0].costUsd).toBeCloseTo(123.45);
    expect(costs[0].estimated).toBe(false);
    expect(costs[1].estimated).toBe(true);
  });

  it('should default to 3 months lookback', async () => {
    let capturedTimePeriod: { Start: string; End: string } | undefined;

    const svc = makeService(
      {},
      {
        getCostAndUsage: async (params) => {
          capturedTimePeriod = params.TimePeriod;
          return { ResultsByTime: [] };
        },
      },
    );

    await svc.getMonthlyTenantCosts('acme');

    // 3 months back → start should be defined and before end
    expect(capturedTimePeriod.Start).toBeDefined();
    expect(capturedTimePeriod.End).toBeDefined();
    expect(capturedTimePeriod.Start < capturedTimePeriod.End).toBe(true);
  });

  it('should use MONTHLY granularity', async () => {
    let capturedGranularity: 'DAILY' | 'MONTHLY' | 'HOURLY' | undefined;

    const svc = makeService(
      {},
      {
        getCostAndUsage: async (params) => {
          capturedGranularity = params.Granularity;
          return { ResultsByTime: [] };
        },
      },
    );

    await svc.getMonthlyTenantCosts('tenant', 2);

    expect(capturedGranularity).toBe('MONTHLY');
  });
});

// ---------------------------------------------------------------------------
// getServiceBreakdown
// ---------------------------------------------------------------------------

describe('CostAttributionService.getServiceBreakdown', () => {
  it('should return services sorted by cost descending', async () => {
    const svc = makeService(
      {},
      {
        getCostAndUsage: async () => ({
          ResultsByTime: [
            {
              TimePeriod: { Start: '2026-01-01', End: '2026-02-01' },
              Groups: [
                { Keys: ['Amazon S3'], Metrics: { UnblendedCost: { Amount: '2.00', Unit: 'USD' } } },
                { Keys: ['Amazon Bedrock'], Metrics: { UnblendedCost: { Amount: '50.00', Unit: 'USD' } } },
                { Keys: ['Amazon DynamoDB'], Metrics: { UnblendedCost: { Amount: '10.00', Unit: 'USD' } } },
              ],
              Estimated: false,
            },
          ],
        }),
      },
    );

    const breakdown = await svc.getServiceBreakdown('acme', '2026-01-01');

    expect(breakdown[0].service).toBe('Amazon Bedrock');
    expect(breakdown[0].costUsd).toBeCloseTo(50.0);
    expect(breakdown[1].service).toBe('Amazon DynamoDB');
    expect(breakdown[2].service).toBe('Amazon S3');
  });

  it('should query exactly the requested period (one month)', async () => {
    let capturedTimePeriod: { Start: string; End: string } | undefined;

    const svc = makeService(
      {},
      {
        getCostAndUsage: async (params) => {
          capturedTimePeriod = params.TimePeriod;
          return { ResultsByTime: [] };
        },
      },
    );

    await svc.getServiceBreakdown('tenant', '2026-03-01');

    expect(capturedTimePeriod.Start).toBe('2026-03-01');
    expect(capturedTimePeriod.End).toBe('2026-04-01');
  });

  it('should return empty array when there are no groups', async () => {
    const svc = makeService();
    const breakdown = await svc.getServiceBreakdown('tenant', '2026-01-01');
    expect(breakdown).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// custom tagKey
// ---------------------------------------------------------------------------

describe('CostAttributionService custom tagKey', () => {
  it('should use a custom tag key when configured', async () => {
    const calls: Array<{ ResourceARNList: string[]; Tags: Record<string, string> }> = [];

    const svc = new CostAttributionService({
      taggingClient: makeTaggingClient({
        tagResources: async (params) => {
          calls.push(params);
          return { FailedResourcesMap: {} };
        },
      }),
      costExplorerClient: makeCostExplorerClient(),
      tagKey: 'my-org:tenant',
    });

    await svc.tagResources('acme', ['arn:aws:s3:::bucket']);

    expect(calls[0].Tags['my-org:tenant']).toBe('acme');
    expect(calls[0].Tags[TENANT_TAG_KEY]).toBeUndefined();
  });
});
