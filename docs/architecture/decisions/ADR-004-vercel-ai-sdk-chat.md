---
title: 'ADR-004: Vercel AI SDK + SSE Bridge for Chat Layer'
status: accepted
date: 2026-03-20
decision_makers: [chimera-architecture-team]
---

# ADR-004: Vercel AI SDK + SSE Bridge for Chat Layer

## Status

**Accepted** (2026-03-20)

## Context

AWS Chimera agents need to communicate with users across multiple chat platforms:
- **Web** (React UI with streaming)
- **Slack** (native threading, rich cards)
- **Discord** (embeds, reactions)
- **Microsoft Teams** (adaptive cards)
- **Telegram** (inline keyboards)
- **WhatsApp** (media messages)

Requirements:
- **Unified API**: Single agent code works across all platforms
- **Streaming**: Real-time token streaming for responsive UX
- **Rich UI**: Platform-native cards, buttons, forms
- **Cross-platform identity**: Link Slack user = Discord user = web user
- **Bidirectional**: Agents can send proactive messages (not just respond)

The OpenClaw Gateway daemon supports 23+ platforms but is tightly coupled to the Pi runtime. We need a solution that works with AgentCore Runtime and AWS services.

## Decision

Use **Vercel AI SDK (Chat)** with a custom **SSE Bridge service** running on ECS Fargate.

**Architecture:**
```
Chat Platforms → Vercel Chat SDK (ECS Fargate) → SSE Bridge → AgentCore Runtime
```

Vercel Chat SDK handles platform adapters (Slack, Discord, etc.). SSE Bridge translates between AgentCore streaming format and Vercel's Data Stream Protocol.

**Example code:**
```typescript
import { Bot } from 'chat';
import { SlackAdapter, DiscordAdapter } from 'chat/adapters';

const bot = new Bot({
  adapters: [
    new SlackAdapter({ token: process.env.SLACK_TOKEN }),
    new DiscordAdapter({ token: process.env.DISCORD_TOKEN }),
  ],
});

bot.on('message', async (thread) => {
  const tenant = await resolveTenant(thread.platformUserId);
  const stream = await invokeAgent(tenant.id, thread.text);
  await thread.post(stream); // Renders natively per platform
});
```

## Alternatives Considered

### Alternative 1: Vercel AI SDK + SSE Bridge (Selected)
Vercel's Chat SDK with custom AgentCore adapter.

**Pros:**
- ✅ **23+ platform adapters**: Slack, Discord, Teams, Telegram, WhatsApp, etc.
- ✅ **JSX for rich UI**: Define cards once, render natively per platform
- ✅ **Streaming-first**: Built for real-time token streaming
- ✅ **Open-source**: MIT license, active community
- ✅ **Well-documented**: Comprehensive docs and examples
- ✅ **Identity linking**: Built-in user identity resolution
- ✅ **Low operational cost**: Run on ECS Fargate (~$50/mo)

**Cons:**
- Need custom SSE Bridge to translate AgentCore → Vercel format (3-day build)
- Vercel-specific JSX format (mitigated by simplicity)

**Verdict:** Selected for comprehensive platform support and streaming.

### Alternative 2: Custom Gateway (OpenClaw-style)
Port OpenClaw's Gateway daemon to AWS.

**Pros:**
- Preserves OpenClaw's 23+ platform support
- Team familiar with architecture
- Proven in production

**Cons:**
- ❌ **Tightly coupled to Pi runtime**: Assumes filesystem, not MicroVM-friendly
- ❌ **Maintenance burden**: Need to maintain 23+ platform adapters ourselves
- ❌ **No streaming**: OpenClaw Gateway is request-response, not SSE
- ❌ **Time investment**: 8-12 weeks to port and maintain

**Verdict:** Rejected - too much maintenance burden.

### Alternative 3: Bolt Framework (Slack only)
Slack's official Bolt framework for Node.js.

