/**
 * @deprecated Tests for the old custom SSE client.
 * The SSE parsing is now handled by @ai-sdk/react's DefaultChatTransport.
 * These tests are kept as a placeholder to avoid test runner errors.
 * Replace with integration tests for the useChatSession hook.
 */

import { describe, it, expect } from 'vitest';

describe('sse-client (deprecated)', () => {
  it('module exports empty object', async () => {
    const mod = await import('../lib/sse-client');
    expect(mod).toBeDefined();
  });
});
