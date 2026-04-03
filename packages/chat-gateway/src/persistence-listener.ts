/**
 * PersistenceListener — DynamoDB message persistence for chat streams
 *
 * Attaches to a StreamTee and persists messages to DynamoDB for:
 * 1. Background completion: agent keeps running after client disconnects
 * 2. Session history: reload page and see past conversations
 * 3. Multi-device: continue conversation on different device
 *
 * Write strategy:
 * - On stream start: write user message + assistant placeholder (status: 'streaming')
 * - On each text-delta: accumulate text in-memory (no per-token writes)
 * - On complete: write final assembled message with full content, status: 'complete'
 * - On error: write partial content with status: 'error'
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE =
  process.env.SESSIONS_TABLE_NAME || process.env.CHIMERA_SESSIONS_TABLE || 'chimera-sessions-dev';

export interface PersistenceOpts {
  messageId: string;
  sessionId: string;
  tenantId: string;
  userId: string;
  userContent: string;
}

export interface StreamListener {
  onPart: (part: any) => void;
  onComplete: () => Promise<void>;
  onError: (err: Error) => Promise<void>;
}

/**
 * Create a persistence listener that writes chat messages to DynamoDB.
 *
 * Intended to be wired to a StreamTee via addListener/onComplete/onError.
 * Accumulates text deltas in memory and writes the final message on completion.
 */
export function createPersistenceListener(opts: PersistenceOpts): StreamListener {
  const { messageId, sessionId, tenantId, userId, userContent } = opts;
  const pk = `TENANT#${tenantId}#SESSION#${sessionId}`;
  let textAccumulator = '';
  let lastCheckpointChars = 0;
  let lastCheckpointTime = Date.now();
  const CHECKPOINT_CHARS = 500;
  const CHECKPOINT_MS = 30_000;
  let finishReason: string | undefined;
  let usage: Record<string, number> | undefined;
  let toolCalls: Array<{ id: string; name: string; input: string; result?: string }> = [];
  let currentToolCall: { id: string; name: string; input: string } | null = null;

  // Timestamp-based sort keys ensure chronological ordering within the session
  const now = new Date().toISOString();
  const ts = Date.now();
  const userMsgSk = `MSG#${ts}#user`;
  const assistantMsgSk = `MSG#${ts + 1}#${messageId}`;

  // Write initial records (fire and forget — stream must not block on persistence)
  client
    .send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk,
          SK: userMsgSk,
          messageId: `user_${ts}`,
          sessionId,
          tenantId,
          userId,
          role: 'user',
          content: userContent,
          status: 'complete',
          createdAt: now,
        },
      })
    )
    .catch((err) => console.error('Failed to persist user message:', err.message));

  // Assistant placeholder — updated to 'complete' or 'error' when stream finishes
  client
    .send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk,
          SK: assistantMsgSk,
          messageId,
          sessionId,
          tenantId,
          userId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: now,
        },
      })
    )
    .catch((err) => console.error('Failed to persist assistant placeholder:', err.message));

  return {
    onPart(part: any) {
      // Accumulate text deltas from both possible field names
      if (part.type === 'text-delta') {
        if (part.delta) textAccumulator += part.delta;
        else if (part.textDelta) textAccumulator += part.textDelta;

        // Periodic checkpoint: write partial content to DynamoDB so crash-recovery
        // doesn't lose everything. Fire-and-forget to avoid blocking the stream.
        if (
          textAccumulator.length - lastCheckpointChars >= CHECKPOINT_CHARS ||
          Date.now() - lastCheckpointTime >= CHECKPOINT_MS
        ) {
          void client
            .send(
              new UpdateCommand({
                TableName: TABLE,
                Key: { PK: pk, SK: assistantMsgSk },
                UpdateExpression: 'SET content = :content',
                ExpressionAttributeValues: { ':content': textAccumulator },
              })
            )
            .catch((err) => console.error('Checkpoint write failed:', err.message));
          lastCheckpointChars = textAccumulator.length;
          lastCheckpointTime = Date.now();
        }
      }

      // Capture finish reason from the terminal 'finish' event
      if (part.type === 'finish') {
        finishReason = part.finishReason;
      }

      // Capture token usage from data-usage parts
      if (part.type === 'data-usage' && part.data) {
        usage = part.data;
      }

      // Track tool call lifecycle
      if (part.type === 'tool-input-start') {
        currentToolCall = {
          id: part.id || '',
          name: part.toolName || '',
          input: '',
        };
      }
      if (part.type === 'tool-input-delta' && currentToolCall) {
        currentToolCall.input += part.delta || '';
      }
      if (part.type === 'tool-result') {
        if (currentToolCall) {
          toolCalls.push({
            ...currentToolCall,
            result: JSON.stringify(part.result ?? '').slice(0, 2000),
          });
          currentToolCall = null;
        }
      }
    },

    async onComplete() {
      try {
        const updateExpr = [
          '#s = :status',
          'content = :content',
          'finishReason = :fr',
          '#u = :usage',
          'completedAt = :now',
        ];
        const exprValues: Record<string, any> = {
          ':status': 'complete',
          ':content': textAccumulator,
          ':fr': finishReason || 'stop',
          ':usage': usage || {},
          ':now': new Date().toISOString(),
        };

        if (toolCalls.length > 0) {
          updateExpr.push('toolCalls = :tc');
          exprValues[':tc'] = toolCalls;
        }

        await client.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk, SK: assistantMsgSk },
            UpdateExpression: `SET ${updateExpr.join(', ')}`,
            ExpressionAttributeNames: { '#s': 'status', '#u': 'usage' },
            ExpressionAttributeValues: exprValues,
          })
        );
        console.log(
          `Persisted message ${messageId} (${textAccumulator.length} chars, ${toolCalls.length} tool calls)`
        );
      } catch (err: any) {
        console.error(`Failed to persist completion for ${messageId}:`, err.message);
      }
    },

    async onError(err: Error) {
      try {
        await client.send(
          new UpdateCommand({
            TableName: TABLE,
            Key: { PK: pk, SK: assistantMsgSk },
            UpdateExpression: 'SET #s = :status, content = :content, errorMessage = :err',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':status': 'error',
              ':content': textAccumulator,
              ':err': err.message,
            },
          })
        );
      } catch (writeErr: any) {
        console.error(`Failed to persist error for ${messageId}:`, writeErr.message);
      }
    },
  };
}
