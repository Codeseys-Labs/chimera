---
title: "Research: Async Message Completion + Vercel AI SDK Transport"
version: 1.0.0
status: research
task_id: chimera-81cf
last_updated: 2026-03-24
author: lead-research-async
---

# Async Message Completion + Vercel AI SDK Transport Architecture

## Executive Summary

**Q1 -- Vercel AI SDK Transport:** The Vercel AI SDK uses **Server-Sent Events (SSE)** over HTTP POST, not WebSocket. Our current ALB + CloudFront + ECS architecture is fully compatible. No WebSocket support needed.

**Q2 -- Async Message Completion:** The Vercel AI SDK has **built-in support** for exactly this pattern via `consumeStream()` + resumable streams. The server continues generating after client disconnect, persists messages via `onFinish`, and clients reconnect via a GET endpoint. We can implement this using DynamoDB as the stream buffer store (replacing Redis).

---

## Q1: Vercel AI SDK Transport Protocol

### Finding: SSE, Not WebSocket

The Vercel AI SDK (`ai` npm package / `@ai-sdk/react`) uses **Server-Sent Events (SSE)** as its default transport protocol. There is no WebSocket requirement.

| Aspect | Detail |
|--------|--------|
| **Default protocol** | SSE via HTTP POST (Data Stream Protocol) |
| **Alternative** | Plain text streaming (`streamProtocol: text`) |
| **Custom transport** | Supported via `ChatTransport` interface (can implement WebSocket if desired, but not required) |
| **Response header** | `x-vercel-ai-ui-message-stream: v1` |
| **Termination** | `data: [DONE]` sentinel |

### Data Stream Protocol (DSP) Format

The SDK streams JSON objects as SSE events:

```
data: {"type":"start","messageId":"msg_123"}
data: {"type":"text-delta","id":"text_0","delta":"Hello"}
data: {"type":"text-delta","id":"text_0","delta":" world"}
data: {"type":"text-end","id":"text_0"}
data: {"type":"finish","messageId":"msg_123","finishReason":"stop"}
data: [DONE]
```

### Compatibility with Current Architecture

Our current stack is **fully compatible**:

```
Client (useChat) --POST--> CloudFront ---> ALB ---> ECS Fargate (Express)
                  <--SSE---                          @chimera/sse-bridge
```

- **CloudFront**: Already configured with `CACHING_DISABLED` + `ALL_VIEWER` origin request policy for dynamic endpoints. SSE pass-through works.
- **ALB**: HTTP listener forwards to ECS. SSE is standard HTTP -- no special config needed.
- **ECS Fargate**: Express server already streams SSE via `streamStrandsToDSP()`.
- **API Gateway HTTP API**: NOT needed. Our ALB-based architecture is simpler and has no 30-second timeout constraint.

### Timeout Considerations

| Layer | Timeout | SSE Impact |
|-------|---------|------------|
| CloudFront origin read timeout | 60s (configured) | May need increase for long agent responses |
| ALB idle timeout | 60s (default) | SSE keepalive pings prevent idle timeout |
| ECS task | No timeout | Agent runs until completion |

**Recommendation:** Increase CloudFront `readTimeout` to 300s for long-running agent interactions. Add SSE keepalive pings (`:ping` comments every 15s) to prevent ALB idle timeout.

### What We Already Have vs. What the SDK Expects

| SDK Expectation | Our Current Implementation | Gap |
|-----------------|---------------------------|-----|
| POST endpoint accepting `UIMessage[]` | `POST /chat/stream` accepting messages | Minor: parse format differs slightly |
| SSE response with DSP format | `streamStrandsToDSP()` in sse-bridge | Already implemented |
| `x-vercel-ai-ui-message-stream: v1` header | Not set | Easy add |
| GET endpoint for stream resumption | Not implemented | New feature (see Q2) |
| `consumeSseStream` for server-side persistence | Not implemented | New feature (see Q2) |

---

## Q2: Async Message Completion Architecture

### The Problem

When a user sends a message and disconnects (closes browser, loses connection, navigates away), the current architecture **aborts** the agents work. The SSE stream breaks, Express detects the disconnect, and the agent stops. The user comes back to nothing.

### The Goal

The agent should **finish its work regardless of client connection state**. When the user reconnects, they see the completed response. Like email -- the response is there when you come back.

### Vercel AI SDK Built-in Solution

