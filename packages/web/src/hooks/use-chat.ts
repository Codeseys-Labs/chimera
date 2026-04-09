import { useChat as useAIChat, type UIMessage } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useCallback, useMemo, useRef, useState } from 'react';
import { fetchAuthSession } from 'aws-amplify/auth';
import { apiGet } from '@/lib/api-client';

/** Shape returned by GET /chat/sessions/:id/messages */
interface PersistedMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  status: 'complete' | 'streaming' | 'error';
  finishReason?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
}

interface SessionMessagesResponse {
  sessionId: string;
  messages: PersistedMessage[];
  count: number;
  nextCursor?: string;
}

interface UseChatSessionOptions {
  tenantId: string;
}

/** Get text content from a UIMessage's parts array */
export function getMessageText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/**
 * Custom fetch wrapper that injects the Cognito ID token and captures the
 * X-Session-Id response header from the gateway.
 *
 * The AI SDK's DefaultChatTransport resolves `headers` separately and
 * merges them into the fetch init. This wrapper also injects the token
 * as a belt-and-suspenders measure.
 */
function createAuthFetch(onSessionId: (id: string) => void) {
  return async (
    input: string | URL | globalThis.Request,
    init?: RequestInit
  ): Promise<Response> => {
    const existingHeaders = (init?.headers ?? {}) as Record<string, string>;

    // Always inject the Cognito token
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    const headers: Record<string, string> = {
      ...existingHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    const response = await globalThis.fetch(input, {
      ...init,
      headers,
    });

    // Capture session ID from gateway response header
    const sid = response.headers.get('X-Session-Id');
    if (sid) onSessionId(sid);

    return response;
  };
}

/**
 * Chat hook that wraps @ai-sdk/react v2's useChat with:
 * - Cognito JWT authentication via custom fetch
 * - Session management (load/switch/clear sessions)
 * - Session ID tracking from gateway X-Session-Id header
 * - Tenant context injection into request body
 *
 * The AI SDK's DefaultChatTransport handles the Vercel Data Stream Protocol
 * parsing — the gateway's SSE bridge already outputs this format.
 */
export function useChatSession({ tenantId }: UseChatSessionOptions) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const sessionIdRef = useRef<string | null>(null);

  // Keep ref in sync with state for use in body resolver
  sessionIdRef.current = sessionId;

  const apiBase = import.meta.env.VITE_API_BASE_URL as string;

  // Memoize the transport so it's stable across renders.
  // headers/body are Resolvable (functions) so they always read latest state.
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${apiBase}/chat/stream`,
        fetch: createAuthFetch(setSessionId) as typeof globalThis.fetch,
        body: () => ({
          tenantId,
          sessionId: sessionIdRef.current,
          platform: 'web',
        }),
      }),
    [apiBase, tenantId]
  );

  const {
    messages,
    sendMessage: aiSendMessage,
    status,
    stop,
    setMessages,
    error,
    regenerate,
  } = useAIChat({
    transport,
    onError: (err) => {
      console.error('[useChatSession] Stream error:', err);
    },
    onFinish: () => {
      // Could trigger session list refresh here
    },
  });

  const isStreaming = status === 'streaming' || status === 'submitted';

  /**
   * Send a text message. Wraps the AI SDK's sendMessage with a simpler API.
   */
  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim() || isStreaming) return;
      aiSendMessage({ text: content });
    },
    [aiSendMessage, isStreaming]
  );

  /**
   * Load an existing session's messages from DynamoDB.
   * Replaces the current message list and updates the active sessionId.
   */
  const loadSession = useCallback(
    async (targetSessionId: string) => {
      stop();
      setIsLoadingSession(true);

      try {
        const data = await apiGet<SessionMessagesResponse>(
          `/chat/sessions/${targetSessionId}/messages?limit=200`
        );

        const loaded: UIMessage[] = data.messages.map((m) => ({
          id: m.messageId,
          role: m.role as 'user' | 'assistant',
          parts: [{ type: 'text' as const, text: m.content }],
        }));

        setMessages(loaded);
        setSessionId(targetSessionId);
      } catch (err) {
        console.error('[useChatSession] Failed to load session:', err);
      } finally {
        setIsLoadingSession(false);
      }
    },
    [stop, setMessages]
  );

  /**
   * Clear all messages and start a fresh session.
   */
  const clearSession = useCallback(() => {
    stop();
    setMessages([]);
    setSessionId(null);
  }, [stop, setMessages]);

  return {
    /** Current message list (AI SDK UIMessage format with parts) */
    messages,
    /** Whether the agent is currently streaming a response */
    isStreaming,
    /** Whether historical session messages are being loaded */
    isLoadingSession,
    /** Current session ID (null for new conversations) */
    sessionId,
    /** Last error from the stream, if any */
    error,
    /** Send a text message to the agent */
    sendMessage,
    /** Stop the current stream */
    stop,
    /** Regenerate the last assistant response */
    regenerate,
    /** Load messages for an existing session */
    loadSession,
    /** Clear messages and start a new session */
    clearSession,
    /** Direct access to setMessages for advanced use cases */
    setMessages,
    /** Current chat status ('ready' | 'submitted' | 'streaming' | 'error') */
    status,
  };
}

// Re-export UIMessage for components that need the type
export type { UIMessage } from 'ai';
