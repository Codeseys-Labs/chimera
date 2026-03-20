/**
 * Adapter registry — maps platform names to adapter instances
 */

import { PlatformAdapter } from './types';
import { WebPlatformAdapter } from './web';
import { SlackPlatformAdapter } from './slack';
import { DiscordPlatformAdapter } from './discord';
import { TeamsPlatformAdapter } from './teams';
import { TelegramPlatformAdapter } from './telegram';

/**
 * Registry of all available platform adapters
 */
const adapterRegistry: Map<string, PlatformAdapter> = new Map<string, PlatformAdapter>([
  ['web', new WebPlatformAdapter()],
  ['slack', new SlackPlatformAdapter()],
  ['discord', new DiscordPlatformAdapter()],
  ['teams', new TeamsPlatformAdapter()],
  ['telegram', new TelegramPlatformAdapter()],
]);

/**
 * Get adapter for a given platform
 *
 * @param platform - Platform identifier (web, slack, discord, teams, telegram)
 * @returns Platform adapter instance
 * @throws Error if platform is unsupported
 */
export function getAdapter(platform: string): PlatformAdapter {
  const adapter = adapterRegistry.get(platform);

  if (!adapter) {
    const supportedPlatforms = Array.from(adapterRegistry.keys()).join(', ');
    throw new Error(
      `Unsupported platform: ${platform}. Supported platforms: ${supportedPlatforms}`
    );
  }

  return adapter;
}

/**
 * Register a custom platform adapter
 *
 * Allows runtime registration of third-party or custom adapters.
 *
 * @param platform - Platform identifier
 * @param adapter - Platform adapter instance
 */
export function registerAdapter(platform: string, adapter: PlatformAdapter): void {
  adapterRegistry.set(platform, adapter);
}

/**
 * Check if a platform is supported
 *
 * @param platform - Platform identifier
 * @returns true if adapter exists for platform
 */
export function isSupported(platform: string): boolean {
  return adapterRegistry.has(platform);
}

/**
 * Get list of all supported platforms
 *
 * @returns Array of supported platform identifiers
 */
export function getSupportedPlatforms(): string[] {
  return Array.from(adapterRegistry.keys());
}

// Re-export platform adapters for direct use
export { WebPlatformAdapter } from './web';
export { SlackPlatformAdapter } from './slack';
export { DiscordPlatformAdapter } from './discord';
export { TeamsPlatformAdapter } from './teams';
export { TelegramPlatformAdapter } from './telegram';
export type { PlatformAdapter } from './types';
