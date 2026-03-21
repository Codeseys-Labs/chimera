/**
 * Temporary type definitions for strands-agents
 *
 * This file provides minimal type definitions for the Strands agent framework
 * until the actual strands-agents package is available.
 *
 * TODO: Remove this file once strands-agents is published to npm/internal registry
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
): Tool;
