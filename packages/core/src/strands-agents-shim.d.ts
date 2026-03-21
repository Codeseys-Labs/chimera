/**
 * Type shim for @strands-agents/sdk
 *
 * This module declaration provides TypeScript types for the Strands Agent SDK
 * until the official package is published to npm/internal registry.
 *
 * This allows discovery tool files to import from '@strands-agents/sdk' and
 * use the tool() decorator pattern without requiring the actual package.
 *
 * @see packages/core/src/aws-tools/strands-agents.d.ts for similar pattern
 */

declare module '@strands-agents/sdk' {
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
   *
   * @example
   * ```typescript
   * import { tool } from '@strands-agents/sdk';
   * import { z } from 'zod';
   *
   * const myTool = tool({
   *   name: 'my-tool',
   *   description: 'Does something useful',
   *   inputSchema: z.object({
   *     param: z.string()
   *   }),
   *   callback: async (input) => {
   *     return `Result: ${input.param}`;
   *   }
   * });
   * ```
   */
  export function tool<TInput = any, TOutput extends string = string>(
    config: ToolConfig<TInput, TOutput>
  ): Tool;
}
