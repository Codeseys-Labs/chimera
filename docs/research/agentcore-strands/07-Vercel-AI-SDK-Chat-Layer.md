# 07 - Vercel AI SDK & Chat SDK as Communication Layer

> **Research Date:** 2026-03-19
> **Sources:** DeepWiki (vercel/ai, vercel/chat), Vercel official docs, AI SDK 6 blog post, Chat SDK changelog, community articles, GitHub discussions
> **Related:** [[04-Strands-Agents-Core]], [[09-Multi-Provider-LLM-Support]], [[01-AgentCore-Architecture-Runtime]]

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [AI SDK Architecture Overview](#ai-sdk-architecture-overview)
3. [AI SDK Core - Text Generation & Streaming](#ai-sdk-core---text-generation--streaming)
4. [Provider Ecosystem & Multi-Provider Support](#provider-ecosystem--multi-provider-support)
5. [Amazon Bedrock Provider](#amazon-bedrock-provider)
6. [Chat SDK UI - useChat & useCompletion Hooks](#chat-sdk-ui---usechat--usecompletion-hooks)
7. [Framework-Agnostic Chat Architecture](#framework-agnostic-chat-architecture)
8. [Streaming Protocol - Data Stream Protocol](#streaming-protocol---data-stream-protocol)
9. [Tool Calling & Structured Output](#tool-calling--structured-output)
10. [AI SDK 6 - Agent Abstraction & ToolLoopAgent](#ai-sdk-6---agent-abstraction--toolloopagent)
11. [MCP (Model Context Protocol) Integration](#mcp-model-context-protocol-integration)
12. [Middleware System & Observability](#middleware-system--observability)
13. [Custom Backend Integration Patterns](#custom-backend-integration-patterns)
14. [Chat SDK (vercel/chat) - Multi-Platform Communication](#chat-sdk-vercelchat---multi-platform-communication)
15. [Using AI SDK as a Universal Chat Layer](#using-ai-sdk-as-a-universal-chat-layer)
16. [Integration with AWS & Strands Agents](#integration-with-aws--strands-agents)
17. [Code Examples](#code-examples)
18. [Comparison & Trade-offs](#comparison--trade-offs)
19. [Sources & References](#sources--references)

---

## Executive Summary

The **Vercel AI SDK** (`ai` package) is the leading TypeScript toolkit for building AI-powered applications, with over **20 million monthly downloads**. It provides a unified API across 15+ LLM providers (including Amazon Bedrock), seamless streaming, tool calling, structured output, and multi-step agent loops. Combined with the new **Chat SDK** (`chat` package), it forms a comprehensive communication layer that can bridge AI agents to web UIs, Slack, Microsoft Teams, Discord, Google Chat, GitHub, Linear, Telegram, and WhatsApp.

**Why this matters for our agent platform:**

- **Provider abstraction:** Write agent logic once, swap LLM providers (Bedrock, OpenAI, Anthropic, etc.) with a single line change
- **Streaming protocol:** A well-defined SSE-based protocol that any backend (Node.js, Python, Go) can implement
- **Multi-platform delivery:** Chat SDK enables deploying the same bot logic to Slack, Teams, Discord, and 5+ other platforms
- **Framework agnostic:** Works with Next.js, Express, Fastify, Hono, NestJS, or any HTTP server
- **Agent-first:** AI SDK 6 introduces `ToolLoopAgent` with built-in tool approval, multi-step execution, and MCP support

**Key packages:**

| Package | Purpose | Version |
|---------|---------|---------|
| `ai` | Core SDK - text generation, streaming, tools, agents | 6.x |
| `@ai-sdk/react` | React hooks (useChat, useCompletion, useObject) | Latest |
| `@ai-sdk/svelte` | Svelte integration | Latest |
| `@ai-sdk/vue` | Vue integration | Latest |
| `@ai-sdk/solid` | SolidJS integration | Latest |
| `@ai-sdk/amazon-bedrock` | Amazon Bedrock provider | 2.x |
| `@ai-sdk/openai` | OpenAI provider | Latest |
| `@ai-sdk/anthropic` | Anthropic provider | Latest |
| `chat` | Multi-platform Chat SDK | 4.x |

---

## AI SDK Architecture Overview

The AI SDK uses a **three-layered architecture** that cleanly separates concerns:

### Layer 1: Core SDK (`ai` package)

Framework-agnostic functions for interacting with LLMs:

- `generateText()` / `streamText()` - Text generation
- `generateObject()` / `streamObject()` - Structured output
- `tool()` - Tool definitions with Zod schemas
- `ToolLoopAgent` - Multi-step agent loops
- Provider-V3 specification interfaces
- Shared utilities for HTTP communication and streaming

### Layer 2: UI Framework Integration

Reactive state management for multiple frontend frameworks:

- `@ai-sdk/react` - React hooks (`useChat`, `useCompletion`, `useObject`)
- `@ai-sdk/svelte` - Svelte stores
- `@ai-sdk/vue` - Vue composables
- `@ai-sdk/solid` - SolidJS primitives
- `@ai-sdk/rsc` - React Server Components

### Layer 3: Provider Implementations

Concrete implementations of the Provider-V3 specification:

- 15+ official providers (OpenAI, Anthropic, Google, Bedrock, Azure, Mistral, etc.)
- OpenAI-compatible provider for custom endpoints
- Community providers
- Provider registry for centralized management

### Monorepo Structure

```
vercel/ai/
  packages/
    ai/                     # Core SDK
    provider/               # Provider-V3 interfaces
    provider-utils/         # Shared provider utilities
    react/                  # @ai-sdk/react
    svelte/                 # @ai-sdk/svelte
    vue/                    # @ai-sdk/vue
    solid/                  # @ai-sdk/solid
    openai/                 # @ai-sdk/openai
    anthropic/              # @ai-sdk/anthropic
    google/                 # @ai-sdk/google
    amazon-bedrock/         # @ai-sdk/amazon-bedrock
    azure/                  # @ai-sdk/azure
    mistral/                # @ai-sdk/mistral
    ...                     # 10+ more providers
```

---

## AI SDK Core - Text Generation & Streaming

### generateText - Synchronous Generation

```typescript
import { generateText } from 'ai';

const { text, usage, finishReason } = await generateText({
  model: 'openai/gpt-4',
  prompt: 'Explain quantum entanglement.',
});
```

### streamText - Streaming Generation

```typescript
import { streamText } from 'ai';

const result = streamText({
  model: 'anthropic/claude-sonnet-4-20250514',
  messages: [
    { role: 'user', content: 'Write a poem about TypeScript.' },
  ],
});

// Multiple consumption options:
// 1. As a Response (for API routes)
return result.toUIMessageStreamResponse();

// 2. As a text stream
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}

// 3. Pipe to Node.js response
result.pipeUIMessageStreamToResponse(res);
```

### Key Features

- **Token-by-token streaming** with real-time UI updates
- **Automatic tool execution** within the streaming loop
- **Structured output** via Zod schemas
- **Multi-step generation** with `maxSteps`
- **Callbacks**: `onStepFinish`, `onFinish`, `onChunk`
- **Abort control** via AbortSignal

---

## Provider Ecosystem & Multi-Provider Support

### Provider-V3 Specification

All providers implement the `LanguageModelV3` interface, which defines:

```typescript
interface LanguageModelV3 {
  specificationVersion: 'v3';
  provider: string;
  modelId: string;

  doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult>;
  doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult>;
}
```

Key aspects:
- **Model metadata**: `provider`, `modelId`, `specificationVersion`
- **Core methods**: `doGenerate()` (non-streaming), `doStream()` (streaming)
- **Standardized prompt format**: `LanguageModelV3Prompt`
- **Tool calling**: JSON schema support via `LanguageModelV3FunctionTool`
- **Structured output**: Schema-validated responses
- **Consistent result types**: Uniform across all providers

### Supported Providers (15+)

| Provider | Package | Models |
|----------|---------|--------|
| OpenAI | `@ai-sdk/openai` | GPT-4, GPT-4o, o1, o3, etc. |
| Anthropic | `@ai-sdk/anthropic` | Claude 4, 3.5, 3 Opus/Sonnet/Haiku |
| Google | `@ai-sdk/google` | Gemini 2.5, 2.0, 1.5 |
| Amazon Bedrock | `@ai-sdk/amazon-bedrock` | Claude, Llama, Titan, etc. |
| Azure OpenAI | `@ai-sdk/azure` | GPT-4, GPT-4o via Azure |
| Mistral | `@ai-sdk/mistral` | Mistral Large, Medium, Small |
| xAI | `@ai-sdk/xai` | Grok |
| Groq | `@ai-sdk/groq` | Llama, Mixtral (fast inference) |
| Together.ai | `@ai-sdk/togetherai` | Open-source models |
| Fireworks | `@ai-sdk/fireworks` | Open-source models |
| DeepSeek | `@ai-sdk/deepseek` | DeepSeek V3, R1 |
| Cohere | `@ai-sdk/cohere` | Command R+ |
| Perplexity | `@ai-sdk/perplexity` | Sonar |
| DeepInfra | `@ai-sdk/deepinfra` | Various open-source |
| Cerebras | `@ai-sdk/cerebras` | Fast inference |

### Provider Registry

Centralized provider management with string-based model IDs:

```typescript
import { createProviderRegistry } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { bedrock } from '@ai-sdk/amazon-bedrock';

const registry = createProviderRegistry({
  openai,
  anthropic,
  bedrock,
});

// Use string IDs: "provider:model"
const result = await generateText({
  model: registry.languageModel('anthropic:claude-sonnet-4-20250514'),
  prompt: 'Hello!',
});

// Easy provider switching
const result2 = await generateText({
  model: registry.languageModel('bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0'),
  prompt: 'Hello!',
});
```

### Creating Custom Providers

To integrate a custom LLM backend:

1. Implement `LanguageModelV3` interface
2. Define `doGenerate()` and `doStream()` methods
3. Map AI SDK prompts to your API format
4. Handle tool calls and structured output
5. Use `@ai-sdk/openai-compatible` for OpenAI-compatible APIs

```typescript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const myProvider = createOpenAICompatible({
  baseURL: 'https://my-api.example.com/v1',
  name: 'my-provider',
});

const result = await generateText({
  model: myProvider('my-model-id'),
  prompt: 'Hello!',
});
```

---

## Amazon Bedrock Provider

The `@ai-sdk/amazon-bedrock` package provides native integration with Amazon Bedrock, which is critical for [[01-AgentCore-Architecture-Runtime]] and [[09-Multi-Provider-LLM-Support]].

### Setup

```typescript
import { bedrock } from '@ai-sdk/amazon-bedrock';
// OR for custom configuration:
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

const customBedrock = createAmazonBedrock({
  region: 'us-east-1',
  // Uses AWS credential chain by default
});
```

### Authentication Methods

1. **Environment variables** (recommended for Lambda/ECS):
   - `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`

2. **AWS SDK credential chain** (instance profiles, ECS roles):
   ```typescript
   import { fromNodeProviderChain } from '@aws-sdk/credential-providers';

   const bedrock = createAmazonBedrock({
     credentialProvider: fromNodeProviderChain(),
   });
   ```

3. **Bearer token** (for cross-account access):
   - `AWS_BEARER_TOKEN_BEDROCK` environment variable

### Supported Features

| Feature | Support |
|---------|---------|
| Streaming (`streamText`) | Full |
| Tool calling | Full |
| Structured output | Full (native via `output_config.format`) |
| Multi-step agents | Full |
| Image input | Model-dependent |
| File input (PDF) | Model-dependent |
| Guardrails | Full (Bedrock Guardrails) |
| Citations | Full |
| Cache points | Preview |
| Parallel tool calls | Full (streaming mode) |
| Embeddings | Full (`bedrock.embedding()`) |
| Reranking | Full (`bedrock.reranking()`) |

### Bedrock Anthropic Provider

For full feature parity with Anthropic's native API (including computer use, bash tool, text editor):

```typescript
import { bedrockAnthropic } from '@ai-sdk/amazon-bedrock';

const result = await generateText({
  model: bedrockAnthropic('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  tools: {
    computer: bedrockAnthropic.tools.computer_20241022({
      displayWidthPx: 1920,
      displayHeightPx: 1080,
    }),
  },
  prompt: 'Take a screenshot',
});
```

### Usage with Strands Agents

When building agents with [[04-Strands-Agents-Core]] that need a TypeScript frontend, the Bedrock provider enables seamless integration:

```typescript
// Backend: Strands Agent on Bedrock AgentCore
// Frontend: AI SDK consuming the agent's streaming endpoint

import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: 'https://your-agentcore-endpoint/invoke',
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }),
});
```

---

## Chat SDK UI - useChat & useCompletion Hooks

### useChat Hook

The primary hook for building conversational UIs. It manages chat state, streaming, tool calls, and UI updates automatically.

```typescript
'use client';
import { useChat } from '@ai-sdk/react';

export default function ChatPage() {
  const {
    messages,       // Array of UIMessage objects
    sendMessage,    // Send a new message
    status,         // 'submitted' | 'streaming' | 'ready' | 'error'
    stop,           // Abort current stream
    error,          // Error object if status === 'error'
    clearError,     // Clear error state
    resumeStream,   // Resume interrupted stream
    regenerate,     // Regenerate last assistant message
    addToolOutput,  // Provide tool execution results
  } = useChat();

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.role}:</strong>
          {msg.parts.map((part, i) => {
            if (part.type === 'text') return <p key={i}>{part.text}</p>;
            if (part.type === 'tool') return <ToolResult key={i} part={part} />;
            return null;
          })}
        </div>
      ))}
      <form onSubmit={(e) => {
        e.preventDefault();
        sendMessage({ text: input });
      }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
      </form>
    </div>
  );
}
```

### useCompletion Hook

For text completion (non-conversational) use cases:

```typescript
import { useCompletion } from '@ai-sdk/react';

const { completion, input, handleInputChange, handleSubmit } = useCompletion({
  api: '/api/completion',
});
```

### useObject Hook

For streaming structured JSON objects:

```typescript
import { useObject } from '@ai-sdk/react';

const { object, isLoading } = useObject({
  api: '/api/structured',
  schema: myZodSchema,
});
```

### Status Management

The `useChat` hook provides granular status tracking:

| Status | Meaning |
|--------|---------|
| `ready` | Idle, waiting for user input |
| `submitted` | Message sent, awaiting first token |
| `streaming` | Actively receiving tokens |
| `error` | An error occurred |

---

## Framework-Agnostic Chat Architecture

### Transport Layer

The AI SDK separates chat state management from communication through a **transport-based architecture**:

#### DefaultChatTransport (HTTP)

The default transport sends messages to an API endpoint via POST:

```typescript
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: '/api/chat',              // Custom endpoint
    headers: {
      Authorization: 'Bearer token',
    },
    body: {
      user_id: '123',
    },
    credentials: 'same-origin',
  }),
});
```

Features:
- Configurable endpoint URL
- Custom headers (static or dynamic via functions)
- Custom body fields
- Credential policies
- Processes SSE response stream into `UIMessageChunk` objects

#### DirectChatTransport (In-Process)

For server-side rendering, testing, or single-process applications:

```typescript
import { DirectChatTransport } from 'ai';

const { messages, sendMessage } = useChat({
  transport: new DirectChatTransport({
    agent: myAgent, // Directly invokes agent.stream()
  }),
});
```

This bypasses HTTP entirely - the agent runs in the same process.

#### Custom Transport

You can implement custom transports for any communication channel (WebSocket, gRPC, etc.):

```typescript
class WebSocketChatTransport {
  async sendMessage(messages, options) {
    // Send via WebSocket
    // Return a ReadableStream of UIMessageChunks
  }
}
```

### AbstractChat State Management

The `AbstractChat` class is the core state manager used by all framework hooks:

- **`id`**: Unique session identifier
- **`state`**: Contains `messages` array, `status`, and `error`
- **`messages`**: Array of `UIMessage` objects
- **`sendMessage()`**: Appends user message, triggers API call, processes stream
- **`regenerate()`**: Re-generates a specific or last assistant message
- **`addToolOutput()`**: Provides tool execution results back to the agent

### UIMessage Format

`UIMessage` is the primary data structure for conversations:

```typescript
interface UIMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  metadata?: unknown;
  parts: UIMessagePart[];
}

type UIMessagePart =
  | TextUIPart           // Natural language content
  | ReasoningUIPart      // Model's internal reasoning
  | ToolUIPart           // Tool call lifecycle (input, output, approval)
  | FileUIPart           // Attachments
  | SourceUrlUIPart      // URL references (RAG sources)
  | SourceDocumentUIPart // Document references
  | DataUIPart           // Custom typed data
  | StepStartUIPart;     // New generation step marker
```

This parts-based format is much richer than simple text messages, enabling:
- Interleaved text and tool calls
- Streaming reasoning (chain-of-thought)
- File attachments and citations
- Custom data overlays (weather widgets, charts, etc.)

---

## Streaming Protocol - Data Stream Protocol

The AI SDK defines a well-specified streaming protocol based on **Server-Sent Events (SSE)** that any backend can implement. This is the key to using AI SDK as a universal communication layer.

### Protocol Format

Each event is a JSON object sent as an SSE `data:` line:

```
data: {"type":"start","messageId":"msg_abc123"}

data: {"type":"text-start","id":"text_001"}

data: {"type":"text-delta","id":"text_001","delta":"Hello"}

data: {"type":"text-delta","id":"text_001","delta":" world"}

data: {"type":"text-end","id":"text_001"}

data: {"type":"finish","messageId":"msg_abc123","finishReason":"stop"}

data: [DONE]
```

### Required Header

When implementing a custom backend:

```
x-vercel-ai-ui-message-stream: v1
```

### Stream Part Types

#### Message Lifecycle

| Type | Purpose | Key Fields |
|------|---------|------------|
| `start` | Begin new message | `messageId` |
| `finish` | Complete message | `messageId`, `finishReason` |
| `abort` | Stream aborted | - |

#### Text Content

| Type | Purpose | Key Fields |
|------|---------|------------|
| `text-start` | Begin text block | `id` |
| `text-delta` | Incremental text | `id`, `delta` |
| `text-end` | Complete text block | `id` |

#### Tool Calls

| Type | Purpose | Key Fields |
|------|---------|------------|
| `tool-input-start` | Begin tool call | `id`, `toolName` |
| `tool-input-delta` | Incremental tool input JSON | `id`, `delta` |
| `tool-result` | Tool execution result | `id`, `result` |

#### Reasoning (Chain-of-Thought)

| Type | Purpose | Key Fields |
|------|---------|------------|
| `reasoning-start` | Begin reasoning block | `id` |
| `reasoning-delta` | Incremental reasoning | `id`, `delta` |
| `reasoning-end` | Complete reasoning | `id` |

#### Custom Data

| Type | Purpose | Key Fields |
|------|---------|------------|
| `source` | RAG source reference | `value` (url, title) |
| `data-*` | Custom data parts | `id`, `data`, `transient` |

### Data Part Reconciliation

Custom data parts support **reconciliation** - sending updates to the same `id` replaces the previous data:

```typescript
// Server side
writer.write({
  type: 'data-weather',
  id: 'weather-1',
  data: { city: 'SF', status: 'loading' },
});

// Later, update same part:
writer.write({
  type: 'data-weather',
  id: 'weather-1', // Same ID = update
  data: { city: 'SF', weather: 'sunny', status: 'success' },
});
```

### Transient Data Parts

Parts marked `transient: true` are shown during streaming but NOT persisted in message history:

```typescript
writer.write({
  type: 'data-notification',
  data: { message: 'Processing...', level: 'info' },
  transient: true, // Won't appear in saved messages
});
```

### Python Backend Implementation

The protocol can be implemented in any language. Community Python implementation:

```python
# Using py-ai-datastream (community package)
# Format: SSE with JSON objects

from fastapi import FastAPI
from fastapi.responses import StreamingResponse

app = FastAPI()

@app.post("/api/chat")
async def chat(request: Request):
    async def generate():
        yield 'data: {"type":"start","messageId":"msg_1"}\n\n'
        yield 'data: {"type":"text-start","id":"t1"}\n\n'

        async for chunk in llm_stream():
            yield f'data: {{"type":"text-delta","id":"t1","delta":"{chunk}"}}\n\n'

        yield 'data: {"type":"text-end","id":"t1"}\n\n'
        yield 'data: {"type":"finish","messageId":"msg_1","finishReason":"stop"}\n\n'
        yield 'data: [DONE]\n\n'

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"x-vercel-ai-ui-message-stream": "v1"},
    )
```

---

## Tool Calling & Structured Output

### Tool Definition

Tools are defined with Zod schemas for type-safe input validation:

```typescript
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('City name'),
    unit: z.enum(['celsius', 'fahrenheit']).optional(),
  }),
  execute: async ({ location, unit }) => {
    const weather = await fetchWeather(location);
    return { temperature: weather.temp, condition: weather.condition };
  },
});
```

### Using Tools with streamText

```typescript
const result = streamText({
  model: 'openai/gpt-4',
  messages,
  tools: {
    weather: weatherTool,
    search: searchTool,
    calculator: calculatorTool,
  },
  maxSteps: 5, // Allow multi-step tool usage
});
```

### Tool Approval (Human-in-the-Loop)

```typescript
const paymentTool = tool({
  description: 'Process a payment',
  inputSchema: z.object({
    amount: z.number(),
    currency: z.string(),
    recipient: z.string(),
  }),
  needsApproval: true, // Always require approval
  execute: async ({ amount, currency, recipient }) => {
    return await processPayment(amount, currency, recipient);
  },
});

// Dynamic approval based on arguments:
const transferTool = tool({
  description: 'Transfer funds',
  inputSchema: z.object({ amount: z.number(), to: z.string() }),
  needsApproval: async ({ amount }) => amount > 1000, // Only for large amounts
  execute: async ({ amount, to }) => { /* ... */ },
});
```

When approval is required, the SDK returns a `tool-approval-request` content part. The client must provide a `ToolApprovalResponse` to approve or deny.

### Structured Output

Generate typed, schema-validated data:

```typescript
import { generateObject, Output } from 'ai';

const { object } = await generateObject({
  model: 'openai/gpt-4',
  schema: z.object({
    recipe: z.object({
      name: z.string(),
      ingredients: z.array(z.string()),
      steps: z.array(z.string()),
    }),
  }),
  prompt: 'Generate a recipe for chocolate cake.',
});
// object is fully typed: { recipe: { name: string, ingredients: string[], steps: string[] } }
```

### Combining Tools with Structured Output

```typescript
const result = await generateText({
  model: 'openai/gpt-4',
  output: Output.object({
    schema: z.object({
      summary: z.string(),
      sentiment: z.enum(['positive', 'neutral', 'negative']),
    }),
  }),
  tools: {
    analyze: analyzeTool,
  },
  stopWhen: stepCountIs(5), // Account for extra step for structured output
  prompt: 'Analyze the sentiment of recent reviews.',
});
```

---

## AI SDK 6 - Agent Abstraction & ToolLoopAgent

AI SDK 6 (released December 2025) introduced a first-class agent abstraction. This is the most significant architectural change for agent-based applications.

### ToolLoopAgent

The `ToolLoopAgent` class provides a production-ready agent loop:

```typescript
import { ToolLoopAgent, stepCountIs, tool } from 'ai';

const researchAgent = new ToolLoopAgent({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a research assistant. Use tools to find information.',
  tools: {
    search: searchTool,
    readPage: readPageTool,
    summarize: summarizeTool,
  },
  stopWhen: stepCountIs(20), // Default: 20 steps max
  onStepFinish: ({ step, stepIndex }) => {
    console.log(`Step ${stepIndex}:`, step.text?.slice(0, 100));
  },
  onFinish: ({ text, usage }) => {
    console.log('Agent finished:', usage.totalTokens, 'tokens');
  },
});

// Synchronous execution
const { text, steps } = await researchAgent.generate({
  prompt: 'Research the latest developments in quantum computing.',
});

// Streaming execution
const stream = await researchAgent.stream({
  prompt: 'Research the latest developments in quantum computing.',
});
```

### Execution Flow

1. **Initialize** with model, tools, instructions
2. **Loop**: Send messages to LLM -> receive response
   - If text response + stop condition met -> **finish**
   - If tool call -> execute tool -> add result to context -> **continue loop**
   - If tool needs approval -> pause, return approval request
3. **Callbacks** fire at each step and on completion

### Stopping Conditions

| Condition | Description |
|-----------|-------------|
| `stepCountIs(n)` | Stop after exactly `n` steps |
| `hasToolCall(name)` | Stop when a specific tool is called |
| Custom function | `(step, stepIndex) => boolean` |

The loop also stops automatically when:
- Model returns a finish reason other than tool calls
- A tool lacks an `execute` function (forwarded to client)
- A tool call requires approval

### Dynamic Step Configuration with prepareStep

```typescript
const agent = new ToolLoopAgent({
  model: 'openai/gpt-4',
  tools: { search: searchTool, write: writeTool },
  prepareStep: ({ previousStep, stepIndex }) => {
    // Change tools or model per step
    if (stepIndex > 5) {
      return { tools: { write: writeTool } }; // Narrow tools after research phase
    }
    return {};
  },
});
```

---

## MCP (Model Context Protocol) Integration

AI SDK 6 includes MCP support, primarily through the OpenAI provider:

```typescript
import { openai } from '@ai-sdk/openai';

const result = await generateText({
  model: openai('gpt-4'),
  tools: {
    mcp: openai.tools.mcp({
      serverUrl: 'https://my-mcp-server.example.com',
      requireApproval: {
        // Granular approval control
        always: ['delete_*', 'write_*'],  // Always approve destructive ops
        never: ['read_*', 'search_*'],    // Auto-approve read-only ops
      },
    }),
  },
  prompt: 'Search for recent files and summarize them.',
});
```

This is a **provider-defined tool** that:
- Connects to MCP servers
- Automatically discovers available tools
- Routes tool calls to the MCP server
- Supports approval workflows for sensitive operations
- Executes server-side (by the LLM provider's infrastructure)

### MCP + ToolLoopAgent

```typescript
const agent = new ToolLoopAgent({
  model: openai('gpt-4'),
  tools: {
    mcp: openai.tools.mcp({
      serverUrl: 'https://mcp.example.com',
      requireApproval: 'never',
    }),
    localTool: myLocalTool,
  },
  stopWhen: stepCountIs(10),
});
```

---

## Middleware System & Observability

### Language Model Middleware

Intercept and modify LLM calls without changing application code:

```typescript
import { wrapLanguageModel } from 'ai';

const loggingMiddleware = {
  transformParams: async ({ params }) => {
    console.log('Params:', JSON.stringify(params));
    return params;
  },
  wrapGenerate: async ({ doGenerate, params }) => {
    const result = await doGenerate();
    console.log('Generated:', result.text?.slice(0, 100));
    return result;
  },
  wrapStream: async ({ doStream, params }) => {
    const { stream, ...rest } = await doStream();
    // Transform stream if needed
    return { stream, ...rest };
  },
};

const enhancedModel = wrapLanguageModel({
  model: openai('gpt-4'),
  middleware: loggingMiddleware,
});
```

### Built-in Middleware

| Middleware | Purpose |
|-----------|---------|
| `extractReasoningMiddleware` | Extract reasoning from tagged text |
| `extractJsonMiddleware` | Strip markdown code fences from JSON |
| `simulateStreamingMiddleware` | Simulate streaming for non-streaming models |
| `defaultSettingsMiddleware` | Apply default settings |
| `addToolInputExamplesMiddleware` | Add examples to tool descriptions |

### OpenTelemetry Telemetry

```typescript
const result = await generateText({
  model: 'openai/gpt-4',
  prompt: 'Hello!',
  experimental_telemetry: {
    isEnabled: true,
    functionId: 'my-chat-function',
    metadata: { userId: '123' },
  },
});
```

Tracked metrics:
- `ai.usage.inputTokens` / `ai.usage.outputTokens` / `ai.usage.totalTokens`
- `ai.usage.inputTokenDetails.cacheReadTokens` / `cacheWriteTokens`
- `ai.response.finishReason`
- `ai.response.model`
- `ai.response.text` / `ai.response.toolCalls`
- `gen_ai.*` standardized LLM span attributes

### Telemetry Integrations

Custom lifecycle hooks:

```typescript
const myIntegration: TelemetryIntegration = {
  onStart: ({ messages, model }) => { /* ... */ },
  onStepStart: ({ step }) => { /* ... */ },
  onToolCallStart: ({ toolName, args }) => { /* ... */ },
  onToolCallFinish: ({ toolName, result }) => { /* ... */ },
  onStepFinish: ({ step, usage }) => { /* ... */ },
  onFinish: ({ text, usage, finishReason }) => { /* ... */ },
};
```

---

## Custom Backend Integration Patterns

The AI SDK is explicitly designed to work with **any backend**, not just Vercel/Next.js.

### Express

```typescript
import express from 'express';
import { streamText, pipeUIMessageStreamToResponse } from 'ai';

const app = express();

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  const result = streamText({
    model: 'openai/gpt-4',
    messages,
  });

  pipeUIMessageStreamToResponse(result.toUIMessageStream(), res);
});
```

### Fastify

```typescript
import Fastify from 'fastify';
import { streamText } from 'ai';

const app = Fastify();

app.post('/api/chat', async (request, reply) => {
  const { messages } = request.body;

  const result = streamText({
    model: 'openai/gpt-4',
    messages,
  });

  return reply.send(result.toUIMessageStream());
});
```

### Hono

```typescript
import { Hono } from 'hono';
import { streamText } from 'ai';

const app = new Hono();

app.post('/api/chat', async (c) => {
  const { messages } = await c.req.json();

  const result = streamText({
    model: 'openai/gpt-4',
    messages,
  });

  return result.toUIMessageStreamResponse();
});
```

### NestJS

```typescript
import { Controller, Post, Req, Res } from '@nestjs/common';
import { streamText, pipeUIMessageStreamToResponse } from 'ai';

@Controller('api')
export class ChatController {
  @Post('chat')
  async chat(@Req() req, @Res() res) {
    const { messages } = req.body;

    const result = streamText({
      model: 'openai/gpt-4',
      messages,
    });

    pipeUIMessageStreamToResponse(result.toUIMessageStream(), res);
  }
}
```

### AWS Lambda with Streaming

```typescript
import { streamText } from 'ai';
import { streamifyResponse } from 'lambda-stream';

export const handler = streamifyResponse(async (event, responseStream) => {
  const { messages } = JSON.parse(event.body);

  const result = streamText({
    model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
    messages,
  });

  pipeDataStreamToResponse(result, responseStream);
});
```

### Key Principle: Backend Agnostic

The AI SDK frontend hooks communicate via HTTP + SSE. **Any server that produces the correct SSE stream format can be a backend**, regardless of language or framework. This is what makes it viable as a universal communication layer.

---

## Chat SDK (vercel/chat) - Multi-Platform Communication

The **Chat SDK** (`npm i chat`) is a separate but complementary package released February 2026. It solves the multi-platform bot deployment problem.

### Overview

| Attribute | Value |
|-----------|-------|
| Package | `chat` |
| Version | 4.x (as of March 2026) |
| License | MIT |
| GitHub | `vercel/chat` |
| Stars | 1,200+ |
| Releases | 360+ |

### Supported Platforms

| Platform | Package | Mentions | Reactions | Cards | Modals | Streaming | DMs |
|----------|---------|----------|-----------|-------|--------|-----------|-----|
| Slack | `@chat-adapter/slack` | Yes | Yes | Yes | Yes | Native | Yes |
| Microsoft Teams | `@chat-adapter/teams` | Yes | Read-only | Yes | No | Post+Edit | Yes |
| Google Chat | `@chat-adapter/gchat` | Yes | Yes | Yes | No | Post+Edit | Yes |
| Discord | `@chat-adapter/discord` | Yes | Yes | Yes | No | Post+Edit | Yes |
| Telegram | `@chat-adapter/telegram` | Yes | Yes | Partial | No | Post+Edit | Yes |
| GitHub | `@chat-adapter/github` | Yes | Yes | No | No | No | No |
| Linear | `@chat-adapter/linear` | Yes | Yes | No | No | No | No |
| WhatsApp | `@chat-adapter/whatsapp` | N/A | Yes | Partial | No | No | Yes |

### Core Architecture

Four main components:

1. **`Chat` instance** - Central orchestrator that routes events to handlers
2. **Platform Adapters** - Translate platform-specific formats to unified API
3. **`StateAdapter`** - Persistence for subscriptions, locks, and thread state
4. **Event Handlers** - Application logic

```typescript
import { Chat } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createTeamsAdapter } from '@chat-adapter/teams';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createRedisState } from '@chat-adapter/state-redis';

const bot = new Chat({
  userName: 'my-agent',
  adapters: {
    slack: createSlackAdapter({
      botToken: process.env.SLACK_BOT_TOKEN,
      signingSecret: process.env.SLACK_SIGNING_SECRET,
    }),
    teams: createTeamsAdapter({
      appId: process.env.TEAMS_APP_ID,
      appPassword: process.env.TEAMS_APP_PASSWORD,
    }),
    discord: createDiscordAdapter({
      publicKey: process.env.DISCORD_PUBLIC_KEY,
      botToken: process.env.DISCORD_BOT_TOKEN,
    }),
  },
  state: createRedisState({
    url: process.env.REDIS_URL,
  }),
});
```

### Event-Driven Architecture

Register handlers for specific event types. Handler priority: subscribed threads > mentions > pattern matches.

```typescript
// Entry point: bot is @mentioned
bot.onNewMention(async (thread, message) => {
  await thread.subscribe(); // Subscribe to future messages in this thread
  await thread.post('Hello! I\'m listening to this thread now.');
});

// Subsequent messages in subscribed threads
bot.onSubscribedMessage(async (thread, message) => {
  const result = await agent.stream({ prompt: message.text });
  await thread.post(result.textStream); // Stream AI response
});

// Pattern matching on message text
bot.onNewMessage(/deploy (\w+)/, async (thread, message, match) => {
  await thread.post(`Deploying ${match[1]}...`);
});

// Emoji reactions
bot.onReaction(async (thread, reaction) => {
  await thread.post(`Thanks for the ${reaction.emoji}!`);
});

// Button clicks in cards
bot.onAction('approve', async (thread, action) => {
  await processApproval(action);
  await thread.post('Approved!');
});

// Slash commands
bot.onSlashCommand('/status', async (thread) => {
  await thread.post(await getSystemStatus());
});

// Modal form submissions
bot.onModalSubmit('feedback-form', async (thread, data) => {
  await saveFeedback(data);
  await thread.post('Feedback received!');
});
```

### JSX Cards (Cross-Platform UI)

Define rich UI components in JSX that render natively on each platform:

```tsx
// tsconfig.json: "jsx": "react-jsx", "jsxImportSource": "chat"

import { Card, CardText, Actions, Button } from 'chat/jsx';

const OrderCard = ({ orderId, status }) => (
  <Card title={`Order #${orderId}`}>
    <CardText>Status: {status}</CardText>
    <Actions>
      <Button id="approve" style="primary">Approve</Button>
      <Button id="reject" style="danger">Reject</Button>
    </Actions>
  </Card>
);

// Post the card to any platform
await thread.post(<OrderCard orderId="1234" status="pending" />);
```

The JSX runtime converts elements to `CardElement` AST, which each adapter converts to platform-native format:
- Slack: Block Kit
- Teams: Adaptive Cards
- Discord: Embeds
- Google Chat: Cards v2

### Modals (Cross-Platform Forms)

```tsx
import { Modal, TextInput, Select } from 'chat/jsx';

bot.onAction('create-ticket', async (thread, action) => {
  await action.openModal(
    <Modal title="Create Ticket" id="ticket-form">
      <TextInput id="title" label="Title" required />
      <TextInput id="description" label="Description" multiline />
      <Select id="priority" label="Priority">
        <Option value="high">High</Option>
        <Option value="medium">Medium</Option>
        <Option value="low">Low</Option>
      </Select>
    </Modal>
  );
});
```

### Distributed State Management

The `StateAdapter` provides:

1. **Thread subscriptions**: `thread.subscribe()` persists subscription state
2. **Distributed locking**: Prevents duplicate webhook processing across instances
3. **Key-value cache**: `thread.setState()` / `thread.state` with TTL
4. **Message deduplication**: Idempotent webhook handling

Available adapters:
- `@chat-adapter/state-redis` (production)
- `@chat-adapter/state-ioredis` (production, cluster)
- `@chat-adapter/state-pg` (PostgreSQL)
- `@chat-adapter/state-memory` (development/testing)

### AI SDK Integration

The Chat SDK is designed to work with the AI SDK's streaming:

```typescript
import { ToolLoopAgent } from 'ai';

const agent = new ToolLoopAgent({
  model: 'anthropic/claude-sonnet-4-20250514',
  instructions: 'You are a helpful assistant.',
  tools: { search: searchTool, database: dbTool },
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  const result = await agent.stream({ prompt: message.text });
  await thread.post(result.textStream); // Native streaming on Slack
});
```

The `thread.post()` function accepts an AI SDK `textStream`, enabling real-time streaming of AI responses to chat platforms. On Slack, this uses native streaming; on other platforms, it uses post+edit polling.

---

## Using AI SDK as a Universal Chat Layer

### Architecture Pattern

```
                    +------------------+
                    |  AI SDK Core     |
                    |  (ai package)    |
                    |  - streamText    |
                    |  - ToolLoopAgent |
                    |  - Provider V3   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |              |              |
     +--------v---+  +------v-----+  +-----v------+
     | Web UI     |  | Chat SDK   |  | Custom API |
     | (React)    |  | (chat pkg) |  | (REST/WS)  |
     | useChat    |  | Slack      |  | Mobile app |
     | useObject  |  | Teams      |  | CLI        |
     |            |  | Discord    |  |            |
     +------------+  | GitHub     |  +------------+
                     | Telegram   |
                     | WhatsApp   |
                     +------------+
```

### The Three-Layer Communication Stack

1. **AI SDK Core** (`ai`): Universal LLM interaction layer
   - Provider abstraction (Bedrock, OpenAI, Anthropic, etc.)
   - Tool calling and structured output
   - Agent loops (ToolLoopAgent)
   - Streaming protocol

2. **AI SDK UI** (`@ai-sdk/react` etc.): Web UI layer
   - React/Vue/Svelte/Solid hooks
   - Streaming message rendering
   - Tool approval UIs
   - Custom data visualization

3. **Chat SDK** (`chat`): Multi-platform delivery layer
   - Slack, Teams, Discord, etc.
   - Event-driven bot architecture
   - Cross-platform JSX cards
   - Distributed state management

### Why This Works as a Universal Layer

1. **Protocol-first design**: The SSE-based data stream protocol is language-agnostic. Any backend producing the right SSE format works with AI SDK frontends.

2. **Transport abstraction**: `DefaultChatTransport` (HTTP), `DirectChatTransport` (in-process), or custom transports (WebSocket, gRPC) decouple the frontend from the communication mechanism.

3. **Provider agnostic**: The same agent code works across 15+ LLM providers. Switch from OpenAI to Bedrock with one line.

4. **Framework agnostic**: Express, Fastify, Hono, NestJS, Lambda, or any HTTP server can serve as the backend.

5. **Multi-platform delivery**: Chat SDK delivers the same bot logic to 8 platforms simultaneously.

### Multi-Platform Communication Pattern

```typescript
// 1. Define your agent ONCE
const agent = new ToolLoopAgent({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  instructions: 'You are a customer support agent.',
  tools: {
    lookupOrder: orderTool,
    createTicket: ticketTool,
    searchKB: knowledgeBaseTool,
  },
});

// 2. Serve via web UI (React)
app.post('/api/chat', async (req, res) => {
  const result = await agent.stream({ messages: req.body.messages });
  pipeUIMessageStreamToResponse(result, res);
});

// 3. Serve via Slack/Teams/Discord (Chat SDK)
const bot = new Chat({
  userName: 'support-agent',
  adapters: { slack: slackAdapter, teams: teamsAdapter },
  state: redisState,
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  const result = await agent.stream({ prompt: message.text });
  await thread.post(result.textStream);
});

// 4. Serve via REST API (for mobile apps)
app.post('/api/agent', async (req, res) => {
  const result = await agent.generate({ prompt: req.body.prompt });
  res.json({ text: result.text, steps: result.steps.length });
});
```

---

## Integration with AWS & Strands Agents

### Connecting AI SDK to Bedrock AgentCore

For [[01-AgentCore-Architecture-Runtime]], the AI SDK can serve as the frontend communication layer:

```
+----------------+     +------------------+     +------------------+
| Web/Slack/     |     | AI SDK           |     | Bedrock          |
| Teams/Discord  | --> | (useChat +       | --> | AgentCore        |
| (Clients)      |     |  Chat SDK)       |     | (Strands Agent)  |
+----------------+     +------------------+     +------------------+
```

#### Pattern 1: AI SDK Frontend + Strands Backend

The Strands agent runs on AgentCore. The AI SDK frontend communicates via the data stream protocol:

```typescript
// Frontend (React)
const { messages, sendMessage } = useChat({
  transport: new DefaultChatTransport({
    api: 'https://agentcore.us-east-1.amazonaws.com/agents/my-agent/invoke',
    headers: () => ({
      Authorization: `Bearer ${getAgentCoreToken()}`,
    }),
  }),
});
```

The AgentCore endpoint needs to produce SSE in the AI SDK data stream format.

#### Pattern 2: AI SDK Agent + Bedrock Models

Use AI SDK's `ToolLoopAgent` with Bedrock provider directly:

```typescript
import { ToolLoopAgent } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

const agent = new ToolLoopAgent({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  tools: { /* Strands-compatible tools */ },
});
```

#### Pattern 3: Chat SDK for Slack/Teams Delivery

Deploy a Strands agent as an AgentCore runtime, with Chat SDK as the multi-platform interface:

```typescript
import { Chat } from 'chat';
import { ToolLoopAgent } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

const agent = new ToolLoopAgent({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  instructions: 'You are a DevOps assistant.',
  tools: { /* ... */ },
});

const bot = new Chat({
  userName: 'devops-bot',
  adapters: { slack: slackAdapter, teams: teamsAdapter },
  state: redisState,
});

bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  const result = await agent.stream({ prompt: message.text });
  await thread.post(result.textStream);
});
```

### Bedrock Provider Features Relevant to AgentCore

- **Native SigV4 auth**: Works with IAM roles, instance profiles, ECS task roles
- **Bedrock Guardrails**: Content safety via provider options
- **Cross-region inference**: Supported through credential configuration
- **Model access control**: Uses standard Bedrock model access policies
- **Prompt caching**: Cache points with TTL for cost optimization

---

## Code Examples

### Complete Next.js Chat Application

**Server (`app/api/chat/route.ts`):**

```typescript
import { streamText, convertToModelMessages } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const result = streamText({
    model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
    messages: convertToModelMessages(messages),
    tools: {
      weather: weatherTool,
    },
    maxSteps: 3,
  });

  return result.toUIMessageStreamResponse();
}
```

**Client (`app/page.tsx`):**

```typescript
'use client';
import { useChat } from '@ai-sdk/react';

export default function Chat() {
  const { messages, sendMessage, status } = useChat();
  const [input, setInput] = useState('');

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id} className={m.role}>
          {m.parts.map((part, i) => {
            switch (part.type) {
              case 'text': return <p key={i}>{part.text}</p>;
              case 'tool': return <ToolUI key={i} part={part} />;
              default: return null;
            }
          })}
        </div>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); sendMessage({ text: input }); setInput(''); }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} />
        <button type="submit" disabled={status !== 'ready'}>Send</button>
      </form>
    </div>
  );
}
```

### Express + React (Non-Vercel)

**Server:**

```typescript
import express from 'express';
import cors from 'cors';
import { streamText, pipeUIMessageStreamToResponse, convertToModelMessages } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/api/chat', async (req, res) => {
  const result = streamText({
    model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
    messages: convertToModelMessages(req.body.messages),
  });

  pipeUIMessageStreamToResponse(result.toUIMessageStream(), res);
});

app.listen(3001);
```

**React Client (any React app, not necessarily Next.js):**

```typescript
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

function App() {
  const { messages, sendMessage } = useChat({
    transport: new DefaultChatTransport({
      api: 'http://localhost:3001/api/chat',
    }),
  });

  // ... render messages
}
```

### Multi-Platform Bot with AI Agent

```typescript
import { Chat } from 'chat';
import { ToolLoopAgent, tool } from 'ai';
import { bedrock } from '@ai-sdk/amazon-bedrock';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createDiscordAdapter } from '@chat-adapter/discord';
import { createRedisState } from '@chat-adapter/state-redis';
import { z } from 'zod';

// Define tools
const searchTool = tool({
  description: 'Search the knowledge base',
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    return await searchKnowledgeBase(query);
  },
});

// Create agent
const agent = new ToolLoopAgent({
  model: bedrock('anthropic.claude-3-5-sonnet-20241022-v2:0'),
  instructions: 'You are a helpful support assistant. Search the knowledge base to answer questions.',
  tools: { search: searchTool },
  stopWhen: stepCountIs(5),
});

// Create multi-platform bot
const bot = new Chat({
  userName: 'support-bot',
  adapters: {
    slack: createSlackAdapter({
      botToken: process.env.SLACK_BOT_TOKEN!,
      signingSecret: process.env.SLACK_SIGNING_SECRET!,
    }),
    discord: createDiscordAdapter({
      publicKey: process.env.DISCORD_PUBLIC_KEY!,
      botToken: process.env.DISCORD_BOT_TOKEN!,
    }),
  },
  state: createRedisState({ url: process.env.REDIS_URL! }),
});

// Handle mentions on ANY platform
bot.onNewMention(async (thread, message) => {
  await thread.subscribe();
  const result = await agent.stream({ prompt: message.text });
  await thread.post(result.textStream);
});

// Handle follow-up messages
bot.onSubscribedMessage(async (thread, message) => {
  const result = await agent.stream({ prompt: message.text });
  await thread.post(result.textStream);
});

// Wire up webhooks (Next.js example)
export async function POST(req: Request) {
  return bot.webhooks.slack(req);
}
```

---

## Comparison & Trade-offs

### AI SDK vs. Direct Provider SDKs

| Aspect | AI SDK | Direct Provider SDK |
|--------|--------|-------------------|
| Provider switching | One line change | Complete rewrite |
| Streaming | Built-in, unified | Provider-specific |
| Tool calling | Unified schema (Zod) | Provider-specific format |
| UI hooks | Included | Build your own |
| Multi-step agents | ToolLoopAgent | DIY loop |
| Bundle size | Larger (abstractions) | Smaller (focused) |
| Provider-specific features | May lag | Immediate access |

### AI SDK vs. LangChain.js

| Aspect | AI SDK | LangChain.js |
|--------|--------|-------------|
| Focus | UI-first, streaming | Backend-first, chains |
| TypeScript | First-class | Added later |
| Streaming | Native SSE protocol | LCEL streaming |
| Frontend hooks | useChat, useObject | Build your own |
| Agent pattern | ToolLoopAgent | AgentExecutor |
| Ecosystem | 15+ providers | 50+ integrations |
| Learning curve | Lower | Higher |
| Interop | LangChain adapter available | AI SDK adapter available |

### Chat SDK vs. Botpress/Botkit

| Aspect | Chat SDK | Botpress | Botkit |
|--------|----------|----------|--------|
| Platforms | 8 | 10+ | 4 |
| Architecture | Code-first, TypeScript | Visual + code | Code-first |
| AI integration | Native AI SDK streaming | Plugin-based | Manual |
| JSX cards | Yes | Visual editor | No |
| State management | Pluggable adapters | Built-in | In-memory |
| Hosting | Anywhere | Botpress Cloud | Anywhere |
| License | MIT | AGPL/Commercial | MIT |

### Trade-offs to Consider

**Strengths:**
- Best-in-class TypeScript DX
- Production-proven (Thomson Reuters, Clay)
- Active development (20M+ monthly downloads)
- Clean protocol specification enables polyglot backends
- AI SDK + Chat SDK covers web + 8 chat platforms

**Limitations:**
- TypeScript/JavaScript only (backend must be Node.js for full features; protocol is implementable in Python/Go but without SDK convenience)
- Chat SDK is new (Feb 2026, public beta) - uneven platform support
- MCP integration currently limited to OpenAI provider
- No built-in persistence for message history (bring your own database)
- Agent abstraction is simpler than Strands/LangGraph (by design)

---

## Sources & References

### Official Documentation
- AI SDK docs: https://ai-sdk.dev/docs
- AI SDK 6 blog post: https://vercel.com/blog/ai-sdk-6
- Chat SDK docs: https://chat-sdk.dev/docs
- Chat SDK changelog: https://vercel.com/changelog/chat-sdk
- Stream Protocols: https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
- Tool Calling: https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling
- Agents Overview: https://ai-sdk.dev/docs/agents/overview

### GitHub Repositories
- AI SDK: https://github.com/vercel/ai (22.7k stars)
- Chat SDK: https://github.com/vercel/chat (1,282 stars)
- Python Data Stream: https://github.com/elementary-data/py-ai-datastream

### Articles & Community
- "Vercel Ship AI 2025 Recap" (vercel.com/blog)
- "Vercel Just Released a Universal Chat SDK" (Towards AI, Feb 2026)
- "OpenAI SDK vs Vercel AI SDK" (strapi.io/blog)
- "Building Real-Time AI Streaming Services with AWS Lambda" (metaduck.com)
- "How to build unified AI interfaces using the Vercel AI SDK" (LogRocket, Jul 2025)
- "Vercel AI SDK Complete Guide" (dev.to, Jan 2026)

### DeepWiki Analysis
- vercel/ai Architecture and Design Principles
- vercel/ai Framework-Agnostic Chat Architecture
- vercel/ai Provider Architecture and V3 Specification
- vercel/ai Tool Calling and Multi-Step Agents
- vercel/chat Getting Started and Core Architecture

---

> **Next steps for this research track:**
> - Prototype a Strands Agent backend that produces AI SDK-compatible SSE streams
> - Test Chat SDK with a Bedrock-powered ToolLoopAgent across Slack and Teams
> - Evaluate performance of Bedrock provider vs. direct Anthropic provider
> - Explore Chat SDK state adapter on DynamoDB (custom adapter)
> - Benchmark streaming latency through the full stack (Bedrock -> AI SDK -> Chat SDK -> Slack)
