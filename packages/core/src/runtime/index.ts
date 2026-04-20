/**
 * Runtime module
 *
 * Runtime logic is owned by the Python agent container running on AgentCore
 * Runtime; see `packages/agents/chimera_agent.py`. This directory holds
 * TypeScript types shared across the monorepo for runtime integration.
 *
 * The former `AgentCoreRuntime` TypeScript class was removed in the rabbithole
 * audit (see `docs/research/agentcore-rabbithole/02-runtime-memory-deep-dive.md`)
 * because every method was either a TODO placeholder or reinvented an AgentCore
 * primitive that AgentCore Runtime already manages (microVM lifecycle, session
 * ID generation, memory namespacing).
 */

export {};
