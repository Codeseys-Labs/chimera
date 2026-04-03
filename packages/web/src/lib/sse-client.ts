import { fetchAuthSession } from 'aws-amplify/auth';

export interface SSECallbacks {
  onToken: (token: string) => void;
  onComplete: (fullContent: string) => void;
  onError: (error: Error) => void;
  onSessionId?: (sessionId: string) => void;
}

/**
 * Streams a chat response via SSE using fetch ReadableStream.
 * Returns an AbortController so the caller can cancel the stream.
 *
 * When `reconnectMessageId` is provided the client issues a GET to
 * `/chat/stream/:messageId` (the reconnection endpoint) instead of POSTing
 * a new request. This replays buffered DSP parts and follows the live tail.
 */
export function streamChatResponse(
  messages: Array<{ role: string; content: string }>,
  tenantId: string,
  sessionId: string | null,
  callbacks: SSECallbacks,
  reconnectMessageId?: string
): AbortController {
  const controller = new AbortController();

  void (async () => {
    try {
      const session = await fetchAuthSession();
      const token = session.tokens?.idToken?.toString();
      if (!token) throw new Error('Not authenticated');

      const base = import.meta.env.VITE_API_BASE_URL as string;

      let res: Response;
      if (reconnectMessageId) {
        // Reconnect to an in-progress stream via GET
        res = await fetch(`${base}/chat/stream/${reconnectMessageId}`, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: controller.signal,
        });
      } else {
        // Normal POST to start a new stream
        res = await fetch(`${base}/chat/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ messages, tenantId, sessionId, platform: 'web' }),
          signal: controller.signal,
        });
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      if (!res.body) {
        throw new Error('No response body');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      let reading = true;
      while (reading) {
        const { done, value } = await reader.read();
        if (done) {
          reading = false;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);

          const colonIndex = data.indexOf(':');
          if (colonIndex === -1) continue;

          const eventType = data.substring(0, colonIndex);
          const payload = data.substring(colonIndex + 1);

          try {
            const parsed = payload ? JSON.parse(payload) : null;

            if (eventType === 'text' && typeof parsed === 'string') {
              accumulated += parsed;
              callbacks.onToken(parsed);
            } else if (eventType === 'message_start' && parsed?.sessionId) {
              callbacks.onSessionId?.(parsed.sessionId as string);
            } else if (eventType === 'error') {
              throw new Error((parsed as { message?: string })?.message ?? 'Stream error');
            }
          } catch (parseErr) {
            // Skip malformed events
            console.warn('Failed to parse SSE event:', parseErr);
          }
        }
      }

      callbacks.onComplete(accumulated);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return controller;
}
