import { describe, it, expect } from 'bun:test';
import {
  chimeraToolsToGatewayTargets,
  allTiersToGatewayTargets,
  TIER_TO_SERVICE_IDENTIFIERS,
} from '../tool-to-gateway-target-mapper';

/**
 * Build a fresh ARN map covering every identifier in the fixture. Helper so
 * individual tests don't get coupled to the identifier list.
 */
function makeFullArnMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ids of Object.values(TIER_TO_SERVICE_IDENTIFIERS)) {
    for (const id of ids) {
      out[id] = `arn:aws:lambda:us-west-2:111111111111:function:chimera-tool-${id}`;
    }
  }
  return out;
}

describe('TIER_TO_SERVICE_IDENTIFIERS fixture', () => {
  it('mirrors the Python gateway_config.py tier slices (regression fixture)', () => {
    // This test intentionally hardcodes the tier contents. When
    // packages/agents/gateway_config.py changes, update the fixture and this
    // test together — it's a canary for drift.
    expect(TIER_TO_SERVICE_IDENTIFIERS.tier1).toEqual([
      'lambda',
      'ec2',
      's3',
      'cloudwatch',
      'sqs',
      'dynamodb',
    ]);
    expect(TIER_TO_SERVICE_IDENTIFIERS.tier2).toEqual([
      'rds',
      'redshift',
      'athena',
      'glue',
      'opensearch',
    ]);
    expect(TIER_TO_SERVICE_IDENTIFIERS.tier3).toEqual([
      'stepfunctions',
      'bedrock',
      'sagemaker',
      'rekognition',
      'textract',
      'transcribe',
      'codebuild',
      'codecommit',
      'codepipeline',
    ]);
    expect(TIER_TO_SERVICE_IDENTIFIERS.tier4).toEqual([]);
  });

  it('every identifier is DNS-safe (lowercase, digits, hyphens only)', () => {
    for (const ids of Object.values(TIER_TO_SERVICE_IDENTIFIERS)) {
      for (const id of ids) {
        expect(id).toMatch(/^[a-z0-9-]+$/);
      }
    }
  });

  it('has no duplicate identifiers across tiers', () => {
    const seen = new Set<string>();
    for (const ids of Object.values(TIER_TO_SERVICE_IDENTIFIERS)) {
      for (const id of ids) {
        expect(seen.has(id)).toBe(false);
        seen.add(id);
      }
    }
  });
});

describe('chimeraToolsToGatewayTargets', () => {
  it('emits one lambda target per tier-1 identifier', () => {
    const arns = makeFullArnMap();
    const out = chimeraToolsToGatewayTargets('tier1', arns);
    expect(out).toHaveLength(TIER_TO_SERVICE_IDENTIFIERS.tier1.length);
    for (const t of out) {
      expect(t.type).toBe('lambda');
      expect(t.arn).toMatch(/^arn:aws:lambda:/);
      expect(t.name).toMatch(/^[a-z0-9-]+$/);
      expect(t.metadata?.chimeraTier).toBe('tier1');
    }
  });

  it('names targets after the service identifier', () => {
    const arns = makeFullArnMap();
    const out = chimeraToolsToGatewayTargets('tier2', arns);
    const names = out.map(t => t.name).sort();
    expect(names).toEqual([...TIER_TO_SERVICE_IDENTIFIERS.tier2].sort());
  });

  it('threads serviceIdentifier into metadata for operator debugging', () => {
    const arns = makeFullArnMap();
    const out = chimeraToolsToGatewayTargets('tier1', arns);
    const s3 = out.find(t => t.name === 's3');
    expect(s3?.metadata?.serviceIdentifier).toBe('s3');
    expect(s3?.metadata?.chimeraTier).toBe('tier1');
  });

  it('throws fail-loud when a tier identifier has no ARN mapping', () => {
    const partial = { s3: 'arn:aws:lambda:us-west-2:111:function:s3' };
    expect(() => chimeraToolsToGatewayTargets('tier1', partial)).toThrow(
      /missing Lambda ARN/
    );
  });

  it('lists every missing identifier in the error message', () => {
    const empty = {};
    let caught: Error | undefined;
    try {
      chimeraToolsToGatewayTargets('tier1', empty);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    // Every tier-1 identifier should appear in the error so the operator
    // doesn't have to re-run to discover them one by one.
    for (const id of TIER_TO_SERVICE_IDENTIFIERS.tier1) {
      expect(caught?.message).toContain(id);
    }
  });

  it('throws on unknown tier', () => {
    expect(() =>
      chimeraToolsToGatewayTargets(
        // @ts-expect-error — deliberately invalid tier
        'tier99',
        {}
      )
    ).toThrow(/unknown toolTier/);
  });

  it('emits zero targets for tier4 without throwing', () => {
    // tier4 is empty — fixture regression guard below ensures it stays empty
    const out = chimeraToolsToGatewayTargets('tier4', {});
    expect(out).toEqual([]);
  });
});

describe('allTiersToGatewayTargets', () => {
  it('emits targets for every non-empty tier in a single pass', () => {
    const arns = makeFullArnMap();
    const out = allTiersToGatewayTargets(arns);
    const expectedCount =
      TIER_TO_SERVICE_IDENTIFIERS.tier1.length +
      TIER_TO_SERVICE_IDENTIFIERS.tier2.length +
      TIER_TO_SERVICE_IDENTIFIERS.tier3.length;
    expect(out).toHaveLength(expectedCount);
  });

  it('produces exactly one target per service identifier (no duplicates)', () => {
    const arns = makeFullArnMap();
    const out = allTiersToGatewayTargets(arns);
    const names = out.map(t => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('re-raises the underlying mapper error on a missing ARN', () => {
    // Supply ARNs for tier1 and tier3 only; tier2 is incomplete.
    const arns: Record<string, string> = {};
    for (const id of TIER_TO_SERVICE_IDENTIFIERS.tier1) {
      arns[id] = `arn:aws:lambda:us-west-2:111:function:${id}`;
    }
    for (const id of TIER_TO_SERVICE_IDENTIFIERS.tier3) {
      arns[id] = `arn:aws:lambda:us-west-2:111:function:${id}`;
    }
    expect(() => allTiersToGatewayTargets(arns)).toThrow(/missing Lambda ARN/);
  });
});
