/**
 * Memory module exports
 *
 * Provides AgentCore Memory integration with STM+LTM patterns
 * and tenant-scoped namespace utilities
 */

// Types
export * from './types';

// Client interface and factory
export * from './client';

// In-memory client implementation
export * from './in-memory-client';

// Namespace utilities
export * from './namespace';

// Tiered memory client (SESSION, SWARM, AGENT scopes)
export * from './tiered-client';
