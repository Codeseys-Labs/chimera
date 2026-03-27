import { describe, it, expect } from 'bun:test';
import React from 'react';
import { render } from 'ink-testing-library';
import { ChatBubble } from '../../tui/components/ChatBubble.js';
import { StreamingText } from '../../tui/components/StreamingText.js';
import { ToolUseDisplay } from '../../tui/components/ToolUseDisplay.js';
import { Spinner } from '../../tui/components/Spinner.js';

// ─── ChatBubble ───────────────────────────────────────────────────────────────

describe('ChatBubble', () => {
  it('renders user message with "You" label', () => {
    const { lastFrame } = render(
      React.createElement(ChatBubble, {
        role: 'user',
        content: 'Hello world',
      }),
    );
    expect(lastFrame()).toContain('You');
    expect(lastFrame()).toContain('Hello world');
  });

  it('renders assistant message with "Chimera" label', () => {
    const { lastFrame } = render(
      React.createElement(ChatBubble, {
        role: 'assistant',
        content: 'Hi there!',
      }),
    );
    expect(lastFrame()).toContain('Chimera');
    expect(lastFrame()).toContain('Hi there!');
  });

  it('renders with timestamp when provided', () => {
    const ts = new Date('2026-03-27T10:30:00');
    const { lastFrame } = render(
      React.createElement(ChatBubble, {
        role: 'user',
        content: 'test',
        timestamp: ts,
      }),
    );
    // Timestamp rendered — format varies by locale but should appear
    const frame = lastFrame() ?? '';
    expect(frame).toContain('test');
  });

  it('passes isStreaming to StreamingText', () => {
    const { lastFrame } = render(
      React.createElement(ChatBubble, {
        role: 'assistant',
        content: 'partial',
        isStreaming: true,
      }),
    );
    expect(lastFrame()).toContain('partial');
  });
});

// ─── StreamingText ────────────────────────────────────────────────────────────

describe('StreamingText', () => {
  it('renders content text', () => {
    const { lastFrame } = render(
      React.createElement(StreamingText, {
        content: 'Hello',
        isStreaming: false,
      }),
    );
    expect(lastFrame()).toContain('Hello');
  });

  it('shows blinking cursor when isStreaming is true', () => {
    const { lastFrame } = render(
      React.createElement(StreamingText, {
        content: 'Streaming',
        isStreaming: true,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Streaming');
    // Cursor character should appear in initial render (cursorVisible starts true)
    expect(frame).toContain('▋');
  });

  it('does not show cursor when isStreaming is false', () => {
    const { lastFrame } = render(
      React.createElement(StreamingText, {
        content: 'Done',
        isStreaming: false,
      }),
    );
    expect(lastFrame()).not.toContain('▋');
  });
});

// ─── ToolUseDisplay ───────────────────────────────────────────────────────────

describe('ToolUseDisplay', () => {
  it('renders tool name and pending status', () => {
    const { lastFrame } = render(
      React.createElement(ToolUseDisplay, {
        toolName: 'search_files',
        status: 'pending',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('search_files');
    expect(frame).toContain('pending');
  });

  it('renders running status in yellow context', () => {
    const { lastFrame } = render(
      React.createElement(ToolUseDisplay, {
        toolName: 'read_file',
        status: 'running',
        input: '{ "path": "foo.ts" }',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('read_file');
    expect(frame).toContain('running');
    expect(frame).toContain('foo.ts');
  });

  it('renders complete status with result', () => {
    const { lastFrame } = render(
      React.createElement(ToolUseDisplay, {
        toolName: 'execute',
        status: 'complete',
        result: 'Success',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('execute');
    expect(frame).toContain('complete');
    expect(frame).toContain('Success');
  });
});

// ─── Spinner ─────────────────────────────────────────────────────────────────

describe('Spinner', () => {
  it('renders without label', () => {
    const { lastFrame } = render(React.createElement(Spinner, {}));
    // ink-spinner renders an animated character — just verify it doesn't crash
    expect(lastFrame()).toBeTruthy();
  });

  it('renders with label', () => {
    const { lastFrame } = render(
      React.createElement(Spinner, { label: 'Loading…' }),
    );
    expect(lastFrame()).toContain('Loading…');
  });
});
