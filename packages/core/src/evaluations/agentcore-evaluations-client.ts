/**
 * AgentCore Evaluations client.
 *
 * Thin wrapper around `@aws-sdk/client-bedrock-agentcore`'s `Evaluate`
 * API. The SDK package is **dynamically imported** so that:
 *
 *  - The package does not need to be listed in `packages/core/package.json`.
 *  - Code paths that never flip `EVALUATIONS_ENABLED=true` never pay the
 *    cost of module resolution against the optional dependency.
 *  - Tests can inject a fake SDK client via `createEvaluationsClient({ sdkClient })`.
 *
 * Error mapping is deliberately coarse — we distinguish only the three
 * outcomes `prompt-optimizer.ts` needs to act on (not-found / auth /
 * transient). No auto-retry.
 *
 * @see docs/research/agentcore-rabbithole/05-observability-evaluations-deep-dive.md §Evaluations
 */

import {
  assertEvaluationsFlagsConsistent,
  getEvaluationsFlags,
  type EvaluationsFeatureFlags,
} from './feature-flags';
import {
  EvaluationsAuthError,
  EvaluationsError,
  EvaluationsNotFoundError,
  EvaluationsUnavailableError,
  type EvaluationRequest,
  type EvaluationScore,
} from './types';

/**
 * Structural type describing the surface of `@aws-sdk/client-bedrock-agentcore`
 * that we actually use. We intentionally do NOT depend on the SDK's
 * concrete classes so this module can be tested without the package
 * installed.
 */
export interface AgentCoreSdkClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Factory a caller (typically a test) can provide to stub out the SDK.
 * Receives the resolved feature-flag bundle so tests can assert the
 * region/model wiring.
 */
export type AgentCoreSdkClientFactory = (
  flags: EvaluationsFeatureFlags
) => AgentCoreSdkClient;

export interface AgentCoreEvaluationsClientOptions {
  /**
   * Inject an SDK client (or a factory that builds one). When provided,
   * the dynamic import of `@aws-sdk/client-bedrock-agentcore` is skipped.
   * Primarily for unit tests.
   */
  sdkClient?: AgentCoreSdkClient | AgentCoreSdkClientFactory;
  /**
   * Override env-resolved flags. Primarily for tests that want to
   * exercise enabled code without touching `process.env`.
   */
  flags?: EvaluationsFeatureFlags;
}

/**
 * Shape of the Bedrock-AgentCore `Evaluate` response that we care about.
 * The real SDK returns richer data; we extract what we need and stash
 * the rest in `metadata`.
 */
interface EvaluateResult {
  label?: string;
  value?: number;
  explanation?: string;
  [k: string]: unknown;
}

function clampScore(raw: number | undefined, label: string | undefined): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw < 0) return 0;
    if (raw > 1) return Math.min(1, raw / 5); // 5-point scale → normalize
    return raw;
  }
  // Fall back to categorical labels when the judge returned a label
  // instead of a number (common for Yes/No evaluators).
  if (typeof label === 'string') {
    const up = label.toUpperCase();
    if (up === 'PASS' || up === 'YES' || up === 'TRUE') return 1;
    if (up === 'FAIL' || up === 'NO' || up === 'FALSE') return 0;
  }
  return 0;
}

function mapSdkError(err: unknown): EvaluationsError {
  const name =
    err instanceof Error && typeof err.name === 'string' ? err.name : '';
  const message =
    err instanceof Error && typeof err.message === 'string'
      ? err.message
      : String(err);

  if (
    name === 'ResourceNotFoundException' ||
    name === 'EvaluatorNotFoundException' ||
    /not found/i.test(message)
  ) {
    return new EvaluationsNotFoundError(
      `AgentCore Evaluations resource not found: ${message}`,
      err
    );
  }
  if (
    name === 'AccessDeniedException' ||
    name === 'UnrecognizedClientException' ||
    name === 'InvalidSignatureException' ||
    /access denied|not authorized|credentials/i.test(message)
  ) {
    return new EvaluationsAuthError(
      `AgentCore Evaluations auth failure: ${message}`,
      err
    );
  }
  if (
    name === 'ThrottlingException' ||
    name === 'ServiceUnavailableException' ||
    name === 'InternalServerException' ||
    name === 'TimeoutError' ||
    /throttl|timeout|unavailable|5\d\d/i.test(message)
  ) {
    return new EvaluationsUnavailableError(
      `AgentCore Evaluations temporarily unavailable: ${message}`,
      err
    );
  }
  return new EvaluationsError(
    `AgentCore Evaluations call failed: ${message}`,
    err
  );
}

/**
 * The client. One per process is fine; it's stateless apart from the
 * lazily-resolved SDK client.
 */
