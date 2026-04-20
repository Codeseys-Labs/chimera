/**
 * Thin wrapper around AWS Bedrock AgentCore Registry SDKs.
 *
 * Phase-0 adapter for ADR-034. Stateless, easy to mock, no retry logic —
 * the caller decides retries. The SDK clients are imported dynamically so
 * that a missing package (e.g. sandbox / offline / packages not yet added
 * to package.json) does *not* crash module load. We mirror the pattern in
 * `packages/chat-gateway/src/routes/chat.ts` ~lines 65-75.
 *
 * The two SDK packages we talk to:
 *   - `@aws-sdk/client-bedrock-agentcore-control` — control plane
 *     (Create/Update/Get/Delete record, status transitions).
 *   - `@aws-sdk/client-bedrock-agentcore`         — data plane
 *     (`SearchRegistryRecords`, `InvokeRegistryMcp`).
 *
 * If either package is not installed at runtime, every method that needs
 * it raises `RegistryUnavailableError` rather than a module-resolution
 * error. This is deliberate for gradual rollout.
 *
 * NOTE: API command shapes below are our best read of the research notes.
 * They MUST be validated against the actual AWS SDK types during the
 * Phase-2 spike. See the "assumptions" comments inline.
 */

import type {
  RegistrySkillRecord,
  RegistryRecordStatus,
  SearchRegistryRecordsResult,
  RegistrySearchFilters,
} from './types';

/** Narrow error types so callers can branch on failure class. */
export class RegistryError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RegistryError';
    this.cause = cause;
  }
}
export class RegistryNotFoundError extends RegistryError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'RegistryNotFoundError';
  }
}
export class RegistryAuthError extends RegistryError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'RegistryAuthError';
  }
}
export class RegistryRateLimitError extends RegistryError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'RegistryRateLimitError';
  }
}
export class RegistryUnavailableError extends RegistryError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'RegistryUnavailableError';
  }
}

/**
 * Minimal client duck-typing. The real AWS SDK v3 clients have a `.send()`
 * method that takes a command instance; we mirror that. Tests inject a
 * fake via the constructor's `_controlPlaneClient` / `_dataPlaneClient`.
 */
export interface RegistrySdkClient {
  send(command: unknown): Promise<unknown>;
}

export interface BedrockRegistryClientOptions {
  registryId: string;
  region: string;
  credentials?: unknown;
  /** Test seam — inject a fake control-plane client. */
  _controlPlaneClient?: RegistrySdkClient;
  /** Test seam — inject a fake data-plane client. */
  _dataPlaneClient?: RegistrySdkClient;
}

/**
 * Structured record of the last SDK command invocation. Tests assert
 * against this to avoid having to mock the full send() contract.
 */
export interface InvokedCommand {
  /** Command class name (e.g. 'CreateRegistryRecordCommand'). */
  name: string;
  /** Command input payload. */
  input: Record<string, unknown>;
}

/** Assumption flag raised by tests — set by a command factory shim. */
interface CommandFactory {
  CreateRegistryRecordCommand: new (input: unknown) => unknown;
  UpdateRegistryRecordCommand?: new (input: unknown) => unknown;
  GetRegistryRecordCommand: new (input: unknown) => unknown;
  UpdateRegistryRecordStatusCommand: new (input: unknown) => unknown;
  SubmitRegistryRecordForApprovalCommand?: new (input: unknown) => unknown;
  SearchRegistryRecordsCommand: new (input: unknown) => unknown;
}

/**
 * Maps an AWS SDK error shape onto one of our narrow error classes.
 * The SDK error hierarchy isn't perfectly stable across service packages;
 * we key off `name` + HTTP status, which are the two fields v3 guarantees.
 */
function classifyAwsError(err: unknown): RegistryError {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
  const name = e?.name ?? 'UnknownError';
  const status = e?.$metadata?.httpStatusCode;
  const msg = e?.message ?? String(err);
  if (name === 'ResourceNotFoundException' || status === 404) {
    return new RegistryNotFoundError(msg, err);
  }
  if (
    name === 'AccessDeniedException' ||
    name === 'UnrecognizedClientException' ||
    status === 401 ||
    status === 403
  ) {
    return new RegistryAuthError(msg, err);
  }
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException' || status === 429) {
    return new RegistryRateLimitError(msg, err);
  }
  return new RegistryUnavailableError(msg, err);
}

/**
 * Lazy dynamic-import of the SDK packages. Returns `null` for either
 * slot if the package isn't installed; callers raise
 * RegistryUnavailableError in that case.
 *
 * We cache per-process so we only take the dynamic-import hit once.
 */
