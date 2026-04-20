/**
 * Feature flags for the AgentCore Gateway migration (Phase 0/1).
 *
 * Mirrors the pattern used for the AgentCore Registry migration — see
 * `packages/core/src/registry/feature-flags.ts` (Wave 6). All flags default
 * to OFF so merging this code does NOT change production behavior. Each flag
 * is read once per process from env vars so toggling requires a deployment,
 * not a hot-reload — this is deliberate for safety.
 *
 * Phases (mirrors docs/MIGRATION-gateway.md):
 *   Phase 0: adapter + mapper scaffolding merged, no behavior change (this file)
 *   Phase 1: GATEWAY_MIGRATION_ENABLED=true — real Gateway created + targets
 *            registered via CDK; gateway_proxy.py still handles all invokes
 *   Phase 2: + GATEWAY_PRIMARY_INVOKE=true — prefer real Gateway for tool
 *            calls, fall back to gateway_proxy.py on error
 *   Phase 3: cutover (separate wave) — gateway_proxy.py is retired
 *
 * Bootstrap invariant (caller decides when/where to run):
 *
 *   // somewhere in the Lambda / ECS container's boot path:
 *   import { gatewayFlags, assertGatewayFlagsConsistent } from './gateway';
 *   assertGatewayFlagsConsistent(gatewayFlags); // throws on misconfig
 *
 *   // Then start accepting traffic. A failed assert crashes the process
 *   // loudly on boot instead of silently returning wrong answers later.
 *
 * The adapter does NOT auto-call `assertGatewayFlagsConsistent` — callers that
 * want fail-fast boot invoke it themselves. This mirrors the Registry adapter
 * and keeps this module pure (importing it never throws).
 */

function readBool(name: string, env: NodeJS.ProcessEnv, defaultValue = false): boolean {
  const v = env[name];
  if (v === undefined || v === '') return defaultValue;
  return v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes';
}

export interface GatewayFeatureFlags {
  /** Master switch — Phase 1+. When false, adapter is inert. */
  readonly gatewayMigrationEnabled: boolean;
  /**
   * Prefer the real AgentCore Gateway for tool invocations, falling back to
   * `gateway_proxy.py` on any error. Phase 2+. Requires `gatewayMigrationEnabled`.
   */
  readonly gatewayPrimaryInvoke: boolean;
  /**
   * Gateway ID (short id or ARN). Required once `gatewayMigrationEnabled=true`.
   * Adapter fails closed if this is unset while the flag is on.
   */
  readonly gatewayId: string | undefined;
  /**
   * AWS region for Gateway calls. Defaults to `AWS_REGION` when unset. Cross-
   * region Gateway access isn't an adapter concern — the client binds to a
   * single region per process.
   */
  readonly gatewayRegion: string | undefined;
}

export function loadGatewayFlags(
  env: NodeJS.ProcessEnv = process.env
): GatewayFeatureFlags {
  return {
    gatewayMigrationEnabled: readBool('GATEWAY_MIGRATION_ENABLED', env),
    gatewayPrimaryInvoke: readBool('GATEWAY_PRIMARY_INVOKE', env),
    gatewayId: env.GATEWAY_ID || undefined,
    gatewayRegion: env.GATEWAY_REGION || env.AWS_REGION || undefined,
  };
}

/** Default singleton, read from process.env at import time. */
export const gatewayFlags: GatewayFeatureFlags = loadGatewayFlags();

/**
 * Invariant check — call at boot to fail loudly if flags are misconfigured.
 * Rules:
 *   1. `gatewayPrimaryInvoke` requires `gatewayMigrationEnabled` (you can't
 *      primary-read without having a Gateway).
 *   2. `gatewayMigrationEnabled` requires `gatewayId` (the adapter has
 *      nowhere to send calls otherwise).
 */
export function assertGatewayFlagsConsistent(
  f: GatewayFeatureFlags = gatewayFlags
): void {
  if (f.gatewayPrimaryInvoke && !f.gatewayMigrationEnabled) {
    throw new Error(
      '[gateway-flags] GATEWAY_PRIMARY_INVOKE=true requires GATEWAY_MIGRATION_ENABLED=true'
    );
  }
  if (f.gatewayMigrationEnabled && !f.gatewayId) {
    throw new Error(
      '[gateway-flags] GATEWAY_MIGRATION_ENABLED=true requires GATEWAY_ID to be set'
    );
  }
}

// Re-export readBool for symmetry/testing if other modules want the same helper.
export { readBool };