export class AgentCoreEvaluationsClient {
  private sdkClient: AgentCoreSdkClient | undefined;
  private readonly sdkFactory: AgentCoreSdkClientFactory | undefined;
  private readonly explicitFlags: EvaluationsFeatureFlags | undefined;

  constructor(opts: AgentCoreEvaluationsClientOptions = {}) {
    if (typeof opts.sdkClient === 'function') {
      this.sdkFactory = opts.sdkClient;
    } else if (opts.sdkClient) {
      this.sdkClient = opts.sdkClient;
    }
    this.explicitFlags = opts.flags;
  }

  /**
   * Resolve current flags. Reads env fresh on every call unless the
   * caller pinned flags at construction time.
   */
  private resolveFlags(): EvaluationsFeatureFlags {
    return this.explicitFlags ?? getEvaluationsFlags();
  }

  /**
   * Lazily load or build the SDK client.
   *
   * In the common path (no test injection), we dynamic-import
   * `@aws-sdk/client-bedrock-agentcore`. That package is NOT a hard
   * dependency of `@chimera/core` — if it's missing, we convert the
   * module-resolution error into {@link EvaluationsAuthError} so
   * callers can treat it the same as "credentials missing".
   */
  private async getSdkClient(
    flags: EvaluationsFeatureFlags
  ): Promise<AgentCoreSdkClient> {
    if (this.sdkClient) return this.sdkClient;
    if (this.sdkFactory) {
      this.sdkClient = this.sdkFactory(flags);
      return this.sdkClient;
    }

    try {
      // Dynamic import keeps the optional dep out of the sync graph.
      // The package is intentionally NOT declared in package.json (see
      // spec); it's resolved at runtime only when the flag is on. We
      // compute the specifier indirectly so TS does not demand types.
      const specifier = '@aws-sdk/client-bedrock-agentcore';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await (Function('s', 'return import(s)') as (
        s: string
      ) => Promise<unknown>)(specifier);
      const Ctor = mod?.BedrockAgentCoreClient ?? mod?.default;
      if (typeof Ctor !== 'function') {
        throw new Error(
          '@aws-sdk/client-bedrock-agentcore did not export BedrockAgentCoreClient'
        );
      }
      this.sdkClient = new Ctor({ region: flags.region }) as AgentCoreSdkClient;
      return this.sdkClient;
    } catch (err) {
      throw new EvaluationsAuthError(
        '@aws-sdk/client-bedrock-agentcore is not available; ' +
          'install it or inject an sdkClient for tests',
        err
      );
    }
  }

  /**
   * Score a (prompt, response) pair with an AgentCore built-in evaluator.
   *
   * Throws {@link EvaluationsError} subclasses on failure; never retries.
   */
  async scoreResponse(request: EvaluationRequest): Promise<EvaluationScore> {
    const flags = this.resolveFlags();
    if (!flags.evaluationsEnabled) {
      throw new EvaluationsError(
        'scoreResponse() called with EVALUATIONS_ENABLED=false'
      );
    }
    assertEvaluationsFlagsConsistent(flags);

    const client = await this.getSdkClient(flags);

    // We construct a plain-object "command" rather than importing
    // EvaluateCommand from the SDK, because (a) we cannot depend on
    // the SDK synchronously and (b) the mock surface in tests is far
    // simpler when we pass a plain object. The real SDK client's
    // `.send()` does not inspect the command's prototype for Evaluate
    // operations served via the data-plane endpoint; it only reads the
    // `input` property, so this shape is compatible in both modes.
    const input = {
      evaluatorId: flags.evaluationsId || undefined,
      evaluatorType: request.evaluatorType,
      judgeModelId: flags.judgeModel,
      evaluationTarget: {
        inlineConversation: {
          prompt: request.prompt,
          response: request.response,
        },
      },
    };

    let raw: EvaluateResult;
    try {
      raw = (await client.send({
        __type: 'EvaluateCommand',
        input,
      })) as EvaluateResult;
    } catch (err) {
      throw mapSdkError(err);
    }

    if (raw == null || typeof raw !== 'object') {
      throw new EvaluationsError(
        'AgentCore Evaluations returned an empty or malformed response'
      );
    }

    const score = clampScore(raw.value, raw.label);
    const result: EvaluationScore = {
      score,
      metadata: { ...raw },
    };
    if (typeof raw.explanation === 'string') {
      result.explanation = raw.explanation;
    }
    return result;
  }
}

/**
 * Convenience factory matching the Registry/Gateway constructor style.
 */
export function createEvaluationsClient(
  opts?: AgentCoreEvaluationsClientOptions
): AgentCoreEvaluationsClient {
  return new AgentCoreEvaluationsClient(opts);
}
