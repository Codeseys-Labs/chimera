/**
 * AgentCore Gateway — Chimera-side type model (Phase 0/1 adapter).
 *
 * Upstream research:
 *   - `docs/research/agentcore-rabbithole/03-gateway-identity-deep-dive.md`
 *     (§ "Target types" enumerates the six Gateway target types we model here;
 *     § "Auth model" motivates the endpoint-URL template used by the client).
 *
 * These types are intentionally *purpose-built* for Chimera's bridge code and
 * the thin wrapper in `agentcore-gateway-client.ts`. They do NOT attempt to
 * model every attribute the AWS SDK exposes. If we don't write or read it in
 * the adapter, it doesn't live here.
 *
 * Deliberate non-goals:
 *   - Inbound authorizer config (`CUSTOM_JWT` / `NONE`) — that's a one-time
 *     CDK concern, not an adapter concern.
 *   - Outbound credential provider wiring — handled by AgentCore Identity at
 *     target creation time; the adapter treats it as an opaque attached config.
 */

/**
 * The six Gateway target types supported by AgentCore (see §"Target types"
 * in the deep-dive doc). `template` covers the 1-click SaaS templates
 * (Salesforce, Slack, Jira, etc.) which are console-only today but the API
 * exists; we model it for completeness.
 */
export type GatewayTargetType =
  | 'lambda'
  | 'openapi'
  | 'smithy'
  | 'api-gateway-stage'
  | 'mcp-remote'
  | 'template';

/**
 * A Chimera-shaped Gateway target description.
 *
 * This is what we pass to `CreateGatewayTarget`. The AWS SDK input structure
 * wraps each target type in its own sub-object; the mapper below flattens it
 * into a single discriminated-union-style `type` field so callers can treat
 * the list uniformly.
 *
 * TODO(spike): verify the exact SDK input shape against
 * `@aws-sdk/client-bedrock-agentcore-control` once the package is installed.
 * The research doc describes the CreateGatewayTarget surface at a high level
 * but the adapter currently assumes a flat {type, name, arn, schema} pass-
 * through; Phase-2 spike confirms/corrects this.
 */
export interface GatewayTarget {
  /** One of the six AgentCore target types. */
  type: GatewayTargetType;
  /**
   * Gateway-visible target name. Becomes the tool prefix via the `___` (triple
   * underscore) convention — e.g. target name `s3` → tool `s3___list_buckets`.
   * Keep this short and DNS-safe.
   */
  name: string;
  /**
   * Lambda ARN (when `type === 'lambda'`) OR remote-MCP server ARN (when
   * `type === 'mcp-remote'` and the server is an AgentCore Runtime / Gateway).
   * Unused for OpenAPI / API-GW-stage / Smithy targets.
   */
  arn?: string;
  /**
   * HTTPS endpoint. Used by `openapi` (OpenAPI doc URL or S3 URI),
   * `mcp-remote` (the remote `/mcp` URL), and `api-gateway-stage` (we pass
   * the stage invoke URL through for operator debugging; the control plane
   * internally calls `GetExport` and re-fetches the OpenAPI export).
   */
  endpoint?: string;
  /**
   * Tool schema payload. For `lambda` targets this is the JSON tool schema
   * (matches MCP's `tools/list` response per-tool shape). For `smithy`
   * targets this is the RestJson Smithy model (≤10 MB). For `openapi` this
   * may be inline JSON when not sourced from S3.
   */
  schema?: Record<string, unknown> | string;
  /**
   * Free-form Chimera metadata. The mapper uses this to stash the original
   * tier tag and service identifier so operators can trace a target back to
   * the Chimera tool-tier config. Not sent to AWS SDK as a first-class field.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Canonical result of invoking a tool via the Gateway. Always carries the
 * tool name (callers frequently batch-invoke and need to match response to
 * request) plus a discriminated status so downstream code never has to parse
 * the MCP JSON-RPC envelope.
 */
export interface GatewayInvokeResult {
  toolName: string;
  status: 'success' | 'error';
  /** Populated on success. Shape depends on the tool. */
  payload?: unknown;
  /** Populated on error. Human-readable; not a stable error code. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Error classes — narrow so callers can branch on failure class without
// stringy matching. Mirrors the Registry adapter's hierarchy.
// ---------------------------------------------------------------------------

export class GatewayError extends Error {
  public readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'GatewayError';
    this.cause = cause;
  }
}

export class GatewayNotFoundError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GatewayNotFoundError';
  }
}

export class GatewayAuthError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GatewayAuthError';
  }
}

export class GatewayRateLimitError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GatewayRateLimitError';
  }
}

/**
 * Raised when the Gateway SDK is unavailable (package not installed) or the
 * endpoint is unreachable. In Phase 1 this is the "fall back to
 * gateway_proxy.py" signal — callers catch this class specifically and
 * invoke the legacy Lambda fanout.
 */
export class GatewayUnavailableError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'GatewayUnavailableError';
  }
}
