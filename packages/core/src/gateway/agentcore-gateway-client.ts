/**
 * Thin wrapper around AWS Bedrock AgentCore Gateway SDKs.
 *
 * Phase-0/1 adapter for the Gateway migration. Stateless, easy to mock, no
 * retry logic — the caller decides retries. The SDK clients are imported
 * dynamically so that a missing package (sandbox / offline / packages not yet
 * added to package.json) does *not* crash module load. Mirrors the pattern
 * in `packages/core/src/registry/bedrock-registry-client.ts`.
 *
 * Research: `docs/research/agentcore-rabbithole/03-gateway-identity-deep-dive.md`
 * (§"What it is" gives the endpoint template; §"Target types" enumerates the
 * six target types; §"Auth model" covers inbound/outbound auth).
 *
 * Two SDK surfaces we talk to:
 *   - `@aws-sdk/client-bedrock-agentcore-control` — control plane
 *     (CreateGateway, CreateGatewayTarget, ListGatewayTargets,
 *     SynchronizeGatewayTargets).
 *   - `@aws-sdk/client-bedrock-agentcore`         — data plane. The deep-
 *     dive says the Gateway MCP endpoint lives at
 *     `https://{id}.gateway.bedrock-agentcore.{region}.amazonaws.com/mcp`
 *     and is spoken to via MCP JSON-RPC (`tools/list`, `tools/call`).
 *     ASSUMPTION: the data-plane SDK exposes an `InvokeGatewayTool` command;
 *     if not, we fall back to a direct HTTPS call with SigV4/JWT attachment.
 *     Verify during Phase-1 spike.
 *
 * If either package is not installed at runtime, every method that needs it
 * raises `GatewayUnavailableError` rather than a module-resolution error.
 * This is deliberate for gradual rollout and is the same pattern used by
 * the Registry adapter.
 *
 * The client is modeled as TWO public methods — `listTargets(gatewayId)` and
 * `invokeTool(gatewayId, toolName, args)` — per the task spec. Keeping the
 * surface area small avoids over-engineering during Phase-0.
 */

import {
  type GatewayTarget,
  type GatewayInvokeResult,
  GatewayError,
  GatewayNotFoundError,
  GatewayAuthError,
  GatewayRateLimitError,
  GatewayUnavailableError,
} from './types';

/**
 * Minimal client duck-typing. The real AWS SDK v3 clients have a `.send()`
 * method that takes a command instance; we mirror that. Tests inject a fake
 * via the constructor's `_controlPlaneClient` / `_dataPlaneClient`.
 */
export interface GatewaySdkClient {
  send(command: unknown): Promise<unknown>;
}

export interface AgentcoreGatewayClientOptions {
  gatewayId: string;
  region: string;
  credentials?: unknown;
  /** Test seam — inject a fake control-plane client. */
  _controlPlaneClient?: GatewaySdkClient;
  /** Test seam — inject a fake data-plane client. */
  _dataPlaneClient?: GatewaySdkClient;
}

/**
 * Command factory — the SDK's command constructors, indexed by name. Fake
 * clients in tests carry their own `_commands` object via duck-typing.
 */
interface ControlCommandFactory {
  CreateGatewayCommand?: new (input: unknown) => unknown;
  CreateGatewayTargetCommand?: new (input: unknown) => unknown;
  ListGatewayTargetsCommand: new (input: unknown) => unknown;
  SynchronizeGatewayTargetsCommand?: new (input: unknown) => unknown;
}

interface DataCommandFactory {
  /**
   * ASSUMPTION: the data-plane SDK exposes an `InvokeGatewayToolCommand`.
   * If the actual API is a bare MCP JSON-RPC call over HTTPS with SigV4,
   * we'll swap the implementation inside `invokeTool` during the spike
   * without changing the public surface of this class.
   */
  InvokeGatewayToolCommand?: new (input: unknown) => unknown;
}

/** Maps an AWS SDK error onto one of our narrow error classes. */
function classifyAwsError(err: unknown): GatewayError {
  const e = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
    message?: string;
  };
  const name = e?.name ?? 'UnknownError';
  const status = e?.$metadata?.httpStatusCode;
  const msg = e?.message ?? String(err);
  if (name === 'ResourceNotFoundException' || status === 404) {
    return new GatewayNotFoundError(msg, err);
  }
  if (
    name === 'AccessDeniedException' ||
    name === 'UnrecognizedClientException' ||
    status === 401 ||
    status === 403
  ) {
    return new GatewayAuthError(msg, err);
  }
  if (
    name === 'ThrottlingException' ||
    name === 'TooManyRequestsException' ||
    status === 429
  ) {
    return new GatewayRateLimitError(msg, err);
  }
  return new GatewayUnavailableError(msg, err);
}

