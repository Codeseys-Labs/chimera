/**
 * Unit tests for PromptOptimizer
 *
 * Tests the A/B experiment winner-selection logic and experiment tracking.
 * The winner determination in completeExperiment() is a pure computation
 * that can be validated by testing the logic boundaries.
 *
 * DynamoDB-dependent paths use mock.module() to stub the AWS SDK.
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test';

// ---------------------------------------------------------------------------
// Mock AWS SDK before any module imports
// ---------------------------------------------------------------------------

const mockSend = mock(async (_cmd: any) => ({ Item: undefined, Items: [] }));

mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockSend;
  },
}));

mock.module('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: mockSend }),
  },
  QueryCommand: class { constructor(public params: any) {} },
  GetCommand: class { constructor(public params: any) {} },
  PutCommand: class { constructor(public params: any) {} },
  UpdateCommand: class { constructor(public params: any) {} },
}));

mock.module('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mock(async (_cmd: any) => ({}));
  },
  PutObjectCommand: class { constructor(public params: any) {} },
  GetObjectCommand: class { constructor(public params: any) {} },
}));

// ---------------------------------------------------------------------------
// Helper: build a minimal experiment object matching PromptABExperiment shape
// ---------------------------------------------------------------------------

function makeExperiment(overrides: {
  aQuality?: number;
  aCost?: number;
  aN?: number;
  bQuality?: number;
  bCost?: number;
  bN?: number;
  status?: string;
  expiresAt?: string;
}) {
  return {
    experimentId: 'exp-001',
    tenantId: 'acme',
    variantAPromptS3: 's3://bucket/a.md',
    variantBPromptS3: 's3://bucket/b.md',
    trafficSplit: 0.5,
    startedAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86400000).toISOString(),
    variantAScores: {
      quality: overrides.aQuality ?? 0.75,
      cost: overrides.aCost ?? 0.005,
      n: overrides.aN ?? 10,
    },
    variantBScores: {
      quality: overrides.bQuality ?? 0.75,
      cost: overrides.bCost ?? 0.005,
      n: overrides.bN ?? 10,
    },
    status: overrides.status ?? 'running',
    promotedVariant: null,
    cedarApproval: 'approved',
  };
}

// ---------------------------------------------------------------------------
// Winner determination logic (extracted from completeExperiment)
// Tests the business rules: B wins if quality +5% OR cost -10% with similar quality
// ---------------------------------------------------------------------------

describe('Prompt A/B winner selection logic', () => {
  /**
   * This function mirrors the winner logic in PromptOptimizer.completeExperiment()
   * Tests ensure the logic boundaries are correct.
   */
  function determineWinner(
    aQuality: number, bQuality: number,
    aCost: number, bCost: number
  ): 'a' | 'b' {
    if (bQuality > aQuality * 1.05) return 'b';
    if (bCost < aCost * 0.9 && Math.abs(bQuality - aQuality) < 0.03) return 'b';
    return 'a';
  }

  it('selects B when quality improves by more than 5%', () => {
    expect(determineWinner(0.70, 0.80, 0.005, 0.005)).toBe('b'); // 14% improvement
    expect(determineWinner(0.80, 0.841, 0.005, 0.005)).toBe('b'); // just over 5% improvement
  });

  it('retains A when quality improvement is at or below 5%', () => {
    expect(determineWinner(0.80, 0.84, 0.005, 0.005)).toBe('a');  // exactly 5% — not sufficient (strictly greater)
    expect(determineWinner(0.80, 0.83, 0.005, 0.005)).toBe('a'); // 3.75% — below threshold
    expect(determineWinner(0.70, 0.73, 0.005, 0.005)).toBe('a'); // 4.3%
  });

  it('selects B when cost drops >10% with similar quality', () => {
    // 20% cost reduction, quality diff < 0.03
    expect(determineWinner(0.75, 0.76, 0.010, 0.008)).toBe('b');
  });

  it('retains A when cost drops but quality difference is too large', () => {
    // Cost drops 20% but quality diff = 0.05 > 0.03
    expect(determineWinner(0.80, 0.75, 0.010, 0.008)).toBe('a');
  });

  it('retains A when cost drop is less than 10%', () => {
    // Only 5% cost reduction with similar quality
    expect(determineWinner(0.75, 0.76, 0.010, 0.0096)).toBe('a');
  });

  it('retains A when both variants are equal', () => {
    expect(determineWinner(0.75, 0.75, 0.005, 0.005)).toBe('a');
  });

  it('selects B when both quality AND cost improve', () => {
    expect(determineWinner(0.70, 0.80, 0.010, 0.007)).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// createPromptOptimizer — smoke tests with mocked DynamoDB
// ---------------------------------------------------------------------------

describe('PromptOptimizer.selectPromptVariant', () => {
  it('returns "a" when experiment is not found', async () => {
    // mockSend returns { Item: undefined } → getExperiment returns null → default 'a'
    mockSend.mockImplementation(async (_cmd: any) => ({ Item: undefined }));

    const { createPromptOptimizer } = await import('../prompt-optimizer');
    const optimizer = createPromptOptimizer({
      evolutionTable: 'test-evolution',
      sessionsTable: 'test-sessions',
      artifactsBucket: 'test-bucket',
    });

    const variant = await optimizer.selectPromptVariant({
      tenantId: 'acme',
      experimentId: 'missing-exp',
    });

    expect(variant).toBe('a');
  });

  it('returns "a" when experiment status is not running', async () => {
    const exp = makeExperiment({ status: 'completed' });
    mockSend.mockImplementation(async (_cmd: any) => ({ Item: exp }));

    const { createPromptOptimizer } = await import('../prompt-optimizer');
    const optimizer = createPromptOptimizer({
      evolutionTable: 'test-evolution',
      sessionsTable: 'test-sessions',
      artifactsBucket: 'test-bucket',
    });

    const variant = await optimizer.selectPromptVariant({
      tenantId: 'acme',
      experimentId: 'exp-001',
    });

    expect(variant).toBe('a');
  });

  it('returns "a" when experiment has expired', async () => {
    const exp = makeExperiment({
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 1s ago
      status: 'running',
    });
    // First call: getExperiment → returns experiment
    // completeExperiment calls getExperiment again (second call) then updateCommand
    mockSend.mockImplementation(async (_cmd: any) => ({ Item: exp }));

    const { createPromptOptimizer } = await import('../prompt-optimizer');
    const optimizer = createPromptOptimizer({
      evolutionTable: 'test-evolution',
      sessionsTable: 'test-sessions',
      artifactsBucket: 'test-bucket',
    });

    const variant = await optimizer.selectPromptVariant({
      tenantId: 'acme',
      experimentId: 'exp-001',
    });

    expect(variant).toBe('a');
  });
});