interface SdkBundle {
  control: { Client: new (config: unknown) => RegistrySdkClient; commands: CommandFactory } | null;
  data: { Client: new (config: unknown) => RegistrySdkClient; commands: CommandFactory } | null;
}

let _sdkBundle: Promise<SdkBundle> | null = null;

async function loadSdkBundle(): Promise<SdkBundle> {
  if (_sdkBundle) return _sdkBundle;
  _sdkBundle = (async () => {
    const bundle: SdkBundle = { control: null, data: null };
    try {
      // ASSUMPTION: package name is `@aws-sdk/client-bedrock-agentcore-control`.
      // ASSUMPTION: class name `BedrockAgentCoreControlClient`. Both verified
      // against the AWS SDK v3 naming convention but NOT against the installed
      // package (not yet in package.json — see builder report).
      const mod: Record<string, unknown> = await import(
        // @ts-expect-error — package not yet added to package.json; see builder report.
        '@aws-sdk/client-bedrock-agentcore-control'
      );
      bundle.control = {
        Client: mod.BedrockAgentCoreControlClient as new (c: unknown) => RegistrySdkClient,
        commands: {
          CreateRegistryRecordCommand: mod.CreateRegistryRecordCommand as new (
            i: unknown
          ) => unknown,
          UpdateRegistryRecordCommand: mod.UpdateRegistryRecordCommand as new (
            i: unknown
          ) => unknown,
          GetRegistryRecordCommand: mod.GetRegistryRecordCommand as new (i: unknown) => unknown,
          UpdateRegistryRecordStatusCommand: mod.UpdateRegistryRecordStatusCommand as new (
            i: unknown
          ) => unknown,
          SubmitRegistryRecordForApprovalCommand:
            mod.SubmitRegistryRecordForApprovalCommand as new (i: unknown) => unknown,
          SearchRegistryRecordsCommand: undefined as unknown as new (i: unknown) => unknown,
        },
      };
    } catch {
      // Package not installed — adapter degrades to "unavailable".
      bundle.control = null;
    }
    try {
      const mod: Record<string, unknown> = await import(
        // @ts-expect-error — package not yet added to package.json; see builder report.
        '@aws-sdk/client-bedrock-agentcore'
      );
      bundle.data = {
        Client: mod.BedrockAgentCoreClient as new (c: unknown) => RegistrySdkClient,
        commands: {
          CreateRegistryRecordCommand: undefined as unknown as new (i: unknown) => unknown,
          GetRegistryRecordCommand: undefined as unknown as new (i: unknown) => unknown,
          UpdateRegistryRecordStatusCommand: undefined as unknown as new (i: unknown) => unknown,
          SearchRegistryRecordsCommand: mod.SearchRegistryRecordsCommand as new (
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

/**
 * Thin adapter around the two AgentCore SDKs.
 *
 * All methods are stateless: they read `this.registryId` / `this.region`
 * but do not mutate anything. Errors are wrapped in narrow classes. We
 * deliberately do NOT auto-retry; the caller (dual-write Lambda, Phase-1
 * pipeline stage) is the correct place to decide retry semantics.
 *
 * Structured logs at `console.warn` with a `[registry-client]` prefix
 * surface SDK failures for observability without coupling to a logger.
 */
export class BedrockRegistryClient {
  private readonly registryId: string;
  private readonly region: string;
  private readonly credentials?: unknown;
  private readonly injectedControl?: RegistrySdkClient;
  private readonly injectedData?: RegistrySdkClient;
  /** Test-visible record of command factories used on the last call. */
  private _lastCommandFactoryName?: string;

  constructor(opts: BedrockRegistryClientOptions) {
    if (!opts.registryId) {
      throw new Error('[registry-client] registryId is required');
    }
    if (!opts.region) {
      throw new Error('[registry-client] region is required');
    }
    this.registryId = opts.registryId;
    this.region = opts.region;
    this.credentials = opts.credentials;
    this.injectedControl = opts._controlPlaneClient;
    this.injectedData = opts._dataPlaneClient;
  }

  /**
   * Create a record in the Registry in DRAFT status. The caller is
   * responsible for later calling `submitForApproval` /
   * `updateRecordStatus` (we do not chain them here — intermediate
   * failures would be hard to reason about).
   *
   * Returns a copy of the input record with `recordId` populated and
   * `status` set to DRAFT (the initial state per §4 of the deep-dive).
   */
  async createRecord(record: RegistrySkillRecord): Promise<RegistrySkillRecord> {
    const { client, commands } = await this.getControlPlane();
    const CommandCtor = commands.CreateRegistryRecordCommand;
    // ASSUMPTION: input shape is { registryId, name, version, description,
    // metadata }. The real SDK likely wraps `metadata` under a descriptor
    // object (e.g. { customRecord: { schema: '...', payload: <metadata> } }).
    // Verify during spike.
    const input = {
      registryId: this.registryId,
      name: record.name,
      version: record.version,
      description: record.description,
      metadata: {
        ...record.metadata,
        tenantId: record.tenantId,
      },
    };
    const cmd = new CommandCtor(input);
    this._lastCommandFactoryName = 'CreateRegistryRecordCommand';
    try {
      const resp = (await client.send(cmd)) as { recordId?: string; id?: string };
      const recordId = resp.recordId ?? resp.id;
      if (!recordId) {
        throw new RegistryUnavailableError(
          `[registry-client] CreateRegistryRecord returned no recordId for ${record.name}@${record.version}`
        );
      }
      return { ...record, recordId, status: 'DRAFT' };
    } catch (err) {
      throw this.logAndWrap('createRecord', err, record.name);
    }
  }

  /**
   * Transition a record to a new lifecycle status. Internally this maps
   * to `SubmitRegistryRecordForApproval` (DRAFT → PENDING_APPROVAL) or
   * `UpdateRegistryRecordStatus` (PENDING_APPROVAL → APPROVED/DEPRECATED).
   *
   * Phase-0 keeps this as a single method so the dual-write Lambda has
   * one entry point per record state-change.
   */
  async updateRecordStatus(
    recordId: string,
    status: RegistryRecordStatus
  ): Promise<void> {
    if (!recordId) {
      throw new Error('[registry-client] recordId is required for updateRecordStatus');
    }
    const { client, commands } = await this.getControlPlane();
    let CommandCtor: new (i: unknown) => unknown;
    let input: Record<string, unknown>;
    if (status === 'PENDING_APPROVAL') {
      if (!commands.SubmitRegistryRecordForApprovalCommand) {
        throw new RegistryUnavailableError(
          '[registry-client] SubmitRegistryRecordForApprovalCommand not available in SDK'
        );
      }
      CommandCtor = commands.SubmitRegistryRecordForApprovalCommand;
      input = { registryId: this.registryId, recordId };
      this._lastCommandFactoryName = 'SubmitRegistryRecordForApprovalCommand';
    } else {
      CommandCtor = commands.UpdateRegistryRecordStatusCommand;
      input = { registryId: this.registryId, recordId, status };
      this._lastCommandFactoryName = 'UpdateRegistryRecordStatusCommand';
    }
    const cmd = new CommandCtor(input);
    try {
      await client.send(cmd);
    } catch (err) {
      throw this.logAndWrap('updateRecordStatus', err, recordId);
    }
  }

  /**
   * Fetch a record by ID from the control plane. This returns the latest
   * revision regardless of approval status (the only API that does — see
   * §2.1 of the deep-dive).
   *
   * Returns null on ResourceNotFound (convenient for presence checks).
   */
  async getRecord(recordId: string): Promise<RegistrySkillRecord | null> {
    if (!recordId) {
      throw new Error('[registry-client] recordId is required for getRecord');
    }
    const { client, commands } = await this.getControlPlane();
    const CommandCtor = commands.GetRegistryRecordCommand;
    const input = { registryId: this.registryId, recordId };
    this._lastCommandFactoryName = 'GetRegistryRecordCommand';
    const cmd = new CommandCtor(input);
    try {
      const resp = (await client.send(cmd)) as RegistrySdkGetRecordResponse;
      return this.sdkResponseToRecord(resp, recordId);
    } catch (err) {
      const wrapped = this.logAndWrap('getRecord', err, recordId);
      if (wrapped instanceof RegistryNotFoundError) return null;
      throw wrapped;
    }
  }

  /**
   * Data-plane search. Returns APPROVED records only (AgentCore enforces
   * this server-side).
   */
  async searchRecords(
    query: string,
    filters?: RegistrySearchFilters,
    maxResults = 10
  ): Promise<SearchRegistryRecordsResult> {
    if (!query || query.length === 0) {
      throw new Error('[registry-client] query is required for searchRecords');
    }
    const { client, commands } = await this.getDataPlane();
    const CommandCtor = commands.SearchRegistryRecordsCommand;
    // ASSUMPTION: filter expressions follow the JSON-filter grammar
    // described in §5 of the registry deep-dive. Verify during spike.
    const filterExpressions: Record<string, unknown>[] = [];
    if (filters?.status) {
      filterExpressions.push({ status: { $eq: filters.status } });
    }
    if (filters?.tenantId) {
      filterExpressions.push({ 'metadata.tenantId': { $eq: filters.tenantId } });
    }
    const input: Record<string, unknown> = {
      registryIds: [this.registryId],
      searchQuery: query,
      maxResults,
    };
    if (filterExpressions.length > 0) {
      input.filters =
        filterExpressions.length === 1 ? filterExpressions[0] : { $and: filterExpressions };
    }
    this._lastCommandFactoryName = 'SearchRegistryRecordsCommand';
    const cmd = new CommandCtor(input);
    try {
      const resp = (await client.send(cmd)) as RegistrySdkSearchResponse;
      const records = (resp.records ?? []).map(r => this.sdkResponseToRecord(r, r.recordId ?? ''));
      return { records, nextToken: resp.nextToken };
    } catch (err) {
      throw this.logAndWrap('searchRecords', err, query);
    }
  }

  /**
   * Mark a record as DEPRECATED. Thin convenience wrapper around
   * `updateRecordStatus(recordId, 'DEPRECATED')` — kept as its own method
   * because the pipeline failure path calls it by name.
   */
  async deprecateRecord(recordId: string): Promise<void> {
    return this.updateRecordStatus(recordId, 'DEPRECATED');
  }

  /** Test-only accessor for the last command factory used. */
  getLastCommandName(): string | undefined {
    return this._lastCommandFactoryName;
  }

  // --- internals ---------------------------------------------------------

  private async getControlPlane(): Promise<{
    client: RegistrySdkClient;
    commands: CommandFactory;
  }> {
    if (this.injectedControl) {
      // Injected clients assume the caller has also stubbed the commands
      // via the factory stored on the client — see tests.
      return {
        client: this.injectedControl,
        commands: (this.injectedControl as unknown as { _commands: CommandFactory })._commands,
      };
    }
    const bundle = await loadSdkBundle();
    if (!bundle.control) {
      throw new RegistryUnavailableError(
        '[registry-client] @aws-sdk/client-bedrock-agentcore-control is not installed; ' +
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
    client: RegistrySdkClient;
    commands: CommandFactory;
  }> {
    if (this.injectedData) {
      return {
        client: this.injectedData,
        commands: (this.injectedData as unknown as { _commands: CommandFactory })._commands,
      };
    }
    const bundle = await loadSdkBundle();
    if (!bundle.data) {
      throw new RegistryUnavailableError(
        '[registry-client] @aws-sdk/client-bedrock-agentcore is not installed; ' +
          'data-plane operations are unavailable.'
      );
    }
    const client = new bundle.data.Client({
      region: this.region,
      credentials: this.credentials,
    });
    return { client, commands: bundle.data.commands };
  }

  private logAndWrap(op: string, err: unknown, ctx: string): RegistryError {
    const wrapped = err instanceof RegistryError ? err : classifyAwsError(err);
    console.warn(
      `[registry-client] ${op} failed ctx=${ctx} kind=${wrapped.name} msg=${wrapped.message}`
    );
    return wrapped;
  }

  /**
   * Converts the AWS SDK response shape into a RegistrySkillRecord.
   * ASSUMPTION: response carries `recordId`, `name`, `version`, `status`,
   * `description`, and a `metadata` object. Real shape depends on how
   * Chimera ships the record body — confirm during spike.
   */
  private sdkResponseToRecord(
    resp: RegistrySdkGetRecordResponse,
    fallbackRecordId: string
  ): RegistrySkillRecord {
    const metadata: Record<string, unknown> = { ...(resp.metadata ?? {}) };
    // tenantId is carried inside metadata — pull it back out to the top level.
    const tenantId = typeof metadata.tenantId === 'string' ? metadata.tenantId : '';
    delete metadata.tenantId;
    return {
      registryId: this.registryId,
      recordId: resp.recordId ?? fallbackRecordId,
      name: resp.name ?? '',
      version: resp.version ?? '',
      status: (resp.status as RegistryRecordStatus) ?? 'DRAFT',
      description: resp.description,
      tenantId,
      metadata,
    };
  }
}

// --- SDK response shapes -----------------------------------------------

/**
 * ASSUMPTION shapes — Chimera's guess at what the SDK returns. The real
 * response structure MUST be re-verified against `@aws-sdk/client-
 * bedrock-agentcore-control` types during the Phase-2 spike.
 */
interface RegistrySdkGetRecordResponse {
  recordId?: string;
  name?: string;
  version?: string;
  status?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface RegistrySdkSearchResponse {
  records?: RegistrySdkGetRecordResponse[];
  nextToken?: string;
}
