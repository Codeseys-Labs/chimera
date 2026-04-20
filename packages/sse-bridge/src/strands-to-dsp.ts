/**
 * Strands to Vercel DSP Stream Converter
 *
 * Converts Strands/AgentCore streaming events into Vercel AI SDK
 * Data Stream Protocol (DSP) format for consumption by AI SDK frontends.
 */

import {
  StrandsStreamEvent,
  VercelDSPStreamPart,
  BridgeState,
  StrandsContentBlockStartEvent,
  StrandsContentBlockDeltaEvent,
} from './types';

/**
 * Main converter class that maintains state across stream events
 */
export class StrandsToDSPConverter {
  private state: BridgeState;
  private blockIdCounter = 0;

  constructor(messageId?: string) {
    this.state = {
      messageId: messageId || this.generateMessageId(),
      messageStarted: false,
      currentTextBlockId: null,
      currentToolBlockId: null,
      currentToolName: null,
      currentReasoningBlockId: null,
      toolInputBuffer: '',
      contentBlockIndex: 0,
      stepIndex: 0,
    };
  }

  /**
   * Convert a Strands event to zero or more Vercel DSP parts
   */
  public convert(event: StrandsStreamEvent): VercelDSPStreamPart[] {
    switch (event.type) {
      case 'messageStart':
        return this.handleMessageStart(event);
      case 'messageStop':
        return this.handleMessageStop(event);
      case 'contentBlockStart':
        return this.handleContentBlockStart(event);
      case 'contentBlockDelta':
        return this.handleContentBlockDelta(event);
      case 'contentBlockStop':
        return this.handleContentBlockStop(event);
      case 'metadata':
        return this.handleMetadata(event);
      case 'redaction':
        return this.handleRedaction(event);
      case 'toolResult':
        return this.handleToolResult(event);
      case 'toolStream':
        return this.handleToolStream(event);
      case 'stepStart':
        return this.handleStepStart(event);
      default:
        // Unknown event type
        return [];
    }
  }

  /**
   * Generate a unique message ID
   */
  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Generate a unique block ID
   */
  private generateBlockId(type: 'text' | 'tool' | 'reasoning'): string {
    return `${type}_${this.blockIdCounter++}_${Date.now()}`;
  }

  /**
   * Handle messageStart event
   */
  private handleMessageStart(event: {
    type: 'messageStart';
    messageId?: string;
  }): VercelDSPStreamPart[] {
    if (event.messageId) {
      this.state.messageId = event.messageId;
    }

    // Only emit start if we haven't already (prevents duplicate starts in multi-step loops)
    if (!this.state.messageStarted) {
      this.state.messageStarted = true;
      return [
        {
          type: 'start',
          messageId: this.state.messageId,
        },
      ];
    }

    return [];
  }

  /**
   * Handle messageStop event
   */
  private handleMessageStop(event: {
    type: 'messageStop';
    stopReason: string;
    messageId?: string;
  }): VercelDSPStreamPart[] {
    const parts: VercelDSPStreamPart[] = [];

    // Close any open text block
    if (this.state.currentTextBlockId) {
      parts.push({
        type: 'text-end',
        id: this.state.currentTextBlockId,
      });
      this.state.currentTextBlockId = null;
    }

    // Close any open reasoning block
    if (this.state.currentReasoningBlockId) {
      parts.push({
        type: 'reasoning-end',
        id: this.state.currentReasoningBlockId,
      });
      this.state.currentReasoningBlockId = null;
    }

    // Close any open tool block (shouldn't happen, but be defensive)
    if (this.state.currentToolBlockId) {
      this.state.currentToolBlockId = null;
      this.state.currentToolName = null;
      this.state.toolInputBuffer = '';
    }

    // CRITICAL: Do NOT emit finish if stop reason is tool_use
    // The agent loop continues after tool execution, so this is not terminal
    if (event.stopReason === 'tool_use') {
      return parts; // Just close blocks, no finish event
    }

    // Map Strands stop reasons to Vercel DSP finish reasons
    const finishReason = this.mapStopReason(event.stopReason);

    parts.push({
      type: 'finish',
      finishReason,
    });

    return parts;
  }

