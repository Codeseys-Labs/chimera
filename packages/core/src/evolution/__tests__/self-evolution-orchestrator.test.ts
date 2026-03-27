/**
 * Unit tests for SelfEvolutionOrchestrator
 *
 * All AWS SDK calls are stubbed via bun:test mock.module().
 * The orchestrator is tested through its public interface only:
 * - evolve() status outcomes (authorized, denied, validation_failed, etc.)
 * - validateCDKCode() static analysis
 * - waitForPipeline() polling logic
 */

import { describe, it, expect, mock, beforeAll } from 'bun:test';

// ---------------------------------------------------------------------------
// Stub AWS SDK BEFORE importing any module that loads the SDK
// ---------------------------------------------------------------------------

const mockDdbSend = mock(async (_cmd: any) => ({}));

mock.module('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class {
    send = mockDdbSend;
  },
}));

mock.module('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: (_client: any) => ({ send: mockDdbSend }),
  },
  PutCommand: class { constructor(public params: any) {} },
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  SelfEvolutionOrchestrator,
  createSelfEvolutionOrchestrator,
  type EvolutionRequest,
  type SelfEvolutionConfig,
} from '../self-evolution-orchestrator';
import type { CDKGenerator } from '../../infra-builder/cdk-generator';
import type { CodeCommitWorkspaceManager } from '../../infra-builder/codecommit-workspace';
import type { CodePipelineDeployer } from '../../infra-builder/codepipeline-deployer';
import type { EvolutionSafetyHarness } from '../safety-harness';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeSafetyHarness(decision: 'ALLOW' | 'DENY' = 'ALLOW') {
  return {
    authorize: mock(async () => ({ decision })),
    incrementRateLimitCounters: mock(async () => {}),
  } as unknown as EvolutionSafetyHarness;
}

function makeCDKGenerator(cdkCode = '// valid CDK code\nconst x = 1;') {
  return {
    generateCDKCode: mock(async (_req: any) => ({
      cdkCode,
      language: 'typescript',
      estimatedCostDelta: 10,
      generationMethod: 'template',
      resourcesAffected: ['EcsService'],
      warnings: [],
    })),
  } as unknown as CDKGenerator;
}

function makeCodeCommit(success = true, commitId = 'abc123') {
  return {
    commitFiles: mock(async () =>
      success
        ? { success: true, data: { commitId } }
        : { success: false, error: { message: 'CodeCommit error' } }
    ),
  } as unknown as CodeCommitWorkspaceManager;
}

function makePipeline(executionId = 'exec-001') {
  return {
    startExecution: mock(async () => ({ success: true, data: { executionId } })),
    getExecution: mock(async () => ({
      success: true,
      data: { status: 'Succeeded', executionId },
    })),
  } as unknown as CodePipelineDeployer;
}

const baseConfig: SelfEvolutionConfig = {
  evolutionStateTable: 'test-evolution-table',
  humanApprovalCostThreshold: 50,
};

function makeDdbDoc() {
  return { send: mock(async (_cmd: any) => ({})) } as any;
}

function makeRequest(overrides: Partial<EvolutionRequest> = {}): EvolutionRequest {
  return {
    tenantId: 'tenant-01',
    agentId: 'agent-01',
    description: 'Add S3 bucket for media uploads',
    changeType: 'add_tool',
    parameters: { toolName: 'media-upload' },
    repositoryName: 'chimera-iac',
    pipelineName: 'chimera-deploy',
    ...overrides,
  };
}

function makeOrchestrator(opts: {
  decision?: 'ALLOW' | 'DENY';
  cdkCode?: string;
  commitSuccess?: boolean;
  pipelineExecutionId?: string;
} = {}) {
  const harness = makeSafetyHarness(opts.decision ?? 'ALLOW');
  const generator = makeCDKGenerator(opts.cdkCode);
  const codeCommit = makeCodeCommit(opts.commitSuccess ?? true);
  const pipeline = makePipeline(opts.pipelineExecutionId ?? 'exec-001');
  const ddb = makeDdbDoc();

  const orch = new SelfEvolutionOrchestrator(
    generator,
    codeCommit,
    pipeline,
    harness,
    baseConfig,
    ddb
  );

  return { orch, harness, generator, codeCommit, pipeline, ddb };
}

