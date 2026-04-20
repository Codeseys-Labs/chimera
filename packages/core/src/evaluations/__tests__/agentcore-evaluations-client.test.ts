/**
 * Unit tests for AgentCoreEvaluationsClient.
 *
 * Uses an injected fake SDK client so the tests never require
 * `@aws-sdk/client-bedrock-agentcore` to be installed.
 *
 * Covers:
 * - Flag-off guard: calling scoreResponse throws.
 * - Happy-path score normalization (numeric + categorical).
 * - Error mapping: NotFound / Auth / Unavailable / generic.
 * - Missing SDK package → EvaluationsAuthError (via dynamic import path).
 */

import { describe, it, expect } from 'bun:test';
import {
  AgentCoreEvaluationsClient,
  createEvaluationsClient,
} from '../agentcore-evaluations-client';
import {
  EvaluationsAuthError,
  EvaluationsError,
  EvaluationsNotFoundError,
  EvaluationsUnavailableError,
} from '../types';

const ENABLED_FLAGS = {
  evaluationsEnabled: true,
  judgeModel: 'us.anthropic.claude-sonnet-4-6-v1:0',
  evaluationsId: 'evaluator-abc',
  region: 'us-east-1',
};

function makeFakeClient(
  response: unknown | ((input: unknown) => unknown)
): { client: { send: (cmd: unknown) => Promise<unknown> }; calls: unknown[] } {
  const calls: unknown[] = [];
  const client = {
    async send(cmd: unknown) {
      calls.push(cmd);
      if (typeof response === 'function') {
        const fn = response as (i: unknown) => unknown;
        const r = fn((cmd as { input?: unknown })?.input);
        if (r instanceof Error) throw r;
        return r;
      }
      if (response instanceof Error) throw response;
      return response;
    },
  };
  return { client, calls };
}

describe('AgentCoreEvaluationsClient flag guard', () => {
  it('throws when EVALUATIONS_ENABLED=false even with injected client', async () => {
    const { client } = makeFakeClient({ value: 0.9 });
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: { ...ENABLED_FLAGS, evaluationsEnabled: false },
    });
    await expect(
      evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      })
    ).rejects.toThrow(EvaluationsError);
  });
});

describe('AgentCoreEvaluationsClient happy path', () => {
  it('normalizes a numeric value in [0,1] into score', async () => {
    const { client, calls } = makeFakeClient({
      value: 0.87,
      explanation: 'Correct answer, well-cited.',
    });
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    const result = await evaluations.scoreResponse({
      prompt: 'What is 2+2?',
      response: '4',
      evaluatorType: 'Correctness',
    });
    expect(result.score).toBe(0.87);
    expect(result.explanation).toBe('Correct answer, well-cited.');
    expect(result.metadata).toBeDefined();
    // Assert the SDK received the judge model + evaluator inputs.
    expect(calls.length).toBe(1);
    const input = (calls[0] as { input: Record<string, unknown> }).input;
    expect(input.judgeModelId).toBe(ENABLED_FLAGS.judgeModel);
    expect(input.evaluatorType).toBe('Correctness');
    expect(input.evaluatorId).toBe(ENABLED_FLAGS.evaluationsId);
  });

  it('normalizes a PASS label into 1 when value is absent', async () => {
    const { client } = makeFakeClient({ label: 'PASS' });
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    const result = await evaluations.scoreResponse({
      prompt: 'p',
      response: 'r',
      evaluatorType: 'Correctness',
    });
    expect(result.score).toBe(1);
  });

  it('normalizes a FAIL label into 0', async () => {
    const { client } = makeFakeClient({ label: 'FAIL' });
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    const result = await evaluations.scoreResponse({
      prompt: 'p',
      response: 'r',
      evaluatorType: 'Correctness',
    });
    expect(result.score).toBe(0);
  });

  it('clamps 5-point-scale values into [0,1]', async () => {
    const { client } = makeFakeClient({ value: 4 }); // 5-point → 0.8
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    const result = await evaluations.scoreResponse({
      prompt: 'p',
      response: 'r',
      evaluatorType: 'Correctness',
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('accepts a factory function for sdkClient', async () => {
    let factoryCalls = 0;
    const evaluations = createEvaluationsClient({
      sdkClient: () => {
        factoryCalls += 1;
        return {
          async send() {
            return { value: 0.5 };
          },
        };
      },
      flags: ENABLED_FLAGS,
    });
    const r1 = await evaluations.scoreResponse({
      prompt: 'p',
      response: 'r',
      evaluatorType: 'Correctness',
    });
    const r2 = await evaluations.scoreResponse({
      prompt: 'p',
      response: 'r',
      evaluatorType: 'Correctness',
    });
    expect(r1.score).toBe(0.5);
    expect(r2.score).toBe(0.5);
    // Factory is called once; the client is cached.
    expect(factoryCalls).toBe(1);
  });
});

describe('AgentCoreEvaluationsClient error mapping', () => {
  function mkErr(name: string, message: string): Error {
    const e = new Error(message);
    e.name = name;
    return e;
  }

  it('maps ResourceNotFoundException to EvaluationsNotFoundError', async () => {
    const { client } = makeFakeClient(
      mkErr('ResourceNotFoundException', 'evaluator XYZ does not exist')
    );
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    await expect(
      evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      })
    ).rejects.toBeInstanceOf(EvaluationsNotFoundError);
  });

  it('maps AccessDeniedException to EvaluationsAuthError', async () => {
    const { client } = makeFakeClient(
      mkErr('AccessDeniedException', 'not authorized to perform Evaluate')
    );
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    await expect(
      evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      })
    ).rejects.toBeInstanceOf(EvaluationsAuthError);
  });

  it('maps ThrottlingException to EvaluationsUnavailableError', async () => {
    const { client } = makeFakeClient(
      mkErr('ThrottlingException', 'rate exceeded')
    );
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    await expect(
      evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      })
    ).rejects.toBeInstanceOf(EvaluationsUnavailableError);
  });

  it('maps unknown errors to base EvaluationsError', async () => {
    const { client } = makeFakeClient(mkErr('SomethingElse', 'boom'));
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    let caught: unknown;
    try {
      await evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EvaluationsError);
    expect(caught).not.toBeInstanceOf(EvaluationsAuthError);
    expect(caught).not.toBeInstanceOf(EvaluationsNotFoundError);
    expect(caught).not.toBeInstanceOf(EvaluationsUnavailableError);
  });

  it('throws EvaluationsError on a malformed empty response', async () => {
    const { client } = makeFakeClient(null);
    const evaluations = new AgentCoreEvaluationsClient({
      sdkClient: client,
      flags: ENABLED_FLAGS,
    });
    await expect(
      evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      })
    ).rejects.toBeInstanceOf(EvaluationsError);
  });

  it('surfaces a missing SDK package as EvaluationsAuthError', async () => {
    // No sdkClient injected → dynamic import of
    // @aws-sdk/client-bedrock-agentcore is attempted. The package is
    // not installed in this repo, so the import fails. The client
    // converts that into EvaluationsAuthError so callers can treat it
    // identically to "credentials missing".
    const evaluations = new AgentCoreEvaluationsClient({
      flags: ENABLED_FLAGS,
    });
    await expect(
      evaluations.scoreResponse({
        prompt: 'p',
        response: 'r',
        evaluatorType: 'Correctness',
      })
    ).rejects.toBeInstanceOf(EvaluationsAuthError);
  });
});
