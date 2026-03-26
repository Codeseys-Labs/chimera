/**
 * Agent Lifecycle Integration Tests
 *
 * Tests that the Agent class correctly invokes the model backend and
 * manages conversation state through its lifecycle.
 *
 * Uses mock-agent-backend fixture to avoid real Bedrock calls.
 */

import { describe, it, expect } from 'bun:test';
import { createMockAgentBackend, createSequentialMockBackend } from './fixtures/mock-agent-backend';

// ---------------------------------------------------------------------------
// mock-agent-backend fixture tests (verify the fixture itself is correct)
// ---------------------------------------------------------------------------

describe('mock-agent-backend fixture', () => {
  it('returns configured response text', async () => {
    const backend = createMockAgentBackend({ response: 'Hello from mock!' });

    const result = await backend.converse({
      messages: [{ role: 'user', content: [{ text: 'Hi' }] }],
    });

    expect(result.output.message.role).toBe('assistant');
    expect(result.output.message.content[0].text).toBe('Hello from mock!');
    expect(result.stopReason).toBe('end_turn');
  });

  it('records all converse() calls', async () => {
    const backend = createMockAgentBackend();

    await backend.converse({ messages: [{ role: 'user', content: [{ text: 'First' }] }] });
    await backend.converse({ messages: [{ role: 'user', content: [{ text: 'Second' }] }] });

    expect(backend.calls).toHaveLength(2);
  });

  it('throws configured error', async () => {
    const backend = createMockAgentBackend({
      error: new Error('Bedrock throttled'),
    });

    await expect(
      backend.converse({ messages: [{ role: 'user', content: [{ text: 'Hi' }] }] })
    ).rejects.toThrow('Bedrock throttled');
  });

  it('returns tool use block when configured', async () => {
    const backend = createMockAgentBackend({
      toolUse: {
        toolUseId: 'tool-001',
        name: 'bash_tool',
        input: { command: 'ls -la' },
      },
    });

    const result = await backend.converse({
      messages: [{ role: 'user', content: [{ text: 'List files' }] }],
    });

    const toolBlock = result.output.message.content.find(b => b.toolUse);
    expect(toolBlock).toBeDefined();
    expect(toolBlock?.toolUse?.name).toBe('bash_tool');
    expect(toolBlock?.toolUse?.input).toEqual({ command: 'ls -la' });
  });

  it('reset() clears recorded calls', async () => {
    const backend = createMockAgentBackend();
    await backend.converse({ messages: [{ role: 'user', content: [{ text: 'Test' }] }] });

    backend.reset();

    expect(backend.calls).toHaveLength(0);
  });

  it('allows custom stop reason', async () => {
    const backend = createMockAgentBackend({ stopReason: 'tool_use' });
    const result = await backend.converse({
      messages: [{ role: 'user', content: [{ text: 'Use a tool' }] }],
    });
    expect(result.stopReason).toBe('tool_use');
  });
});

// ---------------------------------------------------------------------------
// createSequentialMockBackend fixture tests
// ---------------------------------------------------------------------------

describe('createSequentialMockBackend fixture', () => {
  it('cycles through responses in order', async () => {
    const backend = createSequentialMockBackend(['First', 'Second', 'Third']);

    const r1 = await backend.converse({ messages: [{ role: 'user', content: [{ text: 'a' }] }] });
    const r2 = await backend.converse({ messages: [{ role: 'user', content: [{ text: 'b' }] }] });
    const r3 = await backend.converse({ messages: [{ role: 'user', content: [{ text: 'c' }] }] });

    expect(r1.output.message.content[0].text).toBe('First');
    expect(r2.output.message.content[0].text).toBe('Second');
    expect(r3.output.message.content[0].text).toBe('Third');
  });

  it('wraps back to first response after exhausting list', async () => {
    const backend = createSequentialMockBackend(['A', 'B']);

    await backend.converse({ messages: [{ role: 'user', content: [{ text: '1' }] }] }); // A
    await backend.converse({ messages: [{ role: 'user', content: [{ text: '2' }] }] }); // B
    const r3 = await backend.converse({ messages: [{ role: 'user', content: [{ text: '3' }] }] }); // wraps to A

    expect(r3.output.message.content[0].text).toBe('A');
  });

  it('records all calls', async () => {
    const backend = createSequentialMockBackend(['R1', 'R2']);

    await backend.converse({ messages: [{ role: 'user', content: [{ text: 'x' }] }] });
    await backend.converse({ messages: [{ role: 'user', content: [{ text: 'y' }] }] });

    expect(backend.calls).toHaveLength(2);
  });

  it('reset() clears calls and resets call index', async () => {
    const backend = createSequentialMockBackend(['First', 'Second']);
    await backend.converse({ messages: [{ role: 'user', content: [{ text: 'x' }] }] }); // First

    backend.reset();

    const r = await backend.converse({ messages: [{ role: 'user', content: [{ text: 'y' }] }] });
    expect(r.output.message.content[0].text).toBe('First'); // reset restarts from index 0
    expect(backend.calls).toHaveLength(1);
  });
});
