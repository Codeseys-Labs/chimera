---
title: "Discord, Microsoft Teams, and Telegram Adapter Research"
version: 1.0.0
status: research
last_updated: 2026-03-22
task: chimera-6953
author: builder-research-doc
---

# Discord, Microsoft Teams, and Telegram Adapter Research

**Status:** Research only — implementation recommendations

**Objective:** Investigate integration requirements for Discord, Microsoft Teams, and Telegram as chat platform adapters for AWS Chimera, following the established `PlatformAdapter` pattern used by the existing Slack implementation.

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Existing Architecture Review](#existing-architecture-review)
3. [Discord.js Integration](#discordjs-integration)
4. [Microsoft Teams Bot Framework](#microsoft-teams-bot-framework)
5. [Telegram Bot API](#telegram-bot-api)
6. [User Pairing Strategy](#user-pairing-strategy)
7. [Implementation Effort Estimates](#implementation-effort-estimates)
8. [Recommendations](#recommendations)

---

## Executive Summary

All three platforms (Discord, Microsoft Teams, Telegram) can be integrated into AWS Chimera using the existing `PlatformAdapter` interface pattern. Each requires:

1. **Bot/app registration** on the platform
2. **Webhook endpoints** for receiving events
3. **Platform-specific adapter** implementing `parseIncoming()` and `formatResponse()`
4. **User pairing** mapping platform user IDs to Cognito identities
5. **Signature verification** for webhook security

**Complexity Ranking (Low to High):**
1. **Telegram** (simplest) — REST API, straightforward webhook model, no OAuth
2. **Discord** (moderate) — WebSocket + REST, rich formatting, OAuth2
3. **Microsoft Teams** (complex) — Bot Framework SDK, Azure AD, adaptive cards, app registration

**Recommended Implementation Order:** Telegram → Discord → Teams

---

## Existing Architecture Review

### Current Slack Implementation

The Chimera codebase already has a working Slack adapter that establishes the pattern:

**Key Files:**
- `packages/chat-gateway/src/adapters/slack.ts` — Slack platform adapter
- `packages/chat-gateway/src/routes/slack.ts` — Webhook routes
- `packages/core/src/auth/user-pairing.ts` — Platform user → Cognito mapping

**Adapter Pattern:**
```typescript
export interface PlatformAdapter {
  readonly platform: string;
  parseIncoming(body: unknown): ChatMessage[];
  formatResponse(content: string, context: TenantContext): unknown;
}
```

**Key Insights from Slack Implementation:**
- **Signature verification** prevents unauthorized requests (HMAC-SHA256)
- **URL verification challenge** required for webhook registration
- **User resolution middleware** maps Slack user IDs to Cognito users
- **Block Kit formatting** for rich messages with 3000-character limit per block
- **Slash commands** require response within 3 seconds
- **Environment-gated signature bypass** for development (fails closed in production)

---

## Discord.js Integration

### Overview

Discord is a popular chat platform for communities. The official `discord.js` library provides a comprehensive SDK for building Discord bots.

**Documentation:** https://discord.js.org/

### Bot Setup Requirements

1. **Create Discord Application**
   - Visit [Discord Developer Portal](https://discord.com/developers/applications)
   - Create new application
   - Navigate to "Bot" section and create bot user
   - Copy bot token (store in AWS Secrets Manager)

2. **Enable Required Intents**
   - `GUILDS` — Access to server information
   - `GUILD_MESSAGES` — Read messages in channels
   - `MESSAGE_CONTENT` — Access message text (privileged intent)
   - `DIRECT_MESSAGES` — Support DM conversations

3. **OAuth2 Permissions**
   - `bot` scope
   - `applications.commands` scope (for slash commands)
   - Permissions: `Send Messages`, `Read Messages`, `Use Slash Commands`

4. **Invite Bot to Server**
   - Generate OAuth2 URL with required scopes
   - Server admin installs bot
   - Bot appears in member list

### Integration Approach

**Two Options:**

#### Option A: WebSocket Gateway (discord.js)
Use the discord.js library to maintain a persistent WebSocket connection to Discord.

**Pros:**
- Real-time event delivery
- Rich library with TypeScript support
- Handles reconnection, rate limiting, caching automatically
- Easy slash command registration

**Cons:**
- Requires persistent process (ECS Fargate or Lambda + WebSocket)
- WebSocket connection overhead
- More complex than webhooks

**Implementation Pattern:**
```typescript
// packages/chat-gateway/src/connections/discord-gateway.ts
import { Client, GatewayIntentBits, Events } from 'discord.js';

export class DiscordGateway {
  private client: Client;

  constructor(token: string) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
      ]
    });
  }

  async connect() {
    this.client.on(Events.MessageCreate, this.handleMessage);
    this.client.on(Events.InteractionCreate, this.handleInteraction);
    await this.client.login(process.env.DISCORD_BOT_TOKEN);
  }

  private async handleMessage(message: Message) {
    // Route to adapter.parseIncoming()
  }
}
```

#### Option B: Interactions Endpoint (Webhook)
Use Discord's HTTP-based Interactions API for slash commands only.

**Pros:**
- Stateless (fits existing webhook model)
- No persistent connection
- Simpler infrastructure (API Gateway → Lambda)

**Cons:**
- Limited to slash commands (no message monitoring)
- Requires Ed25519 signature verification
- Less feature-complete than WebSocket approach

**Recommendation:** Option A (WebSocket Gateway) for full feature parity with Slack.

### Slash Commands

Discord supports application commands (slash commands) with rich parameter types.

**Registration:**
```typescript
// Register slash command globally
await rest.put(
  Routes.applicationCommands(clientId),
  {
    body: [
      {
        name: 'ai',
        description: 'Ask AWS Chimera AI a question',
        options: [
          {
            name: 'prompt',
            type: ApplicationCommandOptionType.String,
            description: 'Your question or request',
            required: true
          }
        ]
      }
    ]
  }
);
```

**Handling:**
```typescript
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'ai') {
    const prompt = interaction.options.getString('prompt', true);

    // Defer reply (Discord requires response within 3 seconds)
    await interaction.deferReply();

    // Process with agent
    const response = await processMessage(prompt);

    // Edit deferred reply with result
    await interaction.editReply(response);
  }
});
```

### Message Formatting (Embeds)

Discord supports rich embeds for formatted messages.

**Adapter Implementation:**
```typescript
// packages/chat-gateway/src/adapters/discord.ts
export class DiscordPlatformAdapter implements PlatformAdapter {
  readonly platform = 'discord';

  parseIncoming(body: unknown): ChatMessage[] {
    // Parse Discord message event or interaction
    const event = body as DiscordMessage | DiscordInteraction;

    if ('commandName' in event) {
      // Slash command
      return [{
        role: 'user',
        content: event.options.getString('prompt')
      }];
    } else {
      // Regular message
      return [{
        role: 'user',
        content: event.content
      }];
    }
  }

  formatResponse(content: string, _context: TenantContext): MessagePayload {
    // Discord allows up to 10 embeds, each with 4096 character description
    const chunks = this.chunkContent(content, 4096);

    return {
      embeds: chunks.map(chunk => ({
        description: chunk,
        color: 0x5865F2, // Discord blurple
        footer: {
          text: 'AWS Chimera'
        }
      }))
    };
  }

  private chunkContent(content: string, maxLength: number): string[] {
    // Similar to Slack adapter chunking
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    const paragraphs = content.split('\n\n');
    let currentChunk = '';

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxLength) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        for (let i = 0; i < paragraph.length; i += maxLength) {
          chunks.push(paragraph.slice(i, i + maxLength));
        }
      } else {
        if (currentChunk.length + paragraph.length + 2 > maxLength) {
          chunks.push(currentChunk.trim());
          currentChunk = paragraph + '\n\n';
        } else {
          currentChunk += paragraph + '\n\n';
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}
```

### Infrastructure Requirements

**ECS Fargate Service:**
- Long-running container for WebSocket connection
- Single task (bot has single identity)
- Auto-restart on connection failure
- Store bot token in Secrets Manager
- ALB health check endpoint

**Environment Variables:**
```bash
DISCORD_BOT_TOKEN=<from Secrets Manager>
DISCORD_APPLICATION_ID=<application ID>
DISCORD_PUBLIC_KEY=<for signature verification if using webhooks>
```

### Security Considerations

**Message Content Intent:**
- Privileged intent — requires verification for bots in 100+ servers
- Automatic approval for bots under 100 servers
- Chimera tenants will each have separate bot instances (under 100 servers each)

**Token Security:**
- Store bot token in AWS Secrets Manager
- Rotate tokens via IAM policy (90-day rotation)
- Never log token in CloudWatch

**Rate Limiting:**
- Global rate limit: 50 requests/second
- Per-route limits vary (e.g., 5 messages/5 seconds per channel)
- discord.js handles rate limiting automatically

---

## Microsoft Teams Bot Framework

### Overview

Microsoft Teams uses the Bot Framework for bot integrations. More complex than Discord/Telegram due to Azure ecosystem integration.

**Documentation:** https://learn.microsoft.com/en-us/microsoftteams/platform/bots/what-are-bots

### Bot Setup Requirements

1. **Register Bot in Azure Bot Service**
   - Create Azure Bot resource
   - Generate Microsoft App ID and password
   - Configure messaging endpoint (HTTPS required)
   - Store credentials in Secrets Manager

2. **Create Teams App Manifest**
   - Define bot capabilities (personal, team, groupchat)
   - Specify command list
   - Configure app icons and descriptions
   - Package as `.zip` file

3. **App Registration in Azure AD**
   - Create app registration for authentication
   - Configure redirect URIs for user consent flow
   - Grant API permissions (if needed for user context)

4. **Install App in Teams**
   - Upload app package to Teams admin center
   - Users install app via Teams app store
   - Bot appears in chat list

### Integration Approach

**Bot Framework SDK:**
Use the official `botbuilder` SDK for Node.js.

```typescript
// packages/chat-gateway/src/adapters/teams.ts
import {
  BotFrameworkAdapter,
  TurnContext,
  MessageFactory,
  CardFactory,
  Activity
} from 'botbuilder';

export class TeamsPlatformAdapter implements PlatformAdapter {
  readonly platform = 'teams';
  private adapter: BotFrameworkAdapter;

  constructor() {
    this.adapter = new BotFrameworkAdapter({
      appId: process.env.TEAMS_APP_ID,
      appPassword: process.env.TEAMS_APP_PASSWORD
    });
  }

  parseIncoming(body: unknown): ChatMessage[] {
    // Bot Framework sends Activity objects
    const activity = body as Activity;

    if (activity.type === 'message' && activity.text) {
      return [{
        role: 'user',
        content: activity.text
      }];
    }

    return [];
  }

  formatResponse(content: string, _context: TenantContext): Activity {
    // Teams supports Adaptive Cards for rich formatting
    const chunks = this.chunkContent(content, 5000); // Teams limit

    if (chunks.length === 1) {
      return MessageFactory.text(chunks[0]);
    }

    // For long messages, use Adaptive Card carousel
    return MessageFactory.carousel(
      chunks.map(chunk =>
        CardFactory.adaptiveCard({
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: chunk,
              wrap: true
            }
          ]
        })
      )
    );
  }

  private chunkContent(content: string, maxLength: number): string[] {
    // Similar chunking logic to Slack/Discord
    // ...
  }
}
```

### Webhook Endpoint

**Route Handler:**
```typescript
// packages/chat-gateway/src/routes/teams.ts
import { Router } from 'express';
import { TeamsAdapter } from '../adapters/teams';

const router = Router();
const adapter = new TeamsAdapter();

router.post('/teams/messages', async (req, res) => {
  // Bot Framework handles signature verification internally
  await adapter.processActivity(req, res, async (context) => {
    // Extract user and tenant context
    const teamsUserId = context.activity.from.aadObjectId;
    const tenantId = context.activity.conversation.tenantId;

    // Resolve user via UserPairingService
    const userContext = await resolveUser({
      platform: 'teams',
      platformUserId: teamsUserId
    });

    if (!userContext) {
      await context.sendActivity('Please authenticate first using /login');
      return;
    }

    // Parse message
    const messages = adapter.parseIncoming(context.activity);

    // Invoke agent
    const result = await agent.invoke(messages[0].content);

    // Send response
    const response = adapter.formatResponse(result.output, userContext);
    await context.sendActivity(response);
  });
});

export default router;
```

### Adaptive Cards

Teams supports Adaptive Cards for rich, interactive UI components.

**Example:**
```json
{
  "type": "AdaptiveCard",
  "version": "1.4",
  "body": [
    {
      "type": "TextBlock",
      "text": "Agent Response",
      "weight": "bolder",
      "size": "large"
    },
    {
      "type": "TextBlock",
      "text": "{{ agent_output }}",
      "wrap": true
    }
  ],
  "actions": [
    {
      "type": "Action.Submit",
      "title": "Follow up",
      "data": {
        "action": "followup"
      }
    }
  ]
}
```

**Use Cases:**
- Multi-turn conversations with buttons
- Form inputs for structured queries
- Confirmation dialogs for destructive actions

### Infrastructure Requirements

**ECS Fargate Service:**
- HTTP endpoint for Bot Framework callbacks
- ALB with HTTPS (required by Azure)
- Store app credentials in Secrets Manager

**Environment Variables:**
```bash
TEAMS_APP_ID=<Azure App ID>
TEAMS_APP_PASSWORD=<Azure App Password>
TEAMS_TENANT_ID=<Azure AD tenant ID>
```

**DNS:**
- Bot endpoint must be publicly accessible HTTPS
- Example: `https://api.chimera.example.com/teams/messages`

### Security Considerations

**JWT Validation:**
- Bot Framework sends JWT tokens in `Authorization` header
- SDK validates tokens automatically
- No custom signature verification needed (unlike Slack)

**Azure AD Integration:**
- Teams apps run in customer's Azure AD tenant
- User context includes Azure AD object ID
- Can leverage Azure AD groups for permissions

**Data Residency:**
- Bot Framework routes through Azure datacenters
- Ensure compliance with data sovereignty requirements
- Teams supports Government Cloud (GCC, GCC High)

---

## Telegram Bot API

### Overview

Telegram offers the simplest integration model of the three platforms. Pure REST API with webhook support, no SDK required (though libraries like `node-telegram-bot-api` simplify usage).

**Documentation:** https://core.telegram.org/bots/api

### Bot Setup Requirements

1. **Create Bot via BotFather**
   - Message `@BotFather` on Telegram
   - Use `/newbot` command
   - Choose username (must end in `bot`)
   - Receive bot token (store in Secrets Manager)

2. **Set Webhook**
   - Make HTTPS POST to `https://api.telegram.org/bot<token>/setWebhook`
   - Provide webhook URL (must be HTTPS)
   - Telegram sends updates to webhook URL

3. **Configure Commands** (Optional)
   - Use `/setcommands` with BotFather
   - Or set via API: `setMyCommands`

**That's it.** No OAuth, no Azure registration, no app manifest.

### Integration Approach

**Direct REST API** (no SDK required):

```typescript
// packages/chat-gateway/src/adapters/telegram.ts
export class TelegramPlatformAdapter implements PlatformAdapter {
  readonly platform = 'telegram';

  parseIncoming(body: unknown): ChatMessage[] {
    const update = body as TelegramUpdate;

    if (update.message && update.message.text) {
      // Regular message
      return [{
        role: 'user',
        content: update.message.text
      }];
    }

    if (update.callback_query && update.callback_query.data) {
      // Inline keyboard button press
      return [{
        role: 'user',
        content: update.callback_query.data
      }];
    }

    return [];
  }

  formatResponse(content: string, _context: TenantContext): TelegramMessage {
    const chunks = this.chunkContent(content, 4096); // Telegram limit

    return {
      text: chunks[0], // Send first chunk immediately
      parse_mode: 'Markdown',
      reply_markup: chunks.length > 1 ? {
        inline_keyboard: [[
          { text: 'Continue', callback_data: 'continue' }
        ]]
      } : undefined
    };
  }

  private chunkContent(content: string, maxLength: number): string[] {
    // Similar chunking to Slack/Discord
    // ...
  }
}
```

### Webhook Endpoint

```typescript
// packages/chat-gateway/src/routes/telegram.ts
import { Router } from 'express';
import { TelegramAdapter } from '../adapters/telegram';

const router = Router();
const adapter = new TelegramAdapter();

router.post('/telegram/webhook/:botToken', async (req, res) => {
  try {
    // Verify webhook request authenticity
    const providedToken = req.params.botToken;
    const expectedToken = process.env.TELEGRAM_BOT_TOKEN;

    if (providedToken !== expectedToken) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const update = req.body as TelegramUpdate;

    // Extract user context
    const telegramUserId = update.message?.from?.id || update.callback_query?.from?.id;
    const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;

    if (!telegramUserId || !chatId) {
      res.status(200).json({ ok: true });
      return;
    }

    // Resolve user
    const userContext = await resolveUser({
      platform: 'telegram',
      platformUserId: String(telegramUserId)
    });

    if (!userContext) {
      await sendTelegramMessage(chatId, 'Please authenticate first: /login');
      res.status(200).json({ ok: true });
      return;
    }

    // Parse message
    const messages = adapter.parseIncoming(update);

    if (messages.length === 0) {
      res.status(200).json({ ok: true });
      return;
    }

    // Invoke agent
    const result = await agent.invoke(messages[0].content);

    // Send response
    const response = adapter.formatResponse(result.output, userContext);
    await sendTelegramMessage(chatId, response.text, response.reply_markup);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    res.status(200).json({ ok: true }); // Always 200 to prevent retries
  }
});

async function sendTelegramMessage(chatId: number, text: string, replyMarkup?: any) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      reply_markup: replyMarkup
    })
  });
}

export default router;
```

### Inline Keyboards

Telegram supports inline keyboards (buttons attached to messages).

**Example:**
```typescript
const response = {
  text: 'Choose an action:',
  reply_markup: {
    inline_keyboard: [
      [
        { text: 'Deploy to Dev', callback_data: 'deploy:dev' },
        { text: 'Deploy to Prod', callback_data: 'deploy:prod' }
      ],
      [
        { text: 'Cancel', callback_data: 'cancel' }
      ]
    ]
  }
};
```

**Handling Button Clicks:**
```typescript
if (update.callback_query) {
  const data = update.callback_query.data;

  if (data.startsWith('deploy:')) {
    const env = data.split(':')[1];
    // Handle deployment
  }

  // Answer callback to remove loading state
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: update.callback_query.id,
      text: 'Processing...'
    })
  });
}
```

### Infrastructure Requirements

**Simplest of the Three:**
- API Gateway → Lambda (or ALB → ECS)
- HTTPS endpoint only (Telegram validates SSL certificate)
- No persistent connection required
- Store bot token in Secrets Manager

**Environment Variables:**
```bash
TELEGRAM_BOT_TOKEN=<bot token from BotFather>
```

**Webhook Setup (one-time):**
```bash
curl -X POST "https://api.telegram.org/bot<token>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://api.chimera.example.com/telegram/webhook/<token>"}'
```

### Security Considerations

**Token in URL Path:**
- Using bot token in webhook path acts as shared secret
- Only Telegram knows the token (never exposed to users)
- Alternative: use separate secret and validate `X-Telegram-Bot-Api-Secret-Token` header

**Rate Limiting:**
- Telegram rate limits by IP and bot
- 30 messages/second per bot
- 20 messages/minute per chat

**SSL Certificate:**
- Telegram validates SSL certificate on webhook URL
- Self-signed certs supported for testing (upload CA cert)
- Production: use valid Let's Encrypt or commercial cert

---

## User Pairing Strategy

All three platforms require mapping platform user IDs to Cognito user identities. The existing `UserPairingService` can be extended without changes.

### Current Schema

**DynamoDB Table:** `chimera-user-pairings`

```
PK: USER_PAIRING#{platform}#{platformUserId}
SK: COGNITO#{cognitoSub}
GSI1-PK: TENANT#{tenantId}
GSI1-SK: USER_PAIRING#{platform}#{platformUserId}

Attributes:
- tenantId: string
- platform: 'slack' | 'discord' | 'teams' | 'telegram'
- platformUserId: string (Slack: U123456, Discord: 123456789, Teams: AAD Object ID, Telegram: 123456789)
- cognitoSub: string
- cognitoUsername: string
- email: string
- displayName: string
- avatarUrl: string
- status: 'active' | 'revoked'
- createdAt: ISO 8601 timestamp
- updatedAt: ISO 8601 timestamp
```

### Platform User ID Formats

| Platform | User ID Format | Example | Where to Find |
|----------|---------------|---------|---------------|
| Slack | `U` + 8 chars | `U12345678` | `event.user` or `command.user_id` |
| Discord | Snowflake (18-19 digits) | `123456789012345678` | `user.id` or `interaction.user.id` |
| Teams | Azure AD Object ID (GUID) | `12345678-1234-1234-1234-123456789012` | `activity.from.aadObjectId` |
| Telegram | Integer user ID | `123456789` | `message.from.id` |

### Pairing Flow

**Initial Pairing (One-Time Setup):**

1. **User initiates pairing**
   - Discord: `/login` slash command
   - Teams: `/login` command
   - Telegram: `/login` command

2. **Generate OAuth URL**
   - Agent sends Cognito Hosted UI URL with PKCE flow
   - State parameter includes platform + platformUserId
   - Example: `https://cognito.example.com/oauth2/authorize?state=discord_123456789`

3. **User completes OAuth**
   - Cognito redirects to callback URL
   - Lambda extracts state parameter
   - Creates user pairing in DynamoDB

4. **Confirmation**
   - Agent sends confirmation message
   - Example: "✅ Linked to user@example.com"

**Subsequent Interactions:**

1. **Message arrives from platform**
2. **Middleware resolves platform user → Cognito user**
   ```typescript
   const userContext = await userPairingService.resolveUser({
     platform: 'discord',
     platformUserId: '123456789'
   });
   ```
3. **Agent inherits Cognito user's permissions**
4. **Response sent back to platform**

### Multi-Tenancy Considerations

**Per-Tenant Bot Instances:**
- Each tenant gets their own bot token (stored in DynamoDB `chimera-tenants` table)
- Bot token fetched based on tenant context
- User pairing scoped to tenant (GSI1-PK: `TENANT#{tenantId}`)

**Tenant Resolution:**
- **Slack:** `team_id` maps to tenant
- **Discord:** Server/guild ID maps to tenant (stored in tenant config)
- **Teams:** Azure AD tenant ID maps to Chimera tenant
- **Telegram:** Bot token itself identifies tenant (each tenant's bot has unique token)

### Authentication Flow Implementation

**Lambda Function: `user-pairing-callback`**

```typescript
// packages/auth-functions/user-pairing-callback/index.ts
export async function handler(event: APIGatewayProxyEvent) {
  const { code, state } = event.queryStringParameters || {};

  if (!code || !state) {
    return { statusCode: 400, body: 'Missing code or state' };
  }

  // Decode state: format is "platform_userId_tenantId"
  const [platform, platformUserId, tenantId] = state.split('_');

  // Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code);

  // Get Cognito user info
  const userInfo = await getCognitoUserInfo(tokens.access_token);

  // Create pairing
  await userPairingService.createPairing({
    tenantId,
    platform,
    platformUserId,
    cognitoSub: userInfo.sub,
    cognitoUsername: userInfo.username,
    email: userInfo.email,
    displayName: userInfo.name,
    avatarUrl: userInfo.picture
  });

  // Send confirmation to platform
  await sendPlatformMessage(platform, platformUserId, '✅ Successfully linked!');

  return {
    statusCode: 200,
    body: '<html><body>You can close this window.</body></html>'
  };
}
```

---

## Implementation Effort Estimates

### Discord.js Integration

**Estimated Effort:** 3-5 days

**Tasks:**
1. **Day 1: Adapter Implementation**
   - Create `DiscordPlatformAdapter` class
   - Implement `parseIncoming()` for message events and interactions
   - Implement `formatResponse()` with embed formatting
   - Write unit tests for adapter

2. **Day 2: WebSocket Gateway**
   - Set up discord.js client with intents
   - Implement event handlers (MessageCreate, InteractionCreate)
   - Handle connection lifecycle (connect, disconnect, reconnect)
   - Add CloudWatch logging for events

3. **Day 3: Slash Commands**
   - Register `/ai` slash command
   - Implement command handler with deferred replies
   - Add command options (prompt, model, etc.)
   - Test command in development server

4. **Day 4: Infrastructure**
   - Create ECS task definition for Discord gateway
   - Set up Secrets Manager for bot token
   - Configure ALB health check
   - Deploy to dev environment

5. **Day 5: User Pairing**
   - Add Discord platform to user pairing flow
   - Test OAuth callback for Discord users
   - Integration testing with Cognito
   - Documentation

**Dependencies:**
- `discord.js` (v14+)
- ECS Fargate service for WebSocket connection
- Secrets Manager for bot token

**Risks:**
- Message Content intent requires verification for 100+ server bots
- WebSocket connection stability (mitigate with auto-restart)

---

### Microsoft Teams Bot Framework

**Estimated Effort:** 5-7 days

**Tasks:**
1. **Day 1: Azure Bot Setup**
   - Create Azure Bot resource
   - Register app in Azure AD
   - Generate app credentials
   - Store credentials in Secrets Manager

2. **Day 2: Adapter Implementation**
   - Create `TeamsPlatformAdapter` class
   - Implement `parseIncoming()` for Activity objects
   - Implement `formatResponse()` with Adaptive Cards
   - Write unit tests

3. **Day 3: Bot Framework Integration**
   - Set up BotFrameworkAdapter
   - Implement activity handler
   - Add proactive messaging support
   - Handle conversation updates (bot added/removed)

4. **Day 4: Teams App Manifest**
   - Create app manifest JSON
   - Define bot capabilities and commands
   - Add app icons and descriptions
   - Package as `.zip` file

5. **Day 5: Webhook Endpoint**
   - Create Express route for Bot Framework callbacks
   - Integrate with user pairing middleware
   - Add error handling and logging
   - Deploy to dev environment

6. **Day 6: Adaptive Cards**
   - Design Adaptive Card templates for responses
   - Implement card rendering logic
   - Add interactive buttons for common actions
   - Test cards in Teams desktop and mobile

7. **Day 7: Testing & Documentation**
   - Install app in test Teams environment
   - End-to-end testing with user pairing
   - Document setup process for tenants
   - Create runbook for troubleshooting

**Dependencies:**
- `botbuilder` SDK (v4+)
- Azure Bot Service account
- Azure AD app registration
- HTTPS endpoint (ALB with ACM certificate)

**Risks:**
- Complex Azure ecosystem (App Registration, Bot Service, Teams Admin)
- Customer Azure AD tenant trust required
- Adaptive Card versioning compatibility

---

### Telegram Bot API

**Estimated Effort:** 2-3 days

**Tasks:**
1. **Day 1: Adapter Implementation**
   - Create `TelegramPlatformAdapter` class
   - Implement `parseIncoming()` for updates
   - Implement `formatResponse()` with Markdown
   - Add inline keyboard support
   - Write unit tests

2. **Day 2: Webhook Endpoint**
   - Create Express route for Telegram webhooks
   - Implement token-based authentication
   - Add message sending helper function
   - Integrate with user pairing middleware
   - Deploy to dev environment

3. **Day 3: Testing & Commands**
   - Register bot with BotFather
   - Set webhook URL
   - Configure bot commands (`/start`, `/login`, `/help`)
   - End-to-end testing
   - Documentation

**Dependencies:**
- No external SDK required (use native fetch API)
- HTTPS endpoint (API Gateway or ALB)
- Secrets Manager for bot token

**Risks:**
- Minimal — Telegram has the simplest API of the three

---

### Summary Table

| Platform | Effort | Complexity | Infrastructure | Key Dependencies |
|----------|--------|------------|----------------|------------------|
| **Telegram** | 2-3 days | Low | API Gateway or ALB | Secrets Manager |
| **Discord** | 3-5 days | Medium | ECS Fargate + ALB | discord.js, Secrets Manager |
| **Teams** | 5-7 days | High | ALB + HTTPS + Azure | botbuilder, Azure Bot Service, Azure AD |

---

## Recommendations

### 1. Implement in Order: Telegram → Discord → Teams

**Rationale:**
- Start with simplest (Telegram) to validate adapter pattern
- Discord provides feature parity with Slack
- Teams last due to Azure ecosystem complexity

### 2. Reuse Existing Patterns

**Leverage Slack Implementation:**
- `PlatformAdapter` interface requires no changes
- `UserPairingService` supports all platforms via `platform` field
- Webhook route structure is consistent
- User resolution middleware is reusable

### 3. Infrastructure Recommendations

**Telegram:**
- Use API Gateway + Lambda for stateless webhook handling
- Simplest architecture, lowest cost

**Discord:**
- Use ECS Fargate with single task
- WebSocket connection requires persistent process
- Auto-restart on failure via ECS health checks

**Teams:**
- Use ALB + ECS Fargate
- HTTPS required by Azure
- ACM certificate for domain validation

### 4. Security Best Practices

**All Platforms:**
- Store bot tokens/credentials in AWS Secrets Manager
- Rotate tokens via IAM policy (90-day rotation)
- Enable CloudWatch alarms for webhook failures
- Fail closed on authentication errors

**Signature Verification:**
- Slack: HMAC-SHA256
- Discord: Ed25519 (if using webhook mode)
- Teams: JWT validation (handled by SDK)
- Telegram: Token in URL path or secret header

### 5. User Pairing Flow

**Cognito Hosted UI Integration:**
- Generate OAuth URL with state parameter encoding platform + user ID
- Lambda callback creates pairing in DynamoDB
- Send confirmation message back to platform
- Handle pairing revocation via admin UI

**Multi-Tenancy:**
- Per-tenant bot tokens stored in `chimera-tenants` table
- User pairing scoped to tenant via GSI1-PK
- Platform → tenant mapping:
  - Slack: `team_id` → `tenantId`
  - Discord: `guild_id` → `tenantId` (stored in tenant config)
  - Teams: Azure AD tenant → `tenantId`
  - Telegram: Bot token → `tenantId` (1:1 mapping)

### 6. Testing Strategy

**Unit Tests:**
- Adapter `parseIncoming()` with various payload formats
- Adapter `formatResponse()` with chunking edge cases
- User pairing resolution logic

**Integration Tests:**
- End-to-end message flow (platform → agent → response)
- OAuth callback with valid/invalid state
- Multi-tenant isolation (user can't access other tenant's agent)

**Manual Testing:**
- Create test bots on each platform
- Test slash commands, regular messages, interactive components
- Verify signature verification rejects unauthorized requests
- Test rate limiting and error handling

### 7. Documentation Requirements

**For Each Platform:**
- Bot setup guide (with screenshots)
- Environment variable reference
- Webhook endpoint configuration
- User pairing flow diagram
- Troubleshooting common issues

**Admin Documentation:**
- How to create tenant-specific bot
- How to rotate bot credentials
- How to monitor webhook health
- How to handle platform API changes

### 8. Monitoring & Observability

**CloudWatch Metrics:**
- `WebhookRequests` (count by platform)
- `WebhookErrors` (count by error type)
- `UserPairingCreations` (count by platform)
- `MessageProcessingLatency` (p50, p99)

**CloudWatch Alarms:**
- Webhook error rate > 5% for 5 minutes
- User pairing lookup failures > 10/minute
- Discord WebSocket disconnections (alert on-call)

**Logs:**
- Structured JSON logs with `platform`, `tenantId`, `userId`
- Include correlation ID for request tracing
- Redact sensitive data (bot tokens, user PII)

---

## Appendix: Platform Comparison Matrix

| Feature | Slack | Discord | Teams | Telegram |
|---------|-------|---------|-------|----------|
| **Bot Setup** | App + OAuth | Developer Portal | Azure Bot + AD | BotFather |
| **Integration Model** | Events API + Webhooks | WebSocket Gateway | Bot Framework SDK | Webhooks |
| **Message Format** | Block Kit | Embeds | Adaptive Cards | Markdown + Inline Keyboards |
| **Character Limit** | 3000/block | 4096/embed desc | 5000/message | 4096/message |
| **Slash Commands** | Yes | Yes | Yes | Yes |
| **Signature Verification** | HMAC-SHA256 | Ed25519 | JWT (SDK) | Token-based |
| **User ID Format** | U12345678 | 123456789012345678 | GUID | 123456789 |
| **OAuth Support** | Yes | Yes | Yes (Azure AD) | No |
| **Persistent Connection** | No | Yes | No | No |
| **Infrastructure** | API Gateway + Lambda | ECS Fargate | ALB + ECS | API Gateway + Lambda |
| **Estimated Effort** | ✅ Done | 3-5 days | 5-7 days | 2-3 days |
| **Complexity** | Medium | Medium | High | Low |

---

## Next Steps

1. **Prioritize Platform:** Align with product team on which platform to implement first
2. **Spike Telegram:** 1-day spike to validate adapter pattern with simplest platform
3. **Design Review:** Review adapter implementations with security team
4. **Infrastructure Planning:** Provision ECS Fargate for Discord gateway
5. **User Pairing UX:** Design OAuth flow user experience for each platform

---

**Research Completed:** 2026-03-22
**Next Review:** After first platform implementation (Telegram recommended)