The SDK provides three mechanisms that compose into the full async completion pattern:

#### 1. `consumeStream()` -- Server-Side Stream Decoupling

```typescript
const result = streamText({ model, messages });

// This removes backpressure -- stream continues even if client disconnects
result.consumeStream();

// onFinish fires even after client disconnect
return result.toUIMessageStreamResponse({
  onFinish: async ({ messages, isDisconnect }) => {
    // Save completed messages to DynamoDB
    await saveMessages(chatId, messages);
    // Clear active stream marker
    await clearActiveStream(chatId);
  },
});
```

**Key insight:** `consumeStream()` decouples the LLM stream from the HTTP response. The Bedrock invocation continues to completion server-side. The `onFinish` callback receives an `isDisconnect` flag indicating whether the client was still connected.

#### 2. `consumeSseStream` -- Stream Buffering for Reconnection

```typescript
return result.toUIMessageStreamResponse({
  consumeSseStream: async (stream) => {
    // Buffer the SSE stream in a persistent store
    const streamId = createResumableStream(stream);
    await saveActiveStreamId(chatId, streamId);
  },
  onFinish: async ({ messages }) => {
    await saveMessages(chatId, messages);
    await clearActiveStreamId(chatId);
  },
});
```

The SSE stream is teed -- one copy goes to the client, the other is buffered. If the client disconnects mid-stream, the buffer contains the remaining events.

#### 3. `resume: true` -- Client-Side Reconnection

```typescript
// Client-side
const { messages } = useChat({
  id: chatId,
  initialMessages: loadedFromDB,
  resume: true,  // Auto-reconnect on mount
});
```

When `resume: true` is set, the hook makes a `GET /api/chat/{id}/stream` request on mount. If an active stream exists, the client receives buffered events. If the stream completed, it gets a 204 (No Content) and loads messages from the DB.

### Proposed Architecture for Chimera

#### Option A: DynamoDB-Based Resumable Streams (Recommended)

Replace Redis with DynamoDB for stream buffering. This aligns with our existing infrastructure (no new services).

#### Session Item Schema Extension

Add new fields to the existing `chimera-sessions` table:

```typescript
interface SessionItem {
  // Existing fields
  PK: string;           // TENANT#{tenantId}
  SK: string;           // SESSION#{sessionId}
  userId: string;
  agentId: string;
  lastActivity: string; // ISO timestamp
  ttl: number;          // 24h TTL

  // New fields for async completion
  messages: UIMessage[];          // Persisted message history
  activeStreamId: string | null;  // Non-null = agent still generating
  streamBuffer: string[];         // Buffered SSE events (for reconnection)
  status: idle | streaming | completed | error;
  completedAt?: string;           // When agent finished
  isDisconnected?: boolean;       // Client disconnected during generation
}
```

#### Request/Response Flow

**Normal flow (client stays connected):**
1. Client POSTs to `/chat/stream` with messages
2. Server calls `streamText()` with Bedrock model
3. Server calls `consumeStream()` to decouple from client
4. SSE events stream to client AND buffer to DDB (teed stream)
5. `activeStreamId` set in session
6. Agent finishes -> `onFinish` saves messages, clears `activeStreamId`

**Disconnection flow:**
1. Steps 1-5 same as above
2. Client disconnects (browser close, network loss)
3. Agent **continues** because `consumeStream()` decoupled it
4. New SSE events buffer to DDB (no client to send to)
5. Agent finishes -> `onFinish` saves messages, sets `isDisconnected: true`

**Reconnection flow:**
1. Client loads page, `useChat({ resume: true })` fires
2. GET request to `/chat/{sessionId}/stream`
3. Server checks `activeStreamId` in DDB:
   - **Stream still active**: Replay buffered events from DDB, continue streaming
   - **Stream completed**: Return 204 -> client loads `messages` from DDB via `initialMessages`
   - **No session**: Return 204 -> fresh chat

#### DynamoDB vs Redis for Stream Buffering

| Aspect | Redis | DynamoDB |
|--------|-------|----------|
| Latency | Sub-ms | Single-digit ms |
| Persistence | Optional (AOF/RDB) | Durable by default |
| TTL | Key-level TTL | Item-level TTL (already configured) |
| Cost | ElastiCache instance ($$$) | Pay-per-request (existing) |
| Complexity | New service to manage | Already in our stack |
| Pub/sub for live replay | Native | Requires polling or DDB Streams |

