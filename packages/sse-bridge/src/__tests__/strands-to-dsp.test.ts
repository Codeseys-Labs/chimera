/**
 * Tests for Strands to DSP conversion
 */

import { StrandsToDSPConverter } from '../strands-to-dsp';
import {
  StrandsStreamEvent,
  VercelDSPStreamPart,
  VercelDSPStartPart,
  VercelDSPFinishPart,
  VercelDSPTextStartPart,
  VercelDSPTextDeltaPart,
  VercelDSPTextEndPart,
} from '../types';

describe('StrandsToDSPConverter', () => {
  let converter: StrandsToDSPConverter;

  beforeEach(() => {
    converter = new StrandsToDSPConverter('test-msg-123');
  });

  describe('Message lifecycle', () => {
    it('should convert messageStart to start event', () => {
      const event: StrandsStreamEvent = {
        type: 'messageStart',
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        type: 'start',
        messageId: 'test-msg-123',
      });
    });

    it('should convert messageStop to finish event', () => {
      const event: StrandsStreamEvent = {
        type: 'messageStop',
        stopReason: 'end_turn',
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      const finishPart = result[0] as VercelDSPFinishPart;
      expect(finishPart.type).toBe('finish');
      expect(finishPart.finishReason).toBe('stop');
    });

    it('should map stop reasons correctly', () => {
      const testCases: Array<[string, string | null]> = [
        ['end_turn', 'stop'],
        ['tool_use', null], // Should NOT emit finish - loop continues
        ['max_tokens', 'length'],
        ['content_filtered', 'content-filter'],
        ['guardrail_intervention', 'content-filter'],
        ['cancelled', 'cancelled'],
        ['stop_sequence', 'stop'],
      ];

      for (const [strandsReason, dspReason] of testCases) {
        const converter = new StrandsToDSPConverter();
        const event: StrandsStreamEvent = {
          type: 'messageStop',
          stopReason: strandsReason as any,
        };

        const result = converter.convert(event);

        if (dspReason === null) {
          // tool_use should NOT emit finish
          expect(result.find((p) => p.type === 'finish')).toBeUndefined();
        } else {
          const finishPart = result.find((p) => p.type === 'finish') as VercelDSPFinishPart;
          expect(finishPart).toBeDefined();
          expect(finishPart.finishReason).toBe(dspReason);
        }
      }
    });
  });

  describe('Text content streaming', () => {
    it('should handle complete text block sequence', () => {
      const events: StrandsStreamEvent[] = [
        { type: 'messageStart' },
        {
          type: 'contentBlockStart',
          contentBlock: { type: 'text', id: 'text_001' },
        },
        {
          type: 'contentBlockDelta',
          delta: { type: 'textDelta', text: 'Hello' },
          contentBlockIndex: 0,
        },
        {
          type: 'contentBlockDelta',
          delta: { type: 'textDelta', text: ' world' },
          contentBlockIndex: 0,
        },
        { type: 'contentBlockStop', contentBlockIndex: 0 },
        { type: 'messageStop', stopReason: 'end_turn' },
      ];

      const allParts: VercelDSPStreamPart[] = [];
      for (const event of events) {
        allParts.push(...converter.convert(event));
      }

      expect(allParts).toHaveLength(6); // start, text-start, 2x text-delta, text-end, finish

      const types = allParts.map((p) => p.type);
      expect(types).toEqual([
        'start',
        'text-start',
        'text-delta',
        'text-delta',
        'text-end',
        'finish',
      ]);

      const textDeltas = allParts.filter((p) => p.type === 'text-delta') as VercelDSPTextDeltaPart[];
      expect(textDeltas[0].delta).toBe('Hello');
      expect(textDeltas[1].delta).toBe(' world');
    });

    it('should auto-start text block if delta arrives without start', () => {
      const event: StrandsStreamEvent = {
        type: 'contentBlockDelta',
        delta: { type: 'textDelta', text: 'Surprise text' },
        contentBlockIndex: 0,
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('text-start');
      expect(result[1].type).toBe('text-delta');
      expect((result[1] as VercelDSPTextDeltaPart).delta).toBe('Surprise text');
    });
  });

  describe('Tool call streaming', () => {
    it('should handle tool input sequence', () => {
      const events: StrandsStreamEvent[] = [
        { type: 'messageStart' },
        {
          type: 'contentBlockStart',
          contentBlock: { type: 'tool_use', id: 'tool_001', name: 'search' },
        },
        {
          type: 'contentBlockDelta',
          delta: { type: 'toolInputDelta', input: '{"query"' },
          contentBlockIndex: 0,
        },
        {
          type: 'contentBlockDelta',
          delta: { type: 'toolInputDelta', input: ':"AI"}' },
          contentBlockIndex: 0,
        },
        { type: 'contentBlockStop', contentBlockIndex: 0 },
        { type: 'messageStop', stopReason: 'tool_use' }, // Should NOT emit finish
      ];

      const allParts: VercelDSPStreamPart[] = [];
      for (const event of events) {
        allParts.push(...converter.convert(event));
      }

      const types = allParts.map((p) => p.type);
      expect(types).toEqual([
        'start',
        'tool-input-start',
        'tool-input-delta',
        'tool-input-delta',
        // NO finish event - loop continues after tool execution
      ]);

      const toolStart = allParts.find((p) => p.type === 'tool-input-start') as any;
      expect(toolStart.toolName).toBe('search');
      expect(toolStart.id).toBe('tool_001');
    });
  });

  describe('Metadata handling', () => {
    it('should convert usage metadata to transient data part', () => {
      const event: StrandsStreamEvent = {
        type: 'metadata',
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
        },
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      const part = result[0] as any;
      expect(part.type).toBe('data-usage');
      expect(part.transient).toBe(true);
      expect(part.data).toMatchObject({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      });
    });
  });

  describe('Redaction handling', () => {
    it('should convert guardrail redactions to data parts', () => {
      const event: StrandsStreamEvent = {
        type: 'redaction',
        redaction: {
          reason: 'PII detected',
          text: '[REDACTED]',
        },
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      const part = result[0] as any;
      expect(part.type).toBe('data-redaction');
      expect(part.transient).toBe(false); // Persist redactions
      expect(part.data).toMatchObject({
        reason: 'PII detected',
        text: '[REDACTED]',
      });
    });
  });

  describe('Tool result handling', () => {
    it('should convert toolResult event to tool-result part', () => {
      const event: StrandsStreamEvent = {
        type: 'toolResult',
        toolUseId: 'tool_001',
        result: { data: 'search results' },
        status: 'success',
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      const part = result[0] as any;
      expect(part.type).toBe('tool-result');
      expect(part.id).toBe('tool_001');
      expect(part.result).toEqual({ data: 'search results' });
    });

    it('should handle tool stream updates', () => {
      const event: StrandsStreamEvent = {
        type: 'toolStream',
        toolUseId: 'tool_002',
        delta: 'Processing...',
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      const part = result[0] as any;
      expect(part.type).toBe('data-tool-stream');
      expect(part.transient).toBe(true);
      expect(part.data.toolUseId).toBe('tool_002');
      expect(part.data.delta).toBe('Processing...');
    });
  });

  describe('Step tracking', () => {
    it('should emit step-start event', () => {
      const event: StrandsStreamEvent = {
        type: 'stepStart',
        stepIndex: 1,
      };

      const result = converter.convert(event);

      expect(result).toHaveLength(1);
      const part = result[0] as any;
      expect(part.type).toBe('step-start');
      expect(part.stepIndex).toBe(1);
    });

    it('should auto-increment step index if not provided', () => {
      converter.convert({ type: 'stepStart' });
      const result = converter.convert({ type: 'stepStart' });

      const part = result[0] as any;
      expect(part.stepIndex).toBe(2); // Should increment
    });
  });

  describe('Multi-step loop handling', () => {
    it('should not emit finish on tool_use stop reason', () => {
      const events: StrandsStreamEvent[] = [
        { type: 'messageStart' },
        {
          type: 'contentBlockStart',
          contentBlock: { type: 'tool_use', id: 'tool_001', name: 'search' },
        },
        { type: 'contentBlockStop', contentBlockIndex: 0 },
        { type: 'messageStop', stopReason: 'tool_use' }, // Should NOT finish
      ];

      const allParts: VercelDSPStreamPart[] = [];
      for (const event of events) {
        allParts.push(...converter.convert(event));
      }

      const types = allParts.map((p) => p.type);
      expect(types).not.toContain('finish'); // Critical: no finish event
      expect(types).toContain('start');
    });

    it('should not emit duplicate start events in multi-step loops', () => {
      const converter = new StrandsToDSPConverter();

      // Simulate multi-step loop
      converter.convert({ type: 'messageStart' }); // First step
      converter.convert({ type: 'messageStop', stopReason: 'tool_use' });
      const result = converter.convert({ type: 'messageStart' }); // Second step

      expect(result).toHaveLength(0); // Should not emit another start
    });
  });

  describe('State management', () => {
    it('should close open text block on messageStop', () => {
      const events: StrandsStreamEvent[] = [
        { type: 'messageStart' },
        {
          type: 'contentBlockStart',
          contentBlock: { type: 'text', id: 'text_001' },
        },
        {
          type: 'contentBlockDelta',
          delta: { type: 'textDelta', text: 'Test' },
          contentBlockIndex: 0,
        },
        // messageStop without contentBlockStop
        { type: 'messageStop', stopReason: 'end_turn' },
      ];

      const allParts: VercelDSPStreamPart[] = [];
      for (const event of events) {
        allParts.push(...converter.convert(event));
      }

      const types = allParts.map((p) => p.type);
      expect(types).toContain('text-end'); // Should auto-close
      expect(types).toContain('finish');
    });

    it('should reset state correctly', () => {
      converter.convert({ type: 'messageStart' });
      converter.convert({
        type: 'contentBlockStart',
        contentBlock: { type: 'text', id: 'text_001' },
      });

      converter.reset('new-msg-456');

      expect(converter.getMessageId()).toBe('new-msg-456');

      // Should start fresh
      const result = converter.convert({ type: 'messageStart' });
      expect((result[0] as VercelDSPStartPart).messageId).toBe('new-msg-456');
    });
  });
});