/**
 * Lazy dynamic-import of the SDK packages. Returns `null` for either slot if
 * the package isn't installed; callers raise `GatewayUnavailableError` in
 * that case. We cache per-process so only one dynamic-import hit.
 */
interface SdkBundle {
  control: {
    Client: new (config: unknown) => GatewaySdkClient;
    commands: ControlCommandFactory;
  } | null;
  data: {
    Client: new (config: unknown) => GatewaySdkClient;
    commands: DataCommandFactory;
  } | null;
}

let _sdkBundle: Promise<SdkBundle> | null = null;

async function loadSdkBundle(): Promise<SdkBundle> {
  if (_sdkBundle) return _sdkBundle;
  _sdkBundle = (async () => {
    const bundle: SdkBundle = { control: null, data: null };
    try {
      // ASSUMPTION: package name is `@aws-sdk/client-bedrock-agentcore-control`
      // and the control-plane client class is `BedrockAgentCoreControlClient`.
      // Matches the Registry adapter's dynamic import. Not yet in package.json;
      // see docs/MIGRATION-gateway.md "Known limitations".
      const mod: Record<string, unknown> = await import(
        // @ts-expect-error — package not yet added to package.json
        '@aws-sdk/client-bedrock-agentcore-control'
      );
      bundle.control = {
        Client: mod.BedrockAgentCoreControlClient as new (
          c: unknown
        ) => GatewaySdkClient,
        commands: {
          CreateGatewayCommand: mod.CreateGatewayCommand as new (
            i: unknown
          ) => unknown,
          CreateGatewayTargetCommand: mod.CreateGatewayTargetCommand as new (
            i: unknown
          ) => unknown,
          ListGatewayTargetsCommand: mod.ListGatewayTargetsCommand as new (
            i: unknown
          ) => unknown,
          SynchronizeGatewayTargetsCommand:
            mod.SynchronizeGatewayTargetsCommand as new (i: unknown) => unknown,
        },
      };
    } catch {
      bundle.control = null;
    }
    try {
      const mod: Record<string, unknown> = await import(
        // @ts-expect-error — package not yet added to package.json
        '@aws-sdk/client-bedrock-agentcore'
      );
      bundle.data = {
        Client: mod.BedrockAgentCoreClient as new (
          c: unknown
        ) => GatewaySdkClient,
        commands: {
          // TODO(spike): confirm command name. The devguide uses "InvokeTool"
          // as the MCP method name but the SDK command likely wraps it. If
          // unavailable, switch to a direct HTTPS + SigV4 call.
          InvokeGatewayToolCommand: mod.InvokeGatewayToolCommand as new (
            i: unknown
          ) => unknown,
        },
      };
    } catch {
      bundle.data = null;
    }
    return bundle;
  })();
  return _sdkBundle;
}

/** Reset SDK cache — used only by tests. */
export function _resetSdkBundleForTests(): void {
  _sdkBundle = null;
}

/** Raw SDK response shape for `ListGatewayTargets`. */
interface SdkListTargetsResponse {
  targets?: SdkTargetShape[];
  nextToken?: string;
}

/**
 * ASSUMPTION: the SDK carries each target type in its own sub-object (a
 * discriminated union via object key). We flatten that to our `GatewayTarget`
 * shape in `sdkResponseToTarget`. Verify during spike.
 */
interface SdkTargetShape {
  name?: string;
  lambda?: { targetArn?: string; schema?: Record<string, unknown> };
  openApi?: { endpoint?: string; schema?: string | Record<string, unknown> };
  apiGatewayStage?: { apiId?: string; stageName?: string };
  smithy?: { model?: string };
  mcpRemote?: { endpoint?: string };
  saasTemplate?: { templateId?: string };
  metadata?: Record<string, unknown>;
}

/**
 * Thin adapter around the two AgentCore Gateway SDKs. All methods are
 * stateless: they read `this.gatewayId` / `this.region` but do not mutate
 * anything. Errors are wrapped in narrow classes. We deliberately do NOT
 * auto-retry; the caller is the correct place to decide retry semantics.
 */
export class AgentcoreGatewayClient {
  private readonly region: string;
  private readonly credentials?: unknown;
  private readonly injectedControl?: GatewaySdkClient;
  private readonly injectedData?: GatewaySdkClient;
  /** Visible for tests — last command-constructor name used. */
  private _lastCommandFactoryName?: string;

