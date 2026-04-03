import { useCallback, useRef, useState } from 'react';
import { streamChatResponse } from '@/lib/sse-client';
import { apiGet } from '@/lib/api-client';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  status?: 'complete' | 'streaming' | 'error';
  errorMessage?: string;
}

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

interface UseChatOptions {
  tenantId: string;
  initialSessionId?: string;
}

/**
 * Manages chat message state and SSE streaming.
 */
export function useChat({ tenantId, initialSessionId }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim() || isStreaming) return;

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
        status: 'complete',
      };

      // Placeholder for assistant response
      const assistantId = crypto.randomUUID();
      const assistantMessage: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
        status: 'streaming',
      };

      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);
      setError(null);

      const history = messages
        .concat(userMessage)
        .map(({ role, content: c }) => ({ role, content: c }));

      abortRef.current = streamChatResponse(history, tenantId, sessionId, {
        onToken: (token) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, content: m.content + token } : m))
          );
        },
        onComplete: () => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, status: 'complete' } : m))
          );
          setIsStreaming(false);
          abortRef.current = null;
        },
        onError: (err) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, status: 'error', errorMessage: err.message } : m
            )
          );
          setIsStreaming(false);
          setError(err.message);
          abortRef.current = null;
        },
        onSessionId: (id) => setSessionId(id),
      });
    },
    [isStreaming, messages, tenantId, sessionId]
  );

  /**
   * Load an existing session's messages from DynamoDB and optionally
   * reconnect to a still-streaming response.
   */
  const loadSession = useCallback(
    async (targetSessionId: string) => {
      // Abort any in-flight stream before switching sessions
      abortRef.current?.abort();
      setIsStreaming(false);
      setError(null);
      setIsLoadingSession(true);

      try {
        const data = await apiGet<SessionMessagesResponse>(
          `/chat/sessions/${targetSessionId}/messages?limit=200`
        );

        const loaded: Message[] = data.messages.map((m) => ({
          id: m.messageId,
          role: m.role,
          content: m.content,
          timestamp: m.createdAt,
          status: m.status,
          errorMessage: m.errorMessage,
        }));

        setMessages(loaded);
        setSessionId(targetSessionId);

        // If the last assistant message was still streaming, attempt to reconnect
        const lastMsg = loaded[loaded.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.status === 'streaming') {
          setIsStreaming(true);
          abortRef.current = streamChatResponse(
            [], // empty history — the reconnect endpoint replays from buffer
            tenantId,
            targetSessionId,
            {
              onToken: (token) => {
                setMessages((prev) =>
                  prev.map((m) => (m.id === lastMsg.id ? { ...m, content: m.content + token } : m))
                );
              },
              onComplete: () => {
                setMessages((prev) =>
                  prev.map((m) => (m.id === lastMsg.id ? { ...m, status: 'complete' } : m))
                );
                setIsStreaming(false);
                abortRef.current = null;
              },
              onError: (err) => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === lastMsg.id ? { ...m, status: 'error', errorMessage: err.message } : m
                  )
                );
                setIsStreaming(false);
                setError(err.message);
                abortRef.current = null;
              },
              onSessionId: () => {
                /* session ID already set */
              },
            },
            lastMsg.id // messageId for GET /chat/stream/:messageId reconnect
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        setIsLoadingSession(false);
      }
    },
    [tenantId]
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
    setIsStreaming(false);
  }, []);

  const clearMessages = useCallback(() => {
    abort();
    setMessages([]);
    setSessionId(null);
    setError(null);
  }, [abort]);

  return {
    messages,
    isStreaming,
    isLoadingSession,
    sessionId,
    error,
    sendMessage,
    loadSession,
    abort,
    clearMessages,
  };
}
