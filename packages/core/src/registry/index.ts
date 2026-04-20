/**
 * Public entry point for the AgentCore Registry adapter.
 *
 * Everything the Phase-1 dual-write Lambda / Phase-2 discovery client
 * needs lives here. Internal helpers (SDK bundle cache, SDK command
 * factory types) are intentionally NOT re-exported.
 */

export * from './feature-flags';
export * from './types';
export {
  BedrockRegistryClient,
  RegistryError,
  RegistryNotFoundError,
  RegistryAuthError,
  RegistryRateLimitError,
  RegistryUnavailableError,
  _resetSdkBundleForTests,
} from './bedrock-registry-client';
export type {
  BedrockRegistryClientOptions,
  RegistrySdkClient,
  InvokedCommand,
} from './bedrock-registry-client';
export {
  skillToRegistryRecord,
  registryRecordToSkill,
  CrossTenantRecordError,
} from './skill-to-registry-mapper';
