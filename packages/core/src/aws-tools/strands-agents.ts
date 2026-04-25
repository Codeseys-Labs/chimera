/**
 * Temporary implementation for strands-agents
 *
 * This file provides a minimal Zod-based tool factory that stands in for
 * the official `@strands-agents/sdk` npm package.
 *
 * STATUS (as of Wave 20, 2026-04-25):
 *   - Official SDK is now published: `@strands-agents/sdk@1.0.0-rc.5`
 *     (AWS Labs, github.com/strands-agents/sdk-typescript)
 *   - This shim's API is Zod-flavored (`inputSchema: ZodType`).
 *   - The official SDK uses JSON Schema (`@types/json-schema`).
 *   - Direct swap is NOT possible — call sites need a Zod→JSON-Schema adapter
 *     (e.g., `zod-to-json-schema`) or a rewrite.
 *
 * MIGRATION PATH (chimera-b7af):
 *   1. `bun add @strands-agents/sdk` in packages/core
 *   2. Find all importers: `rg "from ['\"].*aws-tools/strands-agents['\"]"`
 *   3. For each tool definition, convert `inputSchema: zodSchema` to
 *      `inputSchema: zodToJsonSchema(zodSchema)` OR switch to the SDK's
 *      native tool builder.
 *   4. Adapt the callback signature (SDK returns typed ToolResponse,
 *      not stringified output).
 *   5. Delete this file; remove the Zod dependency from this surface if
 *      no other Zod consumers remain.
 *
 * Blocker: SDK is still RC (`1.0.0-rc.5`); pinning vs RC churn is a
 * judgment call. Recommend waiting for `1.0.0` GA.
 *
 * TODO(chimera-b7af): Execute migration when `@strands-agents/sdk` hits 1.0.0 GA
 */

import type { ZodType } from 'zod';

/**
 * Tool configuration for Strands Agent
 */
export interface ToolConfig<TInput = any, TOutput = string> {
  /** Tool name (must be unique within agent) */
  name: string;

  /** Human-readable description of what the tool does */
  description: string;

  /** Zod schema for input validation */
  inputSchema: ZodType<TInput>;

  /** Async callback function that executes the tool */
  callback: (input: TInput) => Promise<TOutput>;
}

/**
 * Tool instance returned by tool() function
 */
export interface Tool {
  name: string;
  description: string;
  inputSchema: ZodType;
  callback: (input: any) => Promise<string>;
}

/**
 * Create a Strands tool
 *
 * @param config - Tool configuration
 * @returns Tool instance for use with Strands Agent
 */
export function tool<TInput = any, TOutput extends string = string>(
  config: ToolConfig<TInput, TOutput>
): Tool {
  return {
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    callback: async (input: TInput): Promise<string> => {
      const result = await config.callback(input);
      return result as unknown as string;
    },
  };
}
