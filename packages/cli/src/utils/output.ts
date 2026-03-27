/**
 * Output formatting utilities
 */

import { color } from '../lib/color';

export interface TenantConfig {
  tenantId: string;
  name: string;
  tier: string;
  region: string;
  status: string;
  createdAt: string;
}

/**
 * Format output as pretty JSON with colors
 */
export function formatOutput(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/**
 * Format success message
 */
export function formatSuccess(message: string): string {
  return color.green(`✓ ${message}`);
}

/**
 * Format error message
 */
export function formatError(message: string): string {
  return color.red(`✗ ${message}`);
}

/**
 * Format warning message
 */
export function formatWarning(message: string): string {
  return color.yellow(`⚠ ${message}`);
}

/**
 * Format info message
 */
export function formatInfo(message: string): string {
  return color.blue(`ℹ ${message}`);
}

/**
 * Format header
 */
export function formatHeader(text: string): string {
  return color.bold(color.underline(text));
}

/**
 * Format key-value pair
 */
export function formatKeyValue(key: string, value: string): string {
  return `${color.bold(key)}: ${value}`;
}
