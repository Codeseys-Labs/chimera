/**
 * Strands/AgentCore Streaming Event Types
 *
 * Based on the Strands Agents SDK streaming interface.
 * These events are emitted by the Model.stream() method.
 */

export type StrandsStreamEvent =
  | StrandsMessageStartEvent
  | StrandsMessageStopEvent
  | StrandsContentBlockStartEvent
  | StrandsContentBlockDeltaEvent
  | StrandsContentBlockStopEvent
  | StrandsMetadataEvent
  | StrandsRedactionEvent
  | StrandsToolResultEvent
  | StrandsToolStreamEvent
  | StrandsStepStartEvent;

export interface StrandsMessageStartEvent {
  type: 'messageStart';
  messageId?: string;
}

export interface StrandsMessageStopEvent {
  type: 'messageStop';
  stopReason:
    | 'end_turn'
    | 'tool_use'
    | 'max_tokens'
    | 'stop_sequence'
    | 'content_filtered'
    | 'guardrail_intervention'
    | 'cancelled';
  messageId?: string;
}

export interface StrandsContentBlockStartEvent {
  type: 'contentBlockStart';
  contentBlock: {
    type: 'text' | 'tool_use';
    id: string;
    name?: string; // For tool_use
  };
}

export interface StrandsContentBlockDeltaEvent {
  type: 'contentBlockDelta';
  delta: {
    type: 'textDelta' | 'toolInputDelta';
    text?: string;
    input?: string; // Partial JSON for tool input
  };
  contentBlockIndex: number;
}

export interface StrandsContentBlockStopEvent {
  type: 'contentBlockStop';
  contentBlockIndex: number;
}

export interface StrandsMetadataEvent {
  type: 'metadata';
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface StrandsRedactionEvent {
  type: 'redaction';
  redaction: {
    reason: string;
    text: string;
  };
}

export interface StrandsToolResultEvent {
  type: 'toolResult';
  toolUseId: string;
  result: unknown;
  /**
   * Execution status of the tool call. Required so that tool failures cannot
   * silently convert to success on the wire (review finding C3).
   */
  status: 'success' | 'error';
  /** Optional human-readable error message when status === 'error' */
  error?: string;
}

export interface StrandsToolStreamEvent {
  type: 'toolStream';
  toolUseId: string;
  delta: string;
}

export interface StrandsStepStartEvent {
  type: 'stepStart';
  stepIndex?: number;
}

/**
 * Vercel AI SDK Data Stream Protocol (DSP) Types
 *
 * Based on the AI SDK v6 stream protocol specification.
 * These are the target format for SSE output.
 */

export type VercelDSPStreamPart =
  | VercelDSPStartPart
  | VercelDSPFinishPart
  | VercelDSPAbortPart
  | VercelDSPTextStartPart
  | VercelDSPTextDeltaPart
  | VercelDSPTextEndPart
  | VercelDSPToolInputStartPart
  | VercelDSPToolInputDeltaPart
  | VercelDSPToolOutputAvailablePart
  | VercelDSPToolOutputErrorPart
  | VercelDSPReasoningStartPart
  | VercelDSPReasoningDeltaPart
  | VercelDSPReasoningEndPart
  | VercelDSPStepStartPart
  | VercelDSPSourcePart
  | VercelDSPDataPart;

// Message lifecycle
export interface VercelDSPStartPart {
  type: 'start';
  messageId: string;
}

export interface VercelDSPFinishPart {
  type: 'finish';
  finishReason:
    | 'stop'
    | 'length'
    | 'content-filter'
    | 'tool-calls'
    | 'error'
    | 'other'
    | 'cancelled';
  /** Optional usage stats. Note: AI SDK v5 strict schema does not include this field. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface VercelDSPAbortPart {
  type: 'abort';
}

// Text content
export interface VercelDSPTextStartPart {
  type: 'text-start';
  id: string;
}

export interface VercelDSPTextDeltaPart {
  type: 'text-delta';
  id: string;
  delta: string;
}

export interface VercelDSPTextEndPart {
  type: 'text-end';
  id: string;
}

// Tool calls
//
// AI SDK v5 wire format (from `ai/dist/index.d.ts`):
//   tool-input-start       { toolCallId, toolName }
//   tool-input-delta       { toolCallId, inputTextDelta }
//   tool-output-available  { toolCallId, output }
//   tool-output-error      { toolCallId, errorText }
//
// Wave-24 correction: the previous `id` + `delta` + `tool-result` shapes
// were rejected by AI SDK v5's client-side Zod validator. Browser-based
// tool-invoking prompts would throw `AI_TypeValidationError` mid-stream
// and abort the chat. Server-side curl/unit tests didn't catch this
// because they don't run the client parser.
export interface VercelDSPToolInputStartPart {
  type: 'tool-input-start';
  toolCallId: string;
  toolName: string;
}

export interface VercelDSPToolInputDeltaPart {
  type: 'tool-input-delta';
  toolCallId: string;
  inputTextDelta: string;
}

/**
 * Tool-output (formerly `tool-result`). AI SDK v5 splits success and
 * error into distinct event types with different required fields.
 * We emit exactly one of these per tool invocation; callers decide
 * by inspecting `status` on the high-level wrapper before picking the
 * wire shape.
 */
export interface VercelDSPToolOutputAvailablePart {
  type: 'tool-output-available';
  toolCallId: string;
  output: unknown;
}

export interface VercelDSPToolOutputErrorPart {
  type: 'tool-output-error';
  toolCallId: string;
  errorText: string;
}

// Reasoning (chain-of-thought)
export interface VercelDSPReasoningStartPart {
  type: 'reasoning-start';
  id: string;
}

export interface VercelDSPReasoningDeltaPart {
  type: 'reasoning-delta';
  id: string;
  delta: string;
}

export interface VercelDSPReasoningEndPart {
  type: 'reasoning-end';
  id: string;
}

// Step markers (multi-step agent loops)
export interface VercelDSPStepStartPart {
  type: 'step-start';
  stepIndex?: number;
}

// Custom data
export interface VercelDSPSourcePart {
  type: 'source';
  value: {
    url?: string;
    title?: string;
    [key: string]: unknown;
  };
}

export interface VercelDSPDataPart {
  type: string; // 'data-*' prefix
  id: string;
  data: unknown;
  transient?: boolean;
}

/**
 * SSE Message format
 */
export interface SSEMessage {
  data: string; // JSON-stringified VercelDSPStreamPart
}

/**
 * Bridge State
 *
 * Tracks the conversion state as events stream through.
 */
export interface BridgeState {
  messageId: string;
  messageStarted: boolean;
  currentTextBlockId: string | null;
  currentToolBlockId: string | null;
  currentToolName: string | null;
  currentReasoningBlockId: string | null;
  toolInputBuffer: string;
  contentBlockIndex: number;
  stepIndex: number;
}
