/**
 * Platform adapter interface
 *
 * Abstracts platform-specific message formatting (Web, Slack, Teams, Discord, etc.)
 */

import { ChatMessage, TenantContext } from '../types';

/**
 * Platform adapter interface
 */
export interface PlatformAdapter {
  /** Platform identifier */
  readonly platform: string;

  /**
   * Parse incoming request body to extract messages
   */
  parseIncoming(body: unknown): ChatMessage[];

  /**
   * Format agent response for the platform
   */
  formatResponse(content: string, context: TenantContext): unknown;
}