  /**
   * Handle contentBlockStart event
   */
  private handleContentBlockStart(event: StrandsContentBlockStartEvent): VercelDSPStreamPart[] {
    const parts: VercelDSPStreamPart[] = [];

    if (event.contentBlock.type === 'text') {
      // Check if this is reasoning content (extended thinking)
      // Some models mark reasoning blocks explicitly
      const isReasoning = (event.contentBlock as any).reasoning === true;

      if (isReasoning) {
        // Start a reasoning block
        const reasoningId = event.contentBlock.id || this.generateBlockId('reasoning');
        this.state.currentReasoningBlockId = reasoningId;

        parts.push({
          type: 'reasoning-start',
          id: reasoningId,
        });
      } else {
        // Start a regular text block
        const textId = event.contentBlock.id || this.generateBlockId('text');
        this.state.currentTextBlockId = textId;

        parts.push({
          type: 'text-start',
          id: textId,
        });
      }
    } else if (event.contentBlock.type === 'tool_use') {
      // Start a new tool input block
      const toolId = event.contentBlock.id || this.generateBlockId('tool');
      const toolName = event.contentBlock.name || 'unknown_tool';

      this.state.currentToolBlockId = toolId;
      this.state.currentToolName = toolName;
      this.state.toolInputBuffer = '';

      parts.push({
        type: 'tool-input-start',
        id: toolId,
        toolName,
      });
    }

    return parts;
  }

  /**
   * Handle contentBlockDelta event
   */
  private handleContentBlockDelta(event: StrandsContentBlockDeltaEvent): VercelDSPStreamPart[] {
    const parts: VercelDSPStreamPart[] = [];

    if (event.delta.type === 'textDelta' && event.delta.text) {
      // Check if this is reasoning content (prioritize reasoning block if open)
      if (this.state.currentReasoningBlockId) {
        // Reasoning content delta
        parts.push({
          type: 'reasoning-delta',
          id: this.state.currentReasoningBlockId,
          delta: event.delta.text,
        });
      } else {
        // Text content delta
        if (!this.state.currentTextBlockId) {
          // No text block open - start one
          const textId = this.generateBlockId('text');
          this.state.currentTextBlockId = textId;
          parts.push({
            type: 'text-start',
            id: textId,
          });
        }

        parts.push({
          type: 'text-delta',
          id: this.state.currentTextBlockId,
          delta: event.delta.text,
        });
      }
    } else if (event.delta.type === 'toolInputDelta' && event.delta.input) {
      // Tool input delta (partial JSON)
      if (!this.state.currentToolBlockId) {
        // No tool block open - start one (defensive)
        const toolId = this.generateBlockId('tool');
        this.state.currentToolBlockId = toolId;
        this.state.currentToolName = 'unknown_tool';
        parts.push({
          type: 'tool-input-start',
          id: toolId,
          toolName: 'unknown_tool',
        });
      }

      this.state.toolInputBuffer += event.delta.input;

      parts.push({
        type: 'tool-input-delta',
        id: this.state.currentToolBlockId,
        delta: event.delta.input,
      });
    }

    return parts;
  }

  /**
   * Handle contentBlockStop event
   */
  private handleContentBlockStop(event: {
    type: 'contentBlockStop';
    contentBlockIndex: number;
  }): VercelDSPStreamPart[] {
    const parts: VercelDSPStreamPart[] = [];

    // Close text block if open
    if (this.state.currentTextBlockId) {
      parts.push({
        type: 'text-end',
        id: this.state.currentTextBlockId,
      });
      this.state.currentTextBlockId = null;
    }

    // Close reasoning block if open
    if (this.state.currentReasoningBlockId) {
      parts.push({
        type: 'reasoning-end',
        id: this.state.currentReasoningBlockId,
      });
      this.state.currentReasoningBlockId = null;
    }

    // For tool blocks, we don't emit tool-result here because
    // Strands will emit a separate toolResult event later.
    // Just clear the state.
    if (this.state.currentToolBlockId) {
      this.state.currentToolBlockId = null;
      this.state.currentToolName = null;
      this.state.toolInputBuffer = '';
    }

    return parts;
  }

  /**
   * Handle metadata event (usage statistics)
   */
  private handleMetadata(event: {
    type: 'metadata';
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
  }): VercelDSPStreamPart[] {
    // Store usage data to be included in the finish event
    // For now, we'll emit it as a data part for observability
    return [
      {
        type: 'data-usage',
        id: `usage_${Date.now()}`,
        data: {
          promptTokens: event.usage.inputTokens,
          completionTokens: event.usage.outputTokens,
          totalTokens: event.usage.totalTokens,
        },
        transient: true, // Don't persist in message history
      },
    ];
  }

