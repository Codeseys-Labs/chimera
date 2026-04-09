import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { createElement, forwardRef, type ReactNode } from 'react';

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mock aws-amplify/auth
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn().mockResolvedValue({
    tokens: { idToken: { toString: () => 'tok', payload: {} } },
  }),
}));

// Mock api-client
vi.mock('../lib/api-client', () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
}));

// useAuth mock
const mockUseAuth = vi.fn();
vi.mock('../hooks/use-auth', () => ({
  useAuth: () => mockUseAuth(),
}));

// useSessions mock
const mockUseSessions = vi.fn();
vi.mock('../hooks/use-sessions', () => ({
  useSessions: (...args: unknown[]) => mockUseSessions(...args),
}));

// useChatSession + getMessageText mock
const mockSendMessage = vi.fn();
const mockStop = vi.fn();
const mockLoadSession = vi.fn();
const mockClearSession = vi.fn();

let chatState = {
  messages: [] as Array<{
    id: string;
    role: string;
    parts: Array<{ type: string; text: string }>;
  }>,
  isStreaming: false,
  isLoadingSession: false,
  error: undefined as Error | undefined,
  sendMessage: mockSendMessage,
  stop: mockStop,
  loadSession: mockLoadSession,
  clearSession: mockClearSession,
  sessionId: null as string | null,
};

vi.mock('../hooks/use-chat', () => ({
  useChatSession: () => chatState,
  getMessageText: (msg: { parts: Array<{ type: string; text?: string }> }) =>
    msg.parts
      .filter((p: { type: string }) => p.type === 'text')
      .map((p: { text?: string }) => p.text)
      .join(''),
}));

// Mock child components using async factory to avoid React 19 JSX dual-copy issue
vi.mock('../components/session-list', async () => {
  const React = await import('react');
  return {
    SessionList: ({ onNew }: { onNew: () => void }) =>
      React.createElement(
        'div',
        { 'data-testid': 'session-list' },
        React.createElement('button', { onClick: onNew }, 'New Session')
      ),
  };
});

vi.mock('../components/chat-message', async () => {
  const React = await import('react');
  return {
    ChatMessage: ({
      role,
      content,
      isStreaming,
    }: {
      role: string;
      content: string;
      isStreaming?: boolean;
    }) =>
      React.createElement(
        'div',
        { 'data-testid': `chat-message-${role}`, 'data-streaming': isStreaming },
        content
      ),
  };
});

// Mock UI components that use Radix primitives (forwardRef) to avoid dual React issue
vi.mock('../components/ui/scroll-area', async () => {
  const React = await import('react');
  return {
    ScrollArea: React.forwardRef(
      (
        { children, className, ...props }: { children: ReactNode; className?: string },
        ref: React.Ref<HTMLDivElement>
      ) => React.createElement('div', { ref, className, ...props }, children)
    ),
    ScrollBar: React.forwardRef((_props: Record<string, unknown>, ref: React.Ref<HTMLDivElement>) =>
      React.createElement('div', { ref })
    ),
  };
});

vi.mock('../components/ui/button', async () => {
  const React = await import('react');
  return {
    Button: React.forwardRef(
      (
        { children, asChild, variant, size, ...props }: Record<string, unknown>,
        ref: React.Ref<HTMLButtonElement>
      ) => {
        if (asChild) {
          // For asChild, render the child directly
          return children;
        }
        return React.createElement('button', { ref, ...props }, children);
      }
    ),
    buttonVariants: () => '',
  };
});

// Mock lucide-react icons
vi.mock('lucide-react', async () => {
  const React = await import('react');
  const iconFactory = (name: string) =>
    React.forwardRef((props: Record<string, unknown>, ref: React.Ref<SVGSVGElement>) =>
      React.createElement('svg', { ref, 'data-testid': `icon-${name}`, ...props })
    );
  return {
    Send: iconFactory('send'),
    Square: iconFactory('square'),
    Loader2: iconFactory('loader2'),
  };
});

// Polyfill scrollIntoView for jsdom
Element.prototype.scrollIntoView = vi.fn();

