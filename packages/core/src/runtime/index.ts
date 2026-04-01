/**
 * Runtime module - AgentCore Runtime integration
 *
 * Exports:
 * - AgentCoreRuntime: Runtime client for session and memory management
 * - Helper functions and constants for runtime configuration
 */

export {
  AgentCoreRuntime,
  createRuntime,
  MEMORY_STRATEGY_TIERS,
  type RuntimeConfig,
  type RuntimeSession,
  type MemoryOperation,
  type MemoryResult,
  type AgentInvocationResult,
  type SessionHistoryEntry,
} from './agentcore-runtime';