// ---------------------------------------------------------------------------
// Tests: evolve() — happy path
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.evolve — happy path', () => {
  it('returns pipeline_started with executionId and commitId', async () => {
    const { orch } = makeOrchestrator();
    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('pipeline_started');
    expect(result.executionId).toBe('exec-001');
    expect(result.commitId).toBe('abc123');
    expect(result.rollbackAvailable).toBe(true);
    expect(result.auditEventId).toBeTruthy();
  });

  it('calls authorize with correct parameters', async () => {
    const { orch, harness } = makeOrchestrator();
    await orch.evolve(makeRequest({ tenantId: 'tenant-02', agentId: 'agent-02' }));

    const callArgs = (harness.authorize as any).mock.calls[0][0];
    expect(callArgs.tenantId).toBe('tenant-02');
    expect(callArgs.agentId).toBe('agent-02');
    expect(callArgs.eventType).toBe('evolution_infra');
    expect(callArgs.changeType).toBe('add_tool');
  });

  it('increments rate limit counters after success', async () => {
    const { orch, harness } = makeOrchestrator();
    await orch.evolve(makeRequest());

    expect((harness.incrementRateLimitCounters as any).mock.calls).toHaveLength(1);
    const [tenantId, eventType] = (harness.incrementRateLimitCounters as any).mock.calls[0];
    expect(tenantId).toBe('tenant-01');
    expect(eventType).toBe('evolution_infra');
  });

  it('writes at least one audit event (success)', async () => {
    const { orch, ddb } = makeOrchestrator();
    await orch.evolve(makeRequest());

    // Two DDB writes: capability registration + audit event
    expect(ddb.send.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('passes human_approved flag to authorize', async () => {
    const { orch, harness } = makeOrchestrator();
    await orch.evolve(makeRequest({ humanApproved: true }));

    const callArgs = (harness.authorize as any).mock.calls[0][0];
    expect(callArgs.humanApproved).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: evolve() — Cedar denial
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.evolve — Cedar denial', () => {
  it('returns denied when Cedar returns DENY', async () => {
    const { orch } = makeOrchestrator({ decision: 'DENY' });
    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('denied');
    expect(result.rollbackAvailable).toBe(false);
  });

  it('does not generate CDK code when denied', async () => {
    const { orch, generator } = makeOrchestrator({ decision: 'DENY' });
    await orch.evolve(makeRequest());

    expect((generator.generateCDKCode as any).mock.calls).toHaveLength(0);
  });

  it('does not commit to CodeCommit when denied', async () => {
    const { orch, codeCommit } = makeOrchestrator({ decision: 'DENY' });
    await orch.evolve(makeRequest());

    expect((codeCommit.commitFiles as any).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: evolve() — CDK validation failures
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.evolve — validation_failed', () => {
  it('blocks RemovalPolicy.DESTROY', async () => {
    const { orch } = makeOrchestrator({ cdkCode: 'table.applyRemovalPolicy(RemovalPolicy.DESTROY)' });
    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('validation_failed');
    expect(result.reason).toContain('DESTROY');
  });

  it('blocks IAM policy mutations (addToPolicy)', async () => {
    const { orch } = makeOrchestrator({ cdkCode: 'role.addToPolicy(new PolicyStatement(...))' });
    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('validation_failed');
    expect(result.reason).toContain('IAM');
  });

  it('blocks VPC modifications', async () => {
    const { orch } = makeOrchestrator({ cdkCode: 'new ec2.Vpc(stack, "NewVpc")' });
    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('validation_failed');
    expect(result.reason).toContain('VPC');
  });

  it('does not commit when validation fails', async () => {
    const { orch, codeCommit } = makeOrchestrator({
      cdkCode: 'new ec2.SecurityGroup(stack, "SG", { vpc })',
    });
    await orch.evolve(makeRequest());

    expect((codeCommit.commitFiles as any).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: evolve() — commit failure
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.evolve — commit_failed', () => {
  it('returns commit_failed when CodeCommit write fails', async () => {
    const { orch } = makeOrchestrator({ commitSuccess: false });
    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('commit_failed');
    expect(result.reason).toContain('CodeCommit');
    expect(result.rollbackAvailable).toBe(false);
  });

  it('does not trigger pipeline after commit failure', async () => {
    const { orch, pipeline } = makeOrchestrator({ commitSuccess: false });
    await orch.evolve(makeRequest());

    expect((pipeline.startExecution as any).mock.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: evolve() — pipeline trigger failure
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.evolve — pipeline trigger failure', () => {
  it('returns error with rollbackAvailable=true when pipeline start fails', async () => {
    const harness = makeSafetyHarness('ALLOW');
    const generator = makeCDKGenerator();
    const codeCommit = makeCodeCommit(true, 'commit-xyz');
    const pipeline = {
      startExecution: mock(async () => ({
        success: false,
        error: { message: 'Pipeline not found' },
      })),
      getExecution: mock(async () => ({ success: false, error: { message: 'not found' } })),
    } as unknown as CodePipelineDeployer;
    const ddb = makeDdbDoc();

    const orch = new SelfEvolutionOrchestrator(
      generator, codeCommit, pipeline, harness, baseConfig, ddb
    );

    const result = await orch.evolve(makeRequest());

    expect(result.status).toBe('error');
    expect(result.rollbackAvailable).toBe(true);
    expect(result.commitId).toBe('commit-xyz');
  });
});

// ---------------------------------------------------------------------------
// Tests: validateCDKCode()
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.validateCDKCode', () => {
  let orch: SelfEvolutionOrchestrator;

  beforeAll(() => {
    const { orch: o } = makeOrchestrator();
    orch = o;
  });

  it('accepts normal CDK code', () => {
    const code = `
import * as ecs from 'aws-cdk-lib/aws-ecs';
const service = new ecs.FargateService(stack, 'Svc', { taskDefinition });
`;
    expect(orch.validateCDKCode(code).valid).toBe(true);
  });

  it('rejects empty code', () => {
    const result = orch.validateCDKCode('');
    expect(result.valid).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('rejects whitespace-only code', () => {
    const result = orch.validateCDKCode('   \n\t  ');
    expect(result.valid).toBe(false);
  });

  it('rejects RemovalPolicy.DESTROY', () => {
    const result = orch.validateCDKCode('table.applyRemovalPolicy(RemovalPolicy.DESTROY)');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('DESTROY');
  });

  it('rejects grantAdmin', () => {
    const result = orch.validateCDKCode('bucket.grantAdmin(role)');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('IAM');
  });

  it('rejects ec2.Vpc', () => {
    const result = orch.validateCDKCode('new ec2.Vpc(stack, "V", {})');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('VPC');
  });

  it('rejects ec2.SecurityGroup', () => {
    const result = orch.validateCDKCode('new ec2.SecurityGroup(stack, "SG", { vpc })');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Security group');
  });

  it('rejects addIngressRule', () => {
    const result = orch.validateCDKCode('sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80))');
    expect(result.valid).toBe(false);
  });

  it('rejects code exceeding 64 KB', () => {
    const big = 'x'.repeat(64 * 1024 + 1);
    const result = orch.validateCDKCode(big);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('64 KB');
  });
});

// ---------------------------------------------------------------------------
// Tests: waitForPipeline()
// ---------------------------------------------------------------------------

describe('SelfEvolutionOrchestrator.waitForPipeline', () => {
  it('returns succeeded on first poll when pipeline already succeeded', async () => {
    const { orch } = makeOrchestrator({ pipelineExecutionId: 'exec-123' });
    const result = await orch.waitForPipeline('my-pipeline', 'exec-123', 0, 3);

    expect(result.succeeded).toBe(true);
    expect(result.status).toBe('Succeeded');
  });

  it('returns failure after max attempts when pipeline stays InProgress', async () => {
    const harness = makeSafetyHarness('ALLOW');
    const generator = makeCDKGenerator();
    const codeCommit = makeCodeCommit();
    const pipeline = {
      startExecution: mock(async () => ({ success: true, data: { executionId: 'e1' } })),
      getExecution: mock(async () => ({
        success: true,
        data: { status: 'InProgress', executionId: 'e1' },
      })),
    } as unknown as CodePipelineDeployer;
    const ddb = makeDdbDoc();

    const orch = new SelfEvolutionOrchestrator(
      generator, codeCommit, pipeline, harness, baseConfig, ddb
    );

    const result = await orch.waitForPipeline('pipe', 'e1', 0, 3);

    expect(result.succeeded).toBe(false);
    expect(result.status).toBe('Failed');
  });
});

// ---------------------------------------------------------------------------
// Tests: createSelfEvolutionOrchestrator factory
// ---------------------------------------------------------------------------

describe('createSelfEvolutionOrchestrator', () => {
  it('returns a SelfEvolutionOrchestrator instance', () => {
    const orch = createSelfEvolutionOrchestrator({
      cdkGenerator: makeCDKGenerator(),
      codeCommit: makeCodeCommit(),
      pipeline: makePipeline(),
      safetyHarness: makeSafetyHarness(),
      config: baseConfig,
    });

    expect(orch).toBeInstanceOf(SelfEvolutionOrchestrator);
  });
});
