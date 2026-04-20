/**
 * Pure mapping functions between Chimera's tier-grouped tool catalog and the
 * `GatewayTarget[]` list we hand to `CreateGatewayTarget`.
 *
 * Hard rules:
 *   1. No I/O. Pure functions only.
 *   2. Never silently drop a tool that the agent expects to be reachable —
 *      fail loudly (throw) when a tool's Lambda ARN is missing.
 *   3. One Gateway target = one AWS service identifier (s3, lambda, etc.),
 *      NOT one per tool. Gateway's `___` prefix convention lets a single
 *      target expose N tools — matches Chimera's Python-side
 *      `_TOOL_TIER_REGISTRY` groups in `packages/agents/gateway_config.py`.
 *
 * Cross-reference: `packages/agents/gateway_config.py` defines the
 * authoritative tier → module → tool set mapping. The fixture in this file
 * duplicates a narrowed slice of that mapping (tier1-tier3 only; the
 * tier-0 "core" group stays local to the agent container because those
 * tools have no boto3 dispatch). When that Python file changes, update
 * `TIER_TO_SERVICE_IDENTIFIERS` here and the mapper test will regression-
 * catch the mismatch.
 *
 * Non-goals:
 *   - Per-tool JSON schema generation. The schemas live in each Lambda's
 *     own code; Phase-1 reads them back via `ListGatewayTargets` after the
 *     initial CDK pass creates the targets.
 *   - `openapi` / `smithy` / `mcp-remote` / `template` / `api-gateway-stage`
 *     targets. Phase-0 only emits `lambda` targets — everything else is a
 *     Phase-2+ concern.
 */

import type { GatewayTarget } from './types';

/**
 * Chimera's tier ladder. Matches TypeScript `ToolTier` in `tier-config.ts`
 * but uses the Python-friendly string form exposed by
 * `packages/agents/gateway_config.py::TENANT_TIER_ACCESS`. Tier 4 is reserved
 * for future "enterprise" tooling; Phase-0 emits nothing for it.
 */
export type ChimeraToolTier = 'tier1' | 'tier2' | 'tier3' | 'tier4';

/**
 * Authoritative fixture: which service identifiers belong to which Chimera
 * tier. Mirrors `_TOOL_TIER_REGISTRY` in `packages/agents/gateway_config.py`.
 *
 * The test suite verifies this matches the Python source by counting
 * identifiers per tier; it does NOT parse Python AST (would be flaky). When
 * `gateway_config.py` changes, this fixture must be updated manually.
 *
 * Notable exclusions vs. the Python fixture:
 *   - Tier 0 core tools (`hello_world`, `background_task`, `cloudmap`) —
 *     these run in-process in the agent, no Lambda dispatch needed.
 *   - `code_interpreter`, `swarm` — special-case modules that are Phase-2
 *     candidates for `mcp-remote` targets, not `lambda` targets.
 *   - `evolution` — Phase-3, wired through CodePipeline not Gateway.
 */
export const TIER_TO_SERVICE_IDENTIFIERS: Record<
  ChimeraToolTier,
  readonly string[]
> = {
  // Tier 1: Core Compute & Storage
  tier1: ['lambda', 'ec2', 's3', 'cloudwatch', 'sqs', 'dynamodb'],
  // Tier 2: Database & Messaging
  tier2: ['rds', 'redshift', 'athena', 'glue', 'opensearch'],
  // Tier 3: Orchestration & ML
  tier3: [
    'stepfunctions',
    'bedrock',
    'sagemaker',
    'rekognition',
    'textract',
    'transcribe',
    'codebuild',
    'codecommit',
    'codepipeline',
  ],
  // Tier 4: reserved; no Phase-0 targets
  tier4: [],
} as const;

/**
 * Build a `GatewayTarget[]` for a single tier from a `{ serviceIdentifier
 * → lambdaArn }` map. One target per service identifier; the Lambda will
 * handle N tools via the Gateway's `___` prefix convention.
 *
 * @throws Error when a service identifier in the tier has no ARN in
 *   `lambdaArnByTool`. This is a fail-loud choice: a silent skip would
 *   hide a CDK misconfiguration until an agent tried to call the tool.
 */
export function chimeraToolsToGatewayTargets(
  toolTier: ChimeraToolTier,
  lambdaArnByTool: Record<string, string>
): GatewayTarget[] {
  const identifiers = TIER_TO_SERVICE_IDENTIFIERS[toolTier];
  if (!identifiers) {
    throw new Error(
      `[gateway-mapper] unknown toolTier: ${toolTier}; ` +
        `expected one of ${Object.keys(TIER_TO_SERVICE_IDENTIFIERS).join(', ')}`
    );
  }

  const targets: GatewayTarget[] = [];
  const missing: string[] = [];

  for (const identifier of identifiers) {
    const arn = lambdaArnByTool[identifier];
    if (!arn) {
      missing.push(identifier);
      continue;
    }
    targets.push({
      type: 'lambda',
      // Target name must be a DNS-safe identifier (no `/`, `:`, `.`). Each
      // service identifier in our registry is already safe (kebab/snake only),
      // so we pass through verbatim. Keep an assert just in case.
      name: assertTargetName(identifier),
      arn,
      metadata: {
        // Chimera-side provenance for the operator debugging the CDK diff.
        chimeraTier: toolTier,
        serviceIdentifier: identifier,
      },
    });
  }

  if (missing.length > 0) {
    throw new Error(
      `[gateway-mapper] missing Lambda ARN(s) for ${toolTier} tools: ` +
        `${missing.join(', ')}. Every identifier listed in ` +
        `TIER_TO_SERVICE_IDENTIFIERS['${toolTier}'] must have a mapping in ` +
        `lambdaArnByTool or be removed from the tier.`
    );
  }

  return targets;
}

/**
 * Tool-name validator. Gateway target names must be DNS-safe to avoid
 * collision with the `___` tool-prefix convention. Throws if the identifier
 * contains anything other than `[a-z0-9-]+`.
 */
function assertTargetName(identifier: string): string {
  if (!/^[a-z0-9-]+$/.test(identifier)) {
    throw new Error(
      `[gateway-mapper] service identifier '${identifier}' is not DNS-safe; ` +
        `Gateway target names must match ^[a-z0-9-]+$`
    );
  }
  return identifier;
}

/**
 * Compute the full list of targets across all tiers in one call. Useful for
 * the CDK construct that bulk-creates the Gateway.
 *
 * Requires a complete `lambdaArnByTool` map — passing a partial map is a
 * user error and raises via the underlying `chimeraToolsToGatewayTargets`.
 */
export function allTiersToGatewayTargets(
  lambdaArnByTool: Record<string, string>
): GatewayTarget[] {
  const tiers: ChimeraToolTier[] = ['tier1', 'tier2', 'tier3', 'tier4'];
  const out: GatewayTarget[] = [];
  for (const tier of tiers) {
    // Tier 4 is empty at Phase-0; skip the ARN validation by short-circuiting.
    if (TIER_TO_SERVICE_IDENTIFIERS[tier].length === 0) continue;
    out.push(...chimeraToolsToGatewayTargets(tier, lambdaArnByTool));
  }
  return out;
}
