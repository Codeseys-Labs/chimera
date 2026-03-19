# OpenClaw on AWS — Scalable Multi-Tenant Deployment

> **Date:** 2026-02-23
> **Status:** Research complete, ready for implementation planning
> **Sources:** DeepWiki (openclaw/openclaw), Builder article by @jiade, aws-samples repo
> **Repo:** [aws-samples/sample-OpenClaw-on-AWS-with-Bedrock](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock)

## What Is OpenClaw?

OpenClaw is a self-hosted, multi-channel AI gateway that connects AI agents to messaging
platforms (WhatsApp, Telegram, Discord, Slack, Signal). It provides:

- Proactive AI agent with tool use (file I/O, shell exec, browser, web search)
- Persistent semantic memory across sessions
- Multi-channel messaging (one agent, many surfaces)
- Scheduled tasks ("heartbeats" — email checks, reminders, monitoring)
- Plugin/extension system for custom capabilities
- Device node system for remote execution on macOS/iOS/Android

## Documents

| Document | Contents |
|----------|----------|
| [[Architecture]] | Core architecture, components, communication patterns |
| [[Disaggregation Patterns]] | How to split components for scalable deployment |
| [[AgentCore Deployment]] | The Bedrock AgentCore serverless deployment model |
| [[Configuration Reference]] | Bedrock provider config, model selection, auth profiles |
| [[Deployment Guide]] | Step-by-step: CloudFormation, ECR, SSM access |
| [[Cost Analysis]] | Honest cost comparisons across deployment models |
| [[Security Model]] | MicroVM isolation, IAM scoping, permission patterns |

## Key Decisions to Make

1. **Deployment model:** EC2-only vs. AgentCore Runtime (serverless microVMs)
2. **Model strategy:** All Claude Sonnet vs. mixed routing (80% Nova Lite / 20% Sonnet)
3. **Channel selection:** Which messaging platforms to connect
4. **Multi-tenancy scope:** Team-only, family, or mixed trust levels
5. **Memory persistence:** AgentCore Memory (managed) vs. self-managed SQLite + vector DB
6. **Gateway sizing:** t4g.small ($12/mo) for family, c7g.large ($35/mo) for teams

## Quick Architecture Summary

```
                    ┌──────────────────────────┐
                    │   Messaging Channels      │
                    │  (WhatsApp/Telegram/Slack) │
                    └──────────┬───────────────┘
                               │
                    ┌──────────▼───────────────┐
                    │   Gateway (EC2, always-on)│
                    │   - Message routing       │
                    │   - Channel management    │
                    │   - WebSocket RPC server  │
                    │   ~$35/mo Graviton ARM    │
                    └──────────┬───────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
    ┌─────────▼──────┐ ┌──────▼───────┐ ┌──────▼───────┐
    │ AgentCore      │ │ AgentCore    │ │ AgentCore    │
    │ MicroVM        │ │ MicroVM      │ │ MicroVM      │
    │ (User A)       │ │ (User B)     │ │ (User C)     │
    │ - Own IAM role │ │ - Own IAM    │ │ - Own IAM    │
    │ - Own memory   │ │ - Own memory │ │ - Own memory │
    │ - Isolated FS  │ │ - Isolated   │ │ - Isolated   │
    └────────────────┘ └──────────────┘ └──────────────┘
              │                │                │
              └────────────────┼────────────────┘
                               │
                    ┌──────────▼───────────────┐
                    │   AgentCore Memory       │
                    │   (Managed, per-user NS) │
                    │   - Long-term extraction │
                    │   - Semantic search      │
                    └──────────────────────────┘
```

## Next Steps

- [ ] Review the [CloudFormation templates](https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock)
- [ ] Decide on deployment model (AgentCore vs EC2-only)
- [ ] Enable Bedrock model access (Nova Lite + Claude Sonnet) in target region
- [ ] Test with a single-user deployment first
- [ ] Plan multi-user rollout with IAM permission scoping