  /**
   * Handle redaction event (guardrail interventions)
   */
  private handleRedaction(event: {
    type: 'redaction';
    redaction: { reason: string; text: string };
  }): VercelDSPStreamPart[] {
    // Emit redaction as a data part
    return [
      {
        type: 'data-redaction',
        id: `redaction_${Date.now()}`,
        data: {
          reason: event.redaction.reason,
          text: event.redaction.text,
        },
        transient: false, // Persist redaction in history
      },
    ];
  }

  /**
   * Map Strands stop reasons to Vercel DSP finish reasons
   */
  private mapStopReason(
    strandsReason: string
  ): 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'cancelled' {
    switch (strandsReason) {
      case 'end_turn':
        return 'stop';
      case 'tool_use':
        return 'tool-calls';
      case 'max_tokens':
        return 'length';
      case 'content_filtered':
      case 'guardrail_intervention':
        return 'content-filter';
      case 'cancelled':
        return 'cancelled';
      case 'stop_sequence':
        return 'stop';
      default:
        return 'other';
    }
  }

  /**
   * Handle toolResult event (when tool execution completes)
   *
   * Propagates the required `status` and optional `error` fields so that tool
   * failures cannot silently be interpreted as success downstream (review C3).
   * If an upstream producer drops a malformed event without `status`, we
   * default to `'error'` (fail-closed) and extract any error string from the
   * result for diagnostics.
   */
  private handleToolResult(event: {
    type: 'toolResult';
    toolUseId: string;
    result: unknown;
    status?: 'success' | 'error';
    error?: string;
  }): VercelDSPStreamPart[] {
    // Fail-closed: if status is missing, treat as error so downstream
    // consumers cannot confuse a malformed event with a successful tool call.
    const status: 'success' | 'error' = event.status ?? 'error';
    const errorMessage =
      event.error ??
      (status === 'error' ? this.extractErrorFromResult(event.result) : undefined);

    return [
      {
        type: 'tool-result',
        id: event.toolUseId,
        result: event.result,
        status,
        ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      },
    ];
  }

  /**
   * Best-effort extraction of an error string from a tool result payload.
   * Tools typically return `{ error: '...' }` or `{ message: '...' }` on failure.
   */
  private extractErrorFromResult(result: unknown): string | undefined {
    if (!result || typeof result !== 'object') return undefined;
    const r = result as Record<string, unknown>;
    if (typeof r.error === 'string') return r.error;
    if (typeof r.message === 'string') return r.message;
    return undefined;
  }

  /**
   * Handle toolStream event (intermediate tool execution updates)
   */
  private handleToolStream(event: {
    type: 'toolStream';
    toolUseId: string;
    delta: string;
  }): VercelDSPStreamPart[] {
    // Emit tool stream updates as transient data parts
    return [
      {
        type: 'data-tool-stream',
        id: `tool-stream-${event.toolUseId}-${Date.now()}`,
        data: {
          toolUseId: event.toolUseId,
          delta: event.delta,
        },
        transient: true,
      },
    ];
  }

  /**
   * Handle stepStart event (multi-step agent loop markers)
   */
  private handleStepStart(event: { type: 'stepStart'; stepIndex?: number }): VercelDSPStreamPart[] {
    if (event.stepIndex !== undefined) {
      this.state.stepIndex = event.stepIndex;
    } else {
      this.state.stepIndex++;
    }

    return [
      {
        type: 'step-start',
        stepIndex: this.state.stepIndex,
      },
    ];
  }

  /**
   * Get the current message ID
   */
  public getMessageId(): string {
    return this.state.messageId;
  }

  /**
   * Reset the converter state for a new message
   */
  public reset(messageId?: string): void {
    this.state = {
      messageId: messageId || this.generateMessageId(),
      messageStarted: false,
      currentTextBlockId: null,
      currentToolBlockId: null,
      currentToolName: null,
      currentReasoningBlockId: null,
      toolInputBuffer: '',
      contentBlockIndex: 0,
      stepIndex: 0,
    };
    this.blockIdCounter = 0;
  }
}