**Pros:**
- Official Slack support
- Rich feature set for Slack
- Well-documented

**Cons:**
- ❌ **Slack-only**: Need separate frameworks for Discord, Teams, etc.
- ❌ **No unified API**: Different code per platform
- ❌ **No streaming**: Bolt is request-response
- ❌ **No JSX cards**: Manual JSON payload construction

**Verdict:** Rejected - single platform only.

### Alternative 4: BotPress / Botkit
Open-source bot frameworks.

**Pros:**
- Support multiple platforms
- Visual flow builder (BotPress)

**Cons:**
- ❌ **No streaming**: Traditional request-response architecture
- ❌ **Heavy**: BotPress requires PostgreSQL, Redis
- ❌ **Outdated**: Botkit deprecated, BotPress pivoting away from multi-platform
- ❌ **No AgentCore integration**

**Verdict:** Rejected - outdated, no streaming.

### Alternative 5: AWS Lex + Lambda
Use AWS Lex for chat, Lambda for logic.

**Pros:**
- AWS-native
- Managed service
- Voice support

**Cons:**
- ❌ **Lex is for chatbots, not agents**: Assumes intents/slots, not freeform conversation
- ❌ **No streaming**: Lex is request-response
- ❌ **Limited platforms**: Slack, Facebook, Twilio (not Discord, Teams, Telegram)
- ❌ **Not designed for LLM agents**: Built for pre-LLM era

**Verdict:** Rejected - wrong abstraction for LLM agents.

## Consequences

### Positive

- **Rapid platform expansion**: Add new platform by installing adapter (npm install)
- **Consistent UX**: JSX cards render natively (Slack blocks, Discord embeds, Teams adaptive cards)
- **Real-time streaming**: Tokens appear in chat UI immediately
- **Identity linking**: Users can switch platforms mid-conversation
- **Open-source**: Can fork/customize if needed
- **Low operational cost**: ECS Fargate service costs ~$50/mo for 1000 tenants

### Negative

- **SSE Bridge maintenance**: Need to maintain translation layer (mitigated by simplicity)
- **Vercel dependency**: Tight coupling to Vercel Chat SDK (mitigated by open-source nature)
- **Learning curve**: Team needs to learn JSX for chat cards (similar to React)

### Risks

- **Vercel SDK deprecation**: If Vercel stops maintaining Chat SDK (mitigated by open-source - can fork)
- **Platform API changes**: Slack, Discord APIs change, need SDK updates (Vercel team handles this)

## Evidence

- **Research**: [docs/research/agentcore-strands/07-Vercel-AI-SDK-Chat-Layer.md](../../research/agentcore-strands/07-Vercel-AI-SDK-Chat-Layer.md) - 1760 lines on Vercel Chat SDK
- **OpenClaw Gateway**: [docs/research/openclaw-nemoclaw-openfang/07-Chat-Interface-Multi-Platform.md](../../research/openclaw-nemoclaw-openfang/07-Chat-Interface-Multi-Platform.md) - 1483 lines on 23+ platforms
- **Definitive Architecture**: Lines 134-160 show Vercel Chat SDK architecture
- **Mulch record mx-78e5ff**: "8-stack CDK architecture includes Chat stack with Vercel SDK on Fargate"

## Related Decisions

- **ADR-003** (Strands): Strands agents stream responses that SSE Bridge delivers to Vercel SDK
- **ADR-005** (CDK): ECS Fargate Chat Gateway deployed via CDK Chat Stack
- **ADR-007** (AgentCore MicroVM): AgentCore Runtime generates SSE streams consumed by SSE Bridge

## References

1. Vercel AI SDK: https://sdk.vercel.ai/docs
2. Data Stream Protocol: https://sdk.vercel.ai/docs/ai-sdk-ui/stream-protocol
3. Chat SDK adapters: https://github.com/vercel/ai/tree/main/packages/chat
4. OpenClaw Gateway (for comparison): https://github.com/openclaw/gateway
