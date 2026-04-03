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
          const data = line.slice(6).trim();

          // Stream terminator
          if (data === '[DONE]') {
            reading = false;
            break;
          }

          // The server emits Vercel DSP parts as full JSON objects:
          //   data: {"type":"text-delta","id":"...","delta":"hello"}
          try {
            const part = JSON.parse(data) as {
              type: string;
              [key: string]: unknown;
            };

            switch (part.type) {
              case 'text-delta': {
                const delta = part.delta as string;
                accumulated += delta;
                callbacks.onToken(delta);
                break;
              }
              case 'start': {
                // Message start — may carry a sessionId from the server
                if (part.sessionId) {
                  callbacks.onSessionId?.(part.sessionId as string);
                }
                break;
              }
              case 'finish': {
                // Finish part — stream may still have trailing events,
                // but we treat this as the logical end.
                break;
              }
              case 'error': {
                const msg = (part as { message?: string }).message ?? 'Stream error';
                throw new Error(msg);
              }
              // Events the UI doesn't need to act on but should not warn about
              case 'text-start':
              case 'text-end':
              case 'tool-input-start':
              case 'tool-input-delta':
              case 'tool-result':
              case 'step-start':
              case 'reasoning-start':
              case 'reasoning-delta':
              case 'reasoning-end':
              case 'source':
              case 'abort':
                break;
              default:
                // Unknown event type — ignore gracefully
                break;
            }
          } catch (parseErr) {
            if (parseErr instanceof SyntaxError) {
              // Malformed JSON — skip
              console.warn('Failed to parse SSE event:', data);
            } else {
              // Re-throw application errors (e.g. from the 'error' case above)
              throw parseErr;
            }
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
