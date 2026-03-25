/**
 * Stream module — async message completion with DDB buffering
 *
 * Provides StreamBufferService for decoupling LLM generation from HTTP
 * response lifetime. Agent finishes even when the client disconnects;
 * clients can reconnect and replay the buffered stream.
 */

export {
  StreamBufferService,
  type DynamoDBClient,
  type StreamBufferServiceConfig,
  type StreamChunk,
  type StreamBufferRecord,
  type StreamStatus,
} from './stream-buffer-service';
