# Architecture Decision Records (ADRs)

This directory contains formal Architecture Decision Records documenting key architectural decisions made during the Chimera project.

## What is an ADR?

An Architecture Decision Record (ADR) captures a significant architectural decision along with its context, alternatives considered, and consequences. ADRs provide a historical record of why the system was designed the way it is.

## ADR Format

Each ADR follows this structure:

- **Status**: Accepted | Deprecated | Superseded
- **Context**: What problem does this decision address?
- **Alternatives**: What options were considered?
- **Decision**: What was chosen and why?
- **Consequences**: What are the trade-offs?
- **Evidence**: What research or evidence supports this?
- **Related Decisions**: Which other ADRs are connected?

## Index

### Core Architecture

- [ADR-001](./ADR-001-six-table-dynamodb.md) - 6-Table DynamoDB Design over Single-Table
- [ADR-002](./ADR-002-cedar-policy-engine.md) - Cedar over OPA for Policy Engine
- [ADR-003](./ADR-003-strands-agent-framework.md) - Strands over LangChain/CrewAI for Agent Framework
- [ADR-004](./ADR-004-vercel-ai-sdk-chat.md) - Vercel AI SDK + SSE Bridge for Chat Layer
- [ADR-005](./ADR-005-aws-cdk-iac.md) - AWS CDK over OpenTofu/Pulumi for IaC

### Storage & Isolation

- [ADR-006](./ADR-006-monorepo-structure.md) - Monorepo over Polyrepo
- [ADR-007](./ADR-007-agentcore-microvm.md) - AgentCore MicroVM over ECS/Lambda for Agent Isolation
- [ADR-008](./ADR-008-eventbridge-nervous-system.md) - EventBridge as Central Nervous System
- [ADR-010](./ADR-010-s3-efs-hybrid-storage.md) - S3 + EFS Hybrid over EFS-Only for Workspaces

### Data & Authentication

- [ADR-009](./ADR-009-universal-skill-adapter.md) - Universal Skill Adapter Pattern
- [ADR-011](./ADR-011-self-modifying-iac.md) - Self-Modifying IaC via DynamoDB-Driven CDK
- [ADR-016](./ADR-016-agentcore-memory-strategy.md) - AgentCore Memory (STM+LTM) Strategy

### Operational Excellence

- [ADR-012](./ADR-012-well-architected-framework.md) - Well-Architected Framework as Agent Decision Framework
- [ADR-013](./ADR-013-codecommit-codepipeline.md) - CodeCommit + CodePipeline for Infrastructure-as-Capability

### Tech Stack

- [ADR-014](./ADR-014-token-bucket-rate-limiting.md) - Token Bucket over Sliding Window for Rate Limiting
- [ADR-015](./ADR-015-bun-mise-toolchain.md) - Bun + Mise for Development Toolchain
- [ADR-017](./ADR-017-multi-provider-llm.md) - Multi-Provider LLM Support
- [ADR-018](./ADR-018-skill-md-v2.md) - SKILL.md v2 Format Specification
- [ADR-019](./ADR-019-hono-over-express.md) - Hono over Express for HTTP Gateway
- [ADR-020](./ADR-020-two-container-docker.md) - Two-Stage Docker Builds for Production Images
- [ADR-021](./ADR-021-npx-for-cdk-commands.md) - npx for CDK Commands (Not bunx)
- [ADR-022](./ADR-022-skipLibCheck-cdk-synth.md) - skipLibCheck for CDK Synthesis Performance
- [ADR-023](./ADR-023-batched-createcommit-codecommit.md) - Batched CreateCommit for CodeCommit Deployments

### Modernization (Stream Research)

- [ADR-024](./ADR-024-standardize-tier-naming.md) - Standardize Tenant Tier Naming
- [ADR-025](./ADR-025-cdk-nag-compliance.md) - CDK Nag Compliance Scanning
- [ADR-026](./ADR-026-l3-construct-library.md) - L3 Construct Library for Chimera Conventions
- [ADR-027](./ADR-027-react-vite-shadcn-frontend.md) - React + Vite + shadcn/ui for Web Frontend
- [ADR-028](./ADR-028-amplify-gen2-auth.md) - AWS Amplify Gen 2 for Frontend Authentication
- [ADR-029](./ADR-029-bun-builtin-apis.md) - Bun Built-in APIs — Named Exports and Node-Server Adapter
- [ADR-030](./ADR-030-unified-chimera-toml.md) - Unified chimera.toml Configuration

## Supersession Chain

```
[Initial Design] → [Current Design] → [Future Design]
```

None yet - all ADRs are currently active (Status: Accepted)

## References

- **Canonical Data Model**: [docs/architecture/canonical-data-model.md](../canonical-data-model.md)
- **Definitive Architecture**: [docs/research/architecture-reviews/Chimera-Definitive-Architecture.md](../../research/architecture-reviews/Chimera-Definitive-Architecture.md)
- **Research Corpus**: [docs/research/](../../research/)

## Contributing

When adding a new ADR:

1. Use the next sequential number (ADR-031, ADR-032, etc.)
2. Follow the standard template structure
3. Link related ADRs in "Related Decisions" section
4. Update this README index
5. Reference the ADR in code comments where applicable

## Metadata

- **Total ADRs**: 30
- **Status**: All Accepted
- **Last Updated**: 2026-03-26
- **Authority**: This directory is the canonical source for architectural decisions