**Recommendation:** Use DynamoDB. The latency difference is negligible for this use case. The cost and operational simplicity of using our existing table outweighs Redis pub/sub advantage.

**Trade-off:** DynamoDB lacks native pub/sub for live stream replay. For active-stream reconnection:
- **Polling**: Client polls GET endpoint every 1-2s (simple, slightly laggy)
- **Hybrid**: ECS task maintains in-memory buffer keyed by streamId; GET handler reads from same task. DDB is durable fallback for ECS task cycling.

**MVP Recommendation:** Use the hybrid approach with ALB sticky sessions.

### Option B: SQS + Step Functions (Alternative for Very Long Tasks)

For agent tasks that may take minutes (multi-step tool use, complex reasoning): Client POST -> API Gateway -> SQS Queue -> Step Functions -> Lambda (Bedrock) -> DDB. Client polls `/chat/{id}/status`.

**When to use:** Only for truly long-running tasks (>5 minutes). For normal chat, Option A is simpler.

### Implementation Priorities

#### Phase 1: Server-Side Completion (Critical)
- Add `consumeStream()` call in `/chat/stream` handler
- Add `onFinish` callback to persist messages to `chimera-sessions`
- Set `activeStreamId` on stream start, clear on finish
- Agent finishes work even if client disconnects

#### Phase 2: Client Reconnection
- Add `GET /chat/{sessionId}/stream` endpoint
- Implement in-memory stream buffer in ECS task (keyed by streamId)
- Add `resume: true` to client-side `useChat` configuration
- Load `initialMessages` from DDB on page load

#### Phase 3: DynamoDB Fallback Buffer
- Buffer SSE events to DDB `streamBuffer` field (for ECS task cycling)
- Add stream replay logic from DDB when in-memory buffer unavailable
- Add TTL-based cleanup of completed stream buffers

#### Phase 4: CloudFront Timeout Tuning
- Increase `readTimeout` to 300s for `/chat/*` behaviors
- Add SSE keepalive pings (`:ping` every 15s) in the sse-bridge

---

## Impact on Existing Components

### `packages/chat-gateway/src/routes/chat.ts`
- Add `consumeStream()` after creating agent stream
- Add `onFinish` callback for DDB persistence
- Add `activeStreamId` tracking
- Add new GET route for stream reconnection

### `packages/sse-bridge/`
- Add keepalive ping support (`:ping` SSE comments)
- Add stream tee utility for buffering

### `infra/lib/chat-stack.ts`
- Increase CloudFront read timeout to 300s
- No other infra changes needed (DDB table already exists)

### `packages/core/src/agent/`
- Agent stream must be decoupled from HTTP response lifecycle
- Bedrock invocation continues regardless of client connection

### Client-side (web UI)
- Add `resume: true` to `useChat` hook
- Load `initialMessages` from session API on page load
- Handle reconnection UX (loading state -> stream resumes)

---

## Key Decisions for Implementation

### 1. Stream Buffer Storage
**Decision needed:** DynamoDB hybrid (recommended) vs. ElastiCache Redis vs. SQS-based

### 2. Reconnection Strategy
**Decision needed:** In-memory buffer on same ECS task (recommended for MVP) vs. DDB Streams + WebSocket push

### 3. Message Format
**Decision needed:** Store raw `UIMessage[]` (Vercel SDK format) vs. our own normalized format. **Recommendation:** Store `UIMessage[]` directly.

### 4. DynamoDB Item Size
**Concern:** Long conversations may exceed DynamoDB 400KB item limit. **Mitigation:** Store messages in S3 for large conversations. Phase 3+ concern.

### 5. Cost of Completing Unread Responses
**Concern:** Agent finishes using Bedrock tokens even if user never returns. **Mitigation:** Add configurable max-completion-time per tenant tier (basic: 30s, pro: 120s, enterprise: 300s).

---

## Conclusion

The Vercel AI SDK transport (SSE) and async completion primitives (`consumeStream`, `consumeSseStream`, `resume`) map cleanly onto our existing architecture. No new AWS services are needed -- DynamoDB + ECS + ALB handle everything. The implementation is a series of additions to existing components, not a rearchitecture.

Priority order: (1) `consumeStream()` for server-side completion, (2) message persistence in `onFinish`, (3) GET endpoint for reconnection, (4) client-side `resume: true`.
