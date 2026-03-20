---
title: Skill Format Compatibility Research
task: chimera-e55a
agent: mcp-gateway-research
created: 2026-03-20
status: in-progress
---

# Skill Format Compatibility Research

## Executive Summary

**Key Findings:**

1. **MCP Tools → Chimera Skills: FEASIBLE** — The 10,000+ MCP server ecosystem can be wrapped as Chimera skills through a 3-layer adapter. Protocol translation, schema conversion, and trigger generation enable seamless integration.

2. **AgentCore Gateway: PRODUCTION-READY** — AWS AgentCore Gateway (GA Aug 2025) provides managed skill infrastructure with native MCP support, semantic discovery, multi-tenant isolation, and zero-code tool creation from APIs/Lambda.

3. **Schema Gap is Bridgeable** — MCP JSON Schema (machine-optimal) vs SKILL.md frontmatter (LLM-optimal) serve different purposes. Hybrid approach combines validation with LLM selection triggers.

4. **Discovery is Critical** — With 10k+ tools, semantic search (vector embeddings) and category taxonomy are essential. Gateway provides native semantic discovery.

5. **Hybrid Architecture Recommended** — Direct MCP client for latency-sensitive tools + Gateway for shared/managed tools balances performance and operational simplicity.

## Research Scope

This research investigates skill formats across multiple agent platforms and explores how AWS Chimera can achieve cross-platform skill compatibility:

1. **[OpenClaw Skills](#openclaw-skills)** — SKILL.md format (v1 and v2)
2. **[Claude Code Skills](#claude-code-skills)** — Frontmatter-based skill format
3. **[MCP Tools & AgentCore Gateway](#mcp-tools-agentcore-gateway)** — MCP tools as skills + Gateway infrastructure
4. **[Strands Tools](#strands-tools)** — @tool decorator pattern
5. **[Compatibility Layer](#compatibility-layer)** — Universal skill interface design
6. **[Skill Marketplace](#skill-marketplace)** — Discovery, versioning, trust architecture

## OpenClaw Skills

**Document:** [01-OpenClaw-Skills.md](./01-OpenClaw-Skills.md)

[Summary of OpenClaw findings to be filled]

## Claude Code Skills

**Document:** [02-Claude-Code-Skills.md](./02-Claude-Code-Skills.md)

[Summary of Claude Code findings to be filled]

## MCP Tools & AgentCore Gateway

**Document:** [03-MCP-AgentCore-Gateway.md](./03-MCP-AgentCore-Gateway.md)

**Status:** ✅ Complete

**Summary:**
- **MCP Protocol:** JSON-RPC 2.0-based protocol with 10,000+ community servers
- **Wrapping Feasibility:** 3-layer adapter architecture enables MCP tools as Chimera skills
- **Schema Translation:** Bidirectional conversion between MCP JSON Schema and SKILL.md frontmatter
- **AgentCore Gateway:** Production-ready managed service with native MCP support, semantic discovery, multi-tenant isolation
- **Architecture:** Hybrid approach — direct MCP for low-latency + Gateway for shared tools
- **Discovery:** Multi-tier strategy (curated registry + semantic search + category taxonomy)
- **Recommendation:** Adopt MCP + Gateway as Chimera skill infrastructure foundation

## Strands Tools

**Document:** [04-Strands-Tools.md](./04-Strands-Tools.md)

[Summary of Strands findings to be filled]

## Compatibility Layer

**Document:** [05-Compatibility-Layer.md](./05-Compatibility-Layer.md)

[Summary of compatibility approach to be filled]

## Skill Marketplace

**Document:** [06-Skill-Marketplace.md](./06-Skill-Marketplace.md)

[Summary of marketplace architecture to be filled]

## Key Findings

[To be filled with cross-cutting insights]

## Recommendations for Chimera

[To be filled with actionable recommendations]

## References

- OpenClaw documentation
- Claude Code skills documentation
- MCP specification
- AgentCore/Strands documentation
