/**
 * Zod schemas for session boundary types.
 *
 * Sessions cross the DynamoDB boundary (chimera-sessions table) and are
 * loaded/written on nearly every request. The SSE / stream-bridge path also
 * replays buffered stream chunks, so the chunk-shape needs runtime validation
 * to avoid trusting whatever ends up in the DDB item.
 *
 * Mirrors `../types/session.ts`.
 */

import { z } from 'zod';

export const SessionStatusSchema = z.enum(['active', 'idle', 'terminated']);

export const StreamStatusSchema = z.enum([
  'streaming',
  'completed',
  'failed',
]);

export const StreamChunkSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum([
    'text-delta',
    'tool-call',
    'tool-result',
    'finish',
    'error',
    'step-start',
    'step-finish',
  ]),
  data: z.string(),
  timestamp: z.string(),
});

export const StreamBufferRecordSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  streamId: z.string(),
  sessionId: z.string(),
  status: StreamStatusSchema,
  chunks: z.array(StreamChunkSchema),
  startedAt: z.string(),
  completedAt: z.string().optional(),
  isDisconnect: z.boolean().optional(),
  error: z.string().optional(),
  ttl: z.number().int(),
});

// SessionContext intentionally permits arbitrary keys (see TS definition).
// Parsing an incoming context should only verify the known fields and
// pass through the rest.
export const SessionContextSchema = z
  .object({
    workingDirectory: z.string().optional(),
    environmentVars: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

export const SessionTokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

export const AgentSessionSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  sessionId: z.string().min(1),
  agentId: z.string(),
  userId: z.string(),
  status: SessionStatusSchema,
  createdAt: z.string(),
  lastActivity: z.string(),
  messageCount: z.number().int().nonnegative(),
  tokenUsage: SessionTokenUsageSchema,
  context: SessionContextSchema,
  ttl: z.number().int(),
  activeStreamId: z.string().optional(),
  streamStatus: StreamStatusSchema.optional(),
});

export const CreateSessionRequestSchema = z.object({
  tenantId: z.string().min(1),
  agentId: z.string().min(1),
  userId: z.string().min(1),
  context: SessionContextSchema.optional(),
});

export const UpdateSessionRequestSchema = z.object({
  sessionId: z.string().min(1),
  status: SessionStatusSchema.optional(),
  lastActivity: z.string().optional(),
  messageCount: z.number().int().nonnegative().optional(),
  tokenUsage: SessionTokenUsageSchema.partial().optional(),
  context: SessionContextSchema.partial().optional(),
});
