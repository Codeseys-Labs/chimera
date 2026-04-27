/**
 * Tests for packages/cli/src/commands/tail-pipeline.ts
 *
 * Exercises the pure helpers (stage → log-group mapping, active-stage
 * filtering, execution-status rollup) and the commander surface
 * (option parsing, help text). The AWS SDK I/O is not exercised here —
 * that belongs in an integration test.
 */

import { describe, it, expect } from 'bun:test';
import { Command } from 'commander';
import {
  registerTailPipelineCommand,
  __testing,
} from '../../commands/tail-pipeline';

const { logGroupForStage, computeExecutionStatus, activeStageNames } = __testing;

describe('logGroupForStage', () => {
  it('maps known stages to deterministic log groups', () => {
    expect(logGroupForStage('Build_Package', 'dev')).toBe('/aws/codebuild/chimera-build-dev');
    expect(logGroupForStage('Docker_Build', 'dev')).toBe('/aws/codebuild/chimera-docker-build-dev');
    expect(logGroupForStage('Cdk_Deploy', 'prod')).toBe('/aws/codebuild/chimera-deploy-prod');
    expect(logGroupForStage('Test', 'dev')).toBe('/aws/codebuild/chimera-test-dev');
    expect(logGroupForStage('Canary', 'stg')).toBe('/aws/states/chimera-canary-orchestration-stg');
  });

  it('returns undefined for unknown stages (e.g. Source, Approval)', () => {
    expect(logGroupForStage('Source', 'dev')).toBeUndefined();
    expect(logGroupForStage('Approval', 'dev')).toBeUndefined();
    expect(logGroupForStage('', 'dev')).toBeUndefined();
  });
});

describe('activeStageNames', () => {
  const execId = 'exec-1';

  it('returns only InProgress stages whose execution matches', () => {
    const stageStates = [
      { stageName: 'Build_Package', latestExecution: { pipelineExecutionId: execId, status: 'InProgress' } },
      { stageName: 'Docker_Build', latestExecution: { pipelineExecutionId: execId, status: 'Succeeded' } },
      { stageName: 'Cdk_Deploy', latestExecution: { pipelineExecutionId: execId, status: 'InProgress' } },
    ];
    expect(activeStageNames(stageStates as any, execId)).toEqual(['Build_Package', 'Cdk_Deploy']);
  });

  it('ignores stages that belong to a prior execution', () => {
    const stageStates = [
      { stageName: 'Build_Package', latestExecution: { pipelineExecutionId: 'other', status: 'InProgress' } },
      { stageName: 'Docker_Build', latestExecution: { pipelineExecutionId: execId, status: 'InProgress' } },
    ];
    expect(activeStageNames(stageStates as any, execId)).toEqual(['Docker_Build']);
  });

  it('returns empty when no stage has started', () => {
    expect(activeStageNames([] as any, execId)).toEqual([]);
  });
});

describe('computeExecutionStatus', () => {
  const execId = 'exec-1';

  it('returns InProgress if any matching stage is in progress', () => {
    const stageStates = [
      { latestExecution: { pipelineExecutionId: execId, status: 'Succeeded' } },
      { latestExecution: { pipelineExecutionId: execId, status: 'InProgress' } },
    ];
    expect(computeExecutionStatus(stageStates as any, execId)).toBe('InProgress');
  });

  it('returns Failed when any matching stage failed (no InProgress)', () => {
    const stageStates = [
      { latestExecution: { pipelineExecutionId: execId, status: 'Succeeded' } },
      { latestExecution: { pipelineExecutionId: execId, status: 'Failed' } },
    ];
    expect(computeExecutionStatus(stageStates as any, execId)).toBe('Failed');
  });

  it('returns Succeeded only when all matching stages succeeded', () => {
    const stageStates = [
      { latestExecution: { pipelineExecutionId: execId, status: 'Succeeded' } },
      { latestExecution: { pipelineExecutionId: execId, status: 'Succeeded' } },
    ];
    expect(computeExecutionStatus(stageStates as any, execId)).toBe('Succeeded');
  });

  it('returns Unknown when no stage belongs to the execution', () => {
    const stageStates = [
      { latestExecution: { pipelineExecutionId: 'other', status: 'Succeeded' } },
    ];
    expect(computeExecutionStatus(stageStates as any, execId)).toBe('Unknown');
  });
});

describe('registerTailPipelineCommand', () => {
  function buildProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerTailPipelineCommand(program);
    return program;
  }

  it('registers a tail-pipeline subcommand', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'tail-pipeline');
    expect(cmd).toBeDefined();
    expect(cmd!.description()).toMatch(/Multiplex-tail/);
  });

  it('exposes the expected options', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'tail-pipeline')!;
    const optNames = cmd.options.map((o) => o.long);
    expect(optNames).toEqual(
      expect.arrayContaining(['--region', '--env', '--pipeline', '--execution', '--interval', '--json']),
    );
  });

  it('parses --execution and --interval without invoking the action', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'tail-pipeline')!;
    // Replace action with a capturing stub so we can observe parsed options
    // without touching the AWS SDK.
    let captured: any;
    (cmd as any)._actionHandler = null;
    cmd.action((options) => {
      captured = options;
    });
    program.parse(
      ['node', 'chimera', 'tail-pipeline', '--execution', 'abc-123', '--interval', '7', '--env', 'prod'],
    );
    expect(captured.execution).toBe('abc-123');
    expect(captured.interval).toBe('7');
    expect(captured.env).toBe('prod');
  });

  it('defaults --interval to "5"', () => {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'tail-pipeline')!;
    let captured: any;
    (cmd as any)._actionHandler = null;
    cmd.action((options) => {
      captured = options;
    });
    program.parse(['node', 'chimera', 'tail-pipeline']);
    expect(captured.interval).toBe('5');
  });
});
