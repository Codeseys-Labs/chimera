import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock aws-amplify/auth
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn().mockResolvedValue({
    tokens: { idToken: { toString: () => 'tok', payload: {} } },
  }),
}));

// Mock api-client
vi.mock('../lib/api-client', () => ({
  apiGet: vi.fn(),
}));

// Mock @ai-sdk/react useChat
const mockAiSendMessage = vi.fn();
const mockStop = vi.fn();
const mockSetMessages = vi.fn();
const mockRegenerate = vi.fn();

let mockStatus = 'ready';
let mockMessages: unknown[] = [];
let mockError: Error | undefined = undefined;

vi.mock('@ai-sdk/react', () => ({
  useChat: vi.fn(() => ({
    messages: mockMessages,
    sendMessage: mockAiSendMessage,
    status: mockStatus,
    stop: mockStop,
    setMessages: mockSetMessages,
    error: mockError,
    regenerate: mockRegenerate,
  })),
}));

// Mock ai module — DefaultChatTransport
vi.mock('ai', () => ({
  DefaultChatTransport: vi.fn().mockImplementation(() => ({})),
}));

// Set env
process.env.VITE_API_BASE_URL = 'https://api.test.com';

import { useChatSession, getMessageText } from '../hooks/use-chat';
import type { UIMessage } from '@ai-sdk/react';
import { apiGet } from '../lib/api-client';

const mockApiGet = apiGet as ReturnType<typeof vi.fn>;

describe('getMessageText', () => {
  it('extracts text from UIMessage parts', () => {
    const msg = {
      id: '1',
      role: 'user',
      parts: [{ type: 'text', text: 'Hello world' }],
    } as UIMessage;
    expect(getMessageText(msg)).toBe('Hello world');
  });

  it('joins multiple text parts', () => {
    const msg = {
      id: '2',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Part one' },
        { type: 'text', text: ' and part two' },
      ],
    } as UIMessage;
    expect(getMessageText(msg)).toBe('Part one and part two');
  });

  it('returns empty string for no text parts', () => {
    const msg = {
      id: '3',
      role: 'assistant',
      parts: [{ type: 'tool-invocation', toolInvocation: {} }],
    } as unknown as UIMessage;
    expect(getMessageText(msg)).toBe('');
  });
});

describe('useChatSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStatus = 'ready';
    mockMessages = [];
    mockError = undefined;
    // Re-setup mocks after reset
    mockStop.mockImplementation(() => {});
    mockSetMessages.mockImplementation(() => {});
    mockAiSendMessage.mockImplementation(() => {});
    mockRegenerate.mockImplementation(() => {});
  });

  it('sendMessage calls aiSendMessage with text', () => {
    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    act(() => {
      result.current.sendMessage('Hello agent');
    });

    expect(mockAiSendMessage).toHaveBeenCalledWith({ text: 'Hello agent' });
  });

  it('sendMessage ignores empty input', () => {
    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    act(() => {
      result.current.sendMessage('');
    });

    expect(mockAiSendMessage).not.toHaveBeenCalled();
  });

  it('sendMessage ignores whitespace-only input', () => {
    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    act(() => {
      result.current.sendMessage('   ');
    });

    expect(mockAiSendMessage).not.toHaveBeenCalled();
  });

  it('sendMessage ignores when isStreaming is true', () => {
    mockStatus = 'streaming';

    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    act(() => {
      result.current.sendMessage('Hello');
    });

    expect(mockAiSendMessage).not.toHaveBeenCalled();
  });

  it('sendMessage ignores when status is submitted', () => {
    mockStatus = 'submitted';

    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    act(() => {
      result.current.sendMessage('Hello');
    });

    expect(mockAiSendMessage).not.toHaveBeenCalled();
  });

  it('clearSession resets messages and sessionId', () => {
    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    act(() => {
      result.current.clearSession();
    });

    expect(mockStop).toHaveBeenCalled();
    expect(mockSetMessages).toHaveBeenCalledWith([]);
    expect(result.current.sessionId).toBeNull();
  });

  it('loadSession fetches messages from API and sets them', async () => {
    mockApiGet.mockResolvedValue({
      sessionId: 'session-abc',
      messages: [
        {
          messageId: 'msg-1',
          role: 'user',
          content: 'Hi there',
          status: 'complete',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          messageId: 'msg-2',
          role: 'assistant',
          content: 'Hello! How can I help?',
          status: 'complete',
          createdAt: '2026-01-01T00:00:01Z',
        },
      ],
      count: 2,
    });

    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    await act(async () => {
      await result.current.loadSession('session-abc');
    });

    expect(mockStop).toHaveBeenCalled();
    expect(mockApiGet).toHaveBeenCalledWith('/chat/sessions/session-abc/messages?limit=200');
    expect(mockSetMessages).toHaveBeenCalledWith([
      {
        id: 'msg-1',
        role: 'user',
        parts: [{ type: 'text', text: 'Hi there' }],
      },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello! How can I help?' }],
      },
    ]);
    expect(result.current.sessionId).toBe('session-abc');
  });

  it('loadSession handles API error gracefully', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApiGet.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    await act(async () => {
      await result.current.loadSession('bad-session');
    });

    // Should not throw, just log
    expect(consoleSpy).toHaveBeenCalled();
    expect(mockSetMessages).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('exposes isStreaming as true when status is streaming', () => {
    mockStatus = 'streaming';

    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    expect(result.current.isStreaming).toBe(true);
  });

  it('exposes isStreaming as false when status is ready', () => {
    mockStatus = 'ready';

    const { result } = renderHook(() => useChatSession({ tenantId: 'tenant-1' }));

    expect(result.current.isStreaming).toBe(false);
  });
});