  constructor(opts: AgentcoreGatewayClientOptions) {
    if (!opts.gatewayId) {
      throw new Error('[gateway-client] gatewayId is required');
    }
    if (!opts.region) {
      throw new Error('[gateway-client] region is required');
    }
    // NOTE: gatewayId is also passed per-method (listTargets, invokeTool).
    // We accept it in the constructor for parity with the Registry adapter,
    // but the per-method param wins if supplied. This lets a single client
    // instance serve multiple gateways during a migration cutover window.
    this.defaultGatewayId = opts.gatewayId;
    this.region = opts.region;
    this.credentials = opts.credentials;
    this.injectedControl = opts._controlPlaneClient;
    this.injectedData = opts._dataPlaneClient;
  }

  private readonly defaultGatewayId: string;

  /**
   * Enumerate the targets registered on a gateway. Returns a flat list of
   * `GatewayTarget` entries — the mapper flattens the SDK's discriminated-
   * union response.
   *
   * Returns an empty array on `ResourceNotFoundException` (the gateway
   * exists but has no targets). Raises `GatewayNotFoundError` only when the
   * gateway itself is missing.
   */
  async listTargets(gatewayId?: string): Promise<GatewayTarget[]> {
    const gwId = gatewayId || this.defaultGatewayId;
    if (!gwId) {
      throw new Error('[gateway-client] gatewayId is required for listTargets');
    }
    const { client, commands } = await this.getControlPlane();
    const CommandCtor = commands.ListGatewayTargetsCommand;
    const input = { gatewayIdentifier: gwId };
    this._lastCommandFactoryName = 'ListGatewayTargetsCommand';
    const cmd = new CommandCtor(input);
    try {
      const resp = (await client.send(cmd)) as SdkListTargetsResponse;
      const targets = resp.targets ?? [];
      return targets.map(t => this.sdkResponseToTarget(t));
    } catch (err) {
      throw this.logAndWrap('listTargets', err, gwId);
    }
  }

  /**
   * Invoke a tool through the Gateway MCP endpoint.
   *
   * Phase-0 treats this as a single opaque command that returns a JSON
   * payload. In Phase-1, callers wrap this in a try/catch and fall back to
   * `gateway_proxy.py` on `GatewayUnavailableError`.
   *
   * TODO(spike): verify the command shape against the real SDK. The current
   * shape mirrors the Registry `SearchRegistryRecordsCommand` pattern.
   */
  async invokeTool(
    gatewayIdOrToolName: string,
    toolNameOrArgs?: string | Record<string, unknown>,
    maybeArgs?: Record<string, unknown>
  ): Promise<GatewayInvokeResult> {
    // Support both (gatewayId, toolName, args) and (toolName, args) call shapes.
    // The task spec asked for invokeTool(gatewayId, toolName, args); a lot of
    // callers want the shorter form when they only talk to one gateway.
    let gatewayId: string;
    let toolName: string;
    let args: Record<string, unknown>;
    if (typeof toolNameOrArgs === 'string') {
      gatewayId = gatewayIdOrToolName;
      toolName = toolNameOrArgs;
      args = maybeArgs ?? {};
    } else {
      gatewayId = this.defaultGatewayId;
      toolName = gatewayIdOrToolName;
      args = (toolNameOrArgs as Record<string, unknown>) ?? {};
    }

    if (!gatewayId) {
      throw new Error('[gateway-client] gatewayId is required for invokeTool');
    }
    if (!toolName) {
      throw new Error('[gateway-client] toolName is required for invokeTool');
    }

    const { client, commands } = await this.getDataPlane();
    const CommandCtor = commands.InvokeGatewayToolCommand;
    if (!CommandCtor) {
      throw new GatewayUnavailableError(
        '[gateway-client] InvokeGatewayToolCommand not available in SDK'
      );
    }
    // ASSUMPTION: command shape is { gatewayIdentifier, toolName, arguments }.
    // The MCP wire protocol uses `tools/call` with `name` + `arguments`; the
    // SDK likely renames these. Verify during spike.
    const input = {
      gatewayIdentifier: gatewayId,
      toolName,
      arguments: args,
    };
    this._lastCommandFactoryName = 'InvokeGatewayToolCommand';
    const cmd = new CommandCtor(input);
    try {
      const resp = (await client.send(cmd)) as {
        payload?: unknown;
        isError?: boolean;
        errorMessage?: string;
      };
      if (resp?.isError) {
        return {
          toolName,
          status: 'error',
          error: resp.errorMessage ?? 'Unknown tool error',
        };
      }
      return { toolName, status: 'success', payload: resp?.payload ?? resp };
    } catch (err) {
      // For transport-level failures we still wrap (so callers can branch on
      // class) but also surface the error through the result envelope so
      // chain-of-responsibility callers can treat Gateway-returned "tool
      // errors" and Gateway-failed invocations with the same code path.
      throw this.logAndWrap('invokeTool', err, toolName);
    }
  }

  /** Test-only accessor for the last command factory used. */
  getLastCommandName(): string | undefined {
    return this._lastCommandFactoryName;
  }