process.env.VITE_API_BASE_URL = 'https://api.test.com';

import { ChatPage } from '../pages/chat';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAuth.mockReturnValue({
      tenantId: 'tenant-1',
      userId: 'user-1',
      user: { userId: 'user-1', username: 'testuser' },
      isLoading: false,
      isAuthenticated: true,
      getAuthToken: vi.fn(),
      handleSignOut: vi.fn(),
    });

    mockUseSessions.mockReturnValue({
      data: { sessions: [] },
      isLoading: false,
      isError: false,
    });

    chatState = {
      messages: [],
      isStreaming: false,
      isLoadingSession: false,
      error: undefined,
      sendMessage: mockSendMessage,
      stop: mockStop,
      loadSession: mockLoadSession,
      clearSession: mockClearSession,
      sessionId: null,
    };
  });

  it('renders welcome message when no messages', () => {
    render(<ChatPage />);

    expect(screen.getByText('Welcome to Chimera')).toBeInTheDocument();
    expect(screen.getByText('Start a conversation with your AI assistant.')).toBeInTheDocument();
  });

  it('renders user message with correct content', () => {
    chatState.messages = [
      { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hello agent' }] },
    ];

    render(<ChatPage />);

    expect(screen.getByTestId('chat-message-user')).toHaveTextContent('Hello agent');
  });

  it('renders assistant message with markdown', () => {
    chatState.messages = [
      { id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] },
      {
        id: 'msg-2',
        role: 'assistant',
        parts: [{ type: 'text', text: '**Bold response**' }],
      },
    ];

    render(<ChatPage />);

    expect(screen.getByTestId('chat-message-assistant')).toHaveTextContent('**Bold response**');
  });

  it('shows loading spinner when isLoadingSession', () => {
    chatState.isLoadingSession = true;

    render(<ChatPage />);

    expect(screen.getByText('Loading conversation...')).toBeInTheDocument();
    // Welcome message should NOT appear while loading
    expect(screen.queryByText('Welcome to Chimera')).not.toBeInTheDocument();
  });

  it('send button is disabled when input is empty', () => {
    render(<ChatPage />);

    const sendButton = screen.getByRole('button', { name: 'Send' });
    expect(sendButton).toBeDisabled();
  });

  it('send button is disabled when streaming', () => {
    chatState.isStreaming = true;

    render(<ChatPage />);

    // When streaming, the stop button is shown instead of send
    const stopButton = screen.getByRole('button', { name: 'Stop' });
    expect(stopButton).toBeInTheDocument();
  });

  it('shows stop button when streaming', () => {
    chatState.isStreaming = true;

    render(<ChatPage />);

    const stopButton = screen.getByRole('button', { name: 'Stop' });
    expect(stopButton).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('textarea submits on Enter (without Shift)', () => {
    render(<ChatPage />);

    const textarea = screen.getByPlaceholderText('Type a message...');

    // Type text into the textarea
    fireEvent.change(textarea, { target: { value: 'Hello there' } });

    // Press Enter (no Shift) — should submit
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(mockSendMessage).toHaveBeenCalledWith('Hello there');
  });

  it('textarea does not submit on Shift+Enter', () => {
    render(<ChatPage />);

    const textarea = screen.getByPlaceholderText('Type a message...');
    fireEvent.change(textarea, { target: { value: 'Hello there' } });

    // Press Shift+Enter — should NOT submit
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('error message renders when error exists', () => {
    chatState.error = new Error('Stream connection failed');

    render(<ChatPage />);

    expect(screen.getByText('Stream connection failed')).toBeInTheDocument();
  });

  it('does not render error message when error is undefined', () => {
    chatState.error = undefined;

    render(<ChatPage />);

    expect(screen.queryByText('Stream connection failed')).not.toBeInTheDocument();
  });

  it('hides welcome message when messages exist', () => {
    chatState.messages = [{ id: 'msg-1', role: 'user', parts: [{ type: 'text', text: 'Hi' }] }];

    render(<ChatPage />);

    expect(screen.queryByText('Welcome to Chimera')).not.toBeInTheDocument();
  });
});
