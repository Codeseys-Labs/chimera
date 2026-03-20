# @chimera/sse-bridge

**SSE bridge translating Strands/AgentCore streaming events to Vercel AI SDK Data Stream Protocol (DSP).**

This package is the critical integration point between the Strands agent runtime and Vercel AI SDK frontends, enabling real-time streaming of agent responses to React, Vue, Svelte, and other AI SDK-powered UIs.

## Purpose

The Chimera platform runs agents using [Strands Agents SDK](https://strandsagents.com) on AWS Bedrock AgentCore. Frontend applications built with [Vercel AI SDK](https://ai-sdk.dev) expect responses in the Data Stream Protocol (DSP) format over Server-Sent Events (SSE).

This bridge translates between the two:

```
Strands StreamEvents  →  @chimera/sse-bridge  →  Vercel DSP (SSE)
```

## Architecture

### Input: Strands StreamEvents

Strands agents emit events during execution:

```typescript
type StrandsStreamEvent =
  | { type: 'messageStart'; messageId?: string }
  | { type: 'messageStop'; stopReason: string }
  | { type: 'contentBlockStart'; contentBlock: { type: 'text' | 'tool_use'; id: string } }
  | { type: 'contentBlockDelta'; delta: { type: 'textDelta'; text: string } }
  | { type: 'contentBlockStop'; contentBlockIndex: number }
  | { type: 'metadata'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'redaction'; redaction: { reason: string; text: string } };
```

### Output: Vercel DSP (SSE)

The bridge produces SSE-formatted JSON events consumable by AI SDK hooks:

```
data: {"type":"start","messageId":"msg_abc123"}

data: {"type":"text-start","id":"text_001"}

data: {"type":"text-delta","id":"text_001","delta":"Hello"}

data: {"type":"text-end","id":"text_001"}

data: {"type":"finish","messageId":"msg_abc123","finishReason":"stop"}

data: [DONE]
```

**Required Header:** `x-vercel-ai-ui-message-stream: v1`

## Installation

```bash
npm install @chimera/sse-bridge
```

## Usage

### Express Example

```typescript
import express from 'express';
import { StrandsToDSPBridge, createSSEResponseStream } from '@chimera/sse-bridge';

const app = express();

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;

  // Initialize bridge
  const bridge = new StrandsToDSPBridge();
  const writer = createSSEResponseStream(res);

  try {
    // Stream from Strands agent
    for await (const event of strandsAgent.stream(messages)) {
      const dspParts = bridge.convert(event);
      await writer.writeAll(dspParts);
    }

    await writer.close();
  } catch (error) {
    console.error('Streaming error:', error);
    if (!writer.isClosed()) {
      await writer.close();
    }
  }
});

app.listen(3000);
```

### Next.js App Router Example

```typescript
// app/api/chat/route.ts
import { StrandsToDSPBridge, VERCEL_DSP_HEADERS } from '@chimera/sse-bridge';

export async function POST(req: Request) {
  const { messages } = await req.json();

  const bridge = new StrandsToDSPBridge();
  const strandsEvents = strandsAgent.stream(messages);

  // Create ReadableStream
  const stream = bridge.createReadableStream(strandsEvents);

  return new Response(stream, {
    headers: VERCEL_DSP_HEADERS,
  });
}
```

### Fastify Example

```typescript
import Fastify from 'fastify';
import { streamStrandsToDSP } from '@chimera/sse-bridge';

const app = Fastify();

app.post('/api/chat', async (request, reply) => {
  const { messages } = request.body;
  const events = strandsAgent.stream(messages);

  // Convenience function handles everything
  await streamStrandsToDSP(events, reply.raw);
});

app.listen({ port: 3000 });
```

### AWS Lambda with Response Streaming

```typescript
import { StrandsToDSPBridge, VERCEL_DSP_HEADERS } from '@chimera/sse-bridge';
import { streamifyResponse } from 'lambda-stream';

export const handler = streamifyResponse(async (event, responseStream, _context) => {
  const { messages } = JSON.parse(event.body);

  const bridge = new StrandsToDSPBridge();

  // Set headers
  responseStream.setContentType('text/event-stream');
  Object.entries(VERCEL_DSP_HEADERS).forEach(([key, value]) => {
    responseStream.setHeader(key, value);
  });

  // Stream events
  for await (const strandsEvent of strandsAgent.stream(messages)) {
    const parts = bridge.convert(strandsEvent);
    for (const part of parts) {
      responseStream.write(`data: ${JSON.stringify(part)}\n\n`);
    }
  }

  responseStream.write('data: [DONE]\n\n');
  responseStream.end();
});
```

### Frontend (React + AI SDK)

```typescript
'use client';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

export default function Chat() {
  const { messages, sendMessage, status } = useChat({
    transport: new DefaultChatTransport({
      api: '/api/chat', // Points to your bridge endpoint
    }),
  });

  return (
    <div>
      {messages.map((m) => (
        <div key={m.id} className={m.role}>
          {m.parts.map((part, i) => {
            if (part.type === 'text') return <p key={i}>{part.text}</p>;
            return null;
          })}
        </div>
      ))}
      <button onClick={() => sendMessage({ text: 'Hello!' })} disabled={status !== 'ready'}>
        Send
      </button>
    </div>
  );
}
```

## API Reference

### `StrandsToDSPBridge`

Main bridge class.

```typescript
class StrandsToDSPBridge {
  constructor(messageId?: string);

  // Convert a single event
  convert(event: StrandsStreamEvent): VercelDSPStreamPart[];

  // Stream events to an SSE writer
  async stream(
    events: AsyncIterable<StrandsStreamEvent>,
    writer: SSEStreamWriter
  ): Promise<void>;

  // Convert stream to async iterator
  async *convertStream(
    events: AsyncIterable<StrandsStreamEvent>
  ): AsyncIterableIterator<VercelDSPStreamPart>;

  // Create ReadableStream (Web Streams API)
  createReadableStream(
    events: AsyncIterable<StrandsStreamEvent>
  ): ReadableStream<Uint8Array>;

  // Reset for new conversation
  reset(messageId?: string): void;

  // Get current message ID
  getMessageId(): string;
}
```

### `SSEStreamWriter`

Low-level SSE writer.

```typescript
class SSEStreamWriter {
  constructor(writer: WritableStreamDefaultWriter<Uint8Array> | NodeJSWriteableStream);

  async write(part: VercelDSPStreamPart): Promise<void>;
  async writeAll(parts: VercelDSPStreamPart[]): Promise<void>;
  async close(): Promise<void>;
  isClosed(): boolean;
}
```

### Helper Functions

```typescript
// Create SSE writer for Express/Fastify/etc.
createSSEResponseStream(res: NodeResponse): SSEStreamWriter;

// Create ReadableStream for Next.js/Fetch API
createSSEReadableStream(
  source: AsyncIterable<VercelDSPStreamPart>
): ReadableStream<Uint8Array>;

// Convenience: stream in one call
streamStrandsToDSP(
  events: AsyncIterable<StrandsStreamEvent>,
  res: NodeResponse,
  messageId?: string
): Promise<void>;
```

### Constants

```typescript
const VERCEL_DSP_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  'Connection': 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
};
```

## Event Mapping

| Strands Event          | Vercel DSP Events                                   |
| ---------------------- | --------------------------------------------------- |
| `messageStart`         | `start`                                             |
| `messageStop`          | `finish` (with mapped finishReason)                 |
| `contentBlockStart` (text) | `text-start`                                   |
| `contentBlockDelta` (text) | `text-delta`                                   |
| `contentBlockStop` (text)  | `text-end`                                     |
| `contentBlockStart` (tool) | `tool-input-start`                             |
| `contentBlockDelta` (tool) | `tool-input-delta`                             |
| `metadata` (usage)     | `data-usage` (transient)                            |
| `redaction`            | `data-redaction`                                    |

### Stop Reason Mapping

| Strands `stopReason`     | Vercel DSP `finishReason` |
| ------------------------ | ------------------------- |
| `end_turn`               | `stop`                    |
| `tool_use`               | `tool-calls`              |
| `max_tokens`             | `length`                  |
| `content_filtered`       | `content-filter`          |
| `guardrail_intervention` | `content-filter`          |
| `cancelled`              | `cancelled`               |
| `stop_sequence`          | `stop`                    |

## Design Decisions

### Stateful Conversion

The converter maintains state to track:

- Current message ID
- Open text/tool blocks
- Content block indices

This enables proper sequencing of `*-start`, `*-delta`, `*-end` events even if Strands sends interleaved content blocks.

### Defensive Block Handling

If a `contentBlockDelta` arrives without a matching `contentBlockStart`, the converter automatically opens a block. This guards against edge cases in event ordering.

### Transient Data Parts

Usage statistics (`data-usage`) are marked `transient: true` so they're visible during streaming but not persisted in message history. Redactions are persisted (`transient: false`) for audit purposes.

### Tool Result Handling

Tool execution results are emitted by Strands as separate messages after `contentBlockStop`. The bridge does not synthesize `tool-result` events from input deltas -- it expects Strands to provide complete tool results later in the stream.

## Testing

```bash
npm test
```

Tests cover:

- Event type mapping
- State transitions
- SSE formatting
- Error handling
- Multiple frameworks (Express, Next.js, Lambda)

## Related Packages

- `@chimera/chat-gateway` - Vercel Chat SDK integration
- `@chimera/core` - Strands agent runtime
- `@ai-sdk/react` - React hooks for AI SDK

## References

- [Vercel AI SDK Docs](https://ai-sdk.dev/docs)
- [Data Stream Protocol Spec](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)
- [Strands Agents](https://strandsagents.com)
- [Bedrock AgentCore](https://aws.amazon.com/bedrock/agentcore/)

## License

Apache-2.0