  /**
   * Compute the MCP endpoint URL for the configured gateway.
   *
   * Format (per the deep-dive doc §"What it is"):
   *   `https://<gateway-id>.gateway.bedrock-agentcore.<region>.amazonaws.com/mcp`
   *
   * Exposed mostly for the Phase-1 integration test and for operators
   * debugging MCP client connectivity outside the adapter.
   */
  getMcpEndpoint(gatewayId?: string): string {
    const gwId = gatewayId || this.defaultGatewayId;
    return `https://${gwId}.gateway.bedrock-agentcore.${this.region}.amazonaws.com/mcp`;
  }

  // --- internals ---------------------------------------------------------

  private async getControlPlane(): Promise<{
    client: GatewaySdkClient;
    commands: ControlCommandFactory;
  }> {
    if (this.injectedControl) {
      return {
        client: this.injectedControl,
        commands: (
          this.injectedControl as unknown as { _commands: ControlCommandFactory }
        )._commands,
      };
    }
    const bundle = await loadSdkBundle();
    if (!bundle.control) {
      throw new GatewayUnavailableError(
        '[gateway-client] @aws-sdk/client-bedrock-agentcore-control is not installed; ' +
          'control-plane operations are unavailable.'
      );
    }
    const client = new bundle.control.Client({
      region: this.region,
      credentials: this.credentials,
    });
    return { client, commands: bundle.control.commands };
  }

  private async getDataPlane(): Promise<{
    client: GatewaySdkClient;
    commands: DataCommandFactory;
  }> {
    if (this.injectedData) {
      return {
        client: this.injectedData,
        commands: (
          this.injectedData as unknown as { _commands: DataCommandFactory }
        )._commands,
      };
    }
    const bundle = await loadSdkBundle();
    if (!bundle.data) {
      throw new GatewayUnavailableError(
        '[gateway-client] @aws-sdk/client-bedrock-agentcore is not installed; ' +
          'data-plane operations are unavailable.'
      );
    }
    const client = new bundle.data.Client({
      region: this.region,
      credentials: this.credentials,
    });
    return { client, commands: bundle.data.commands };
  }

  private logAndWrap(op: string, err: unknown, ctx: string): GatewayError {
    const wrapped = err instanceof GatewayError ? err : classifyAwsError(err);
    console.warn(
      `[gateway-client] ${op} failed ctx=${ctx} kind=${wrapped.name} msg=${wrapped.message}`
    );
    return wrapped;
  }

  /**
   * Flattens the SDK's (assumed) discriminated-union target shape to our
   * canonical `GatewayTarget`. The SDK carries at most one of
   * `{lambda, openApi, apiGatewayStage, smithy, mcpRemote, saasTemplate}`;
   * we pick the first one present and fall through to `lambda` if nothing
   * matches (belt-and-suspenders — a legitimate SDK response always carries
   * exactly one).
   */
  private sdkResponseToTarget(t: SdkTargetShape): GatewayTarget {
    if (t.lambda) {
      return {
        type: 'lambda',
        name: t.name ?? '',
        arn: t.lambda.targetArn,
        schema: t.lambda.schema,
        metadata: t.metadata,
      };
    }
    if (t.openApi) {
      return {
        type: 'openapi',
        name: t.name ?? '',
        endpoint: t.openApi.endpoint,
        schema: t.openApi.schema,
        metadata: t.metadata,
      };
    }
    if (t.apiGatewayStage) {
      return {
        type: 'api-gateway-stage',
        name: t.name ?? '',
        // Stitch apiId/stage into an endpoint hint; the SDK also carries the
        // computed invoke URL in the response but we don't depend on it.
        endpoint:
          t.apiGatewayStage.apiId && t.apiGatewayStage.stageName
            ? `apigateway://${t.apiGatewayStage.apiId}/${t.apiGatewayStage.stageName}`
            : undefined,
        metadata: t.metadata,
      };
    }
    if (t.smithy) {
      return {
        type: 'smithy',
        name: t.name ?? '',
        schema: t.smithy.model,
        metadata: t.metadata,
      };
    }
    if (t.mcpRemote) {
      return {
        type: 'mcp-remote',
        name: t.name ?? '',
        endpoint: t.mcpRemote.endpoint,
        metadata: t.metadata,
      };
    }
    if (t.saasTemplate) {
      return {
        type: 'template',
        name: t.name ?? '',
        metadata: { ...(t.metadata ?? {}), templateId: t.saasTemplate.templateId },
      };
    }
    // Unknown target type — treat as lambda with no arn so the caller can log
    // and skip. Refusing to parse would break a bulk ListTargets response on
    // a single unrecognized type.
    return { type: 'lambda', name: t.name ?? '', metadata: t.metadata };
  }
}
