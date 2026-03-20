/**
 * Express + Strands SSE Bridge Example
 *
 * Demonstrates streaming from a Strands agent to an AI SDK frontend.
 */

import express from 'express';
import { StrandsToDSPBridge, createSSEResponseStream } from '@chimera/sse-bridge';

const app = express();
app.use(express.json());

// Mock Strands agent stream
async function* mockStrandsAgentStream(prompt: string) {
  // In production, this would be: agent.stream_async(prompt)

  yield { type: 'messageStart' as const };

  yield {
    type: 'contentBlockStart' as const,
    contentBlock: { type: 'text' as const, id: 'text_001' },
  };

  const words = 'Hello! I understand you asked about AI agents.'.split(' ');
  for (const word of words) {
    yield {
      type: 'contentBlockDelta' as const,
      delta: { type: 'textDelta' as const, text: word + ' ' },
      contentBlockIndex: 0,
    };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  yield { type: 'contentBlockStop' as const, contentBlockIndex: 0 };

  yield {
    type: 'metadata' as const,
    usage: { inputTokens: 10, outputTokens: 25, totalTokens: 35 },
  };

  yield { type: 'messageStop' as const, stopReason: 'end_turn' };
}

app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  const userMessage = messages[messages.length - 1]?.content || 'Hello';

  console.log('Received chat request:', userMessage);

  try {
    const bridge = new StrandsToDSPBridge();
    const writer = createSSEResponseStream(res);

    const strandsEvents = mockStrandsAgentStream(userMessage);

    for await (const event of strandsEvents) {
      const dspParts = bridge.convert(event);
      await writer.writeAll(dspParts);
    }

    await writer.close();
  } catch (error) {
    console.error('Streaming error:', error);
    res.status(500).json({ error: 'Stream failed' });
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`SSE Bridge example listening on http://localhost:${PORT}`);
  console.log(`Test with: curl -X POST http://localhost:${PORT}/api/chat -H "Content-Type: application/json" -d '{"messages":[{"role":"user","content":"Hello"}]}'`);
});
