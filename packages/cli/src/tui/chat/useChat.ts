import { useReducer, useCallback, useRef } from 'react';
import { apiClient, ChimeraAuthError } from '../../lib/api-client.js';
import type { ChatMessage, ChatState, ToolUse } from './types.js';

// ─── SSE parsing (mirrors chat.ts pattern) ───────────────────────────────────

interface ChatChunk {
  type: 'token' | 'done' | 'error' | 'tool_use';
  content?: string;
  error?: string;
  toolName?: string;
  toolInput?: string;
  toolStatus?: 'pending' | 'running' | 'complete';
  toolResult?: string;
  sessionId?: string;
}

async function* streamChatResponse(response: Response): AsyncGenerator<ChatChunk> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = '';
  try {
    let chunk = await reader.read();
    while (!chunk.done) {
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            yield { type: 'done' };
            return;
          }
          try {
            yield JSON.parse(data) as ChatChunk;
          } catch {
            // Ignore malformed SSE frames
          }
        }
      }
      chunk = await reader.read();
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── State machine ────────────────────────────────────────────────────────────

type Action =
  | { type: 'SEND'; message: ChatMessage }
  | { type: 'TOKEN'; content: string }
  | { type: 'DONE'; sessionId?: string }
  | { type: 'ERROR'; error: string }
  | { type: 'CLEAR_ERROR' };

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'SEND':
      return {
        ...state,
        messages: [...state.messages, action.message],
        isLoading: true,
        error: null,
        streamingContent: '',
      };
    case 'TOKEN':
      return { ...state, streamingContent: state.streamingContent + action.content };
    case 'DONE': {
      if (!state.streamingContent) {
        return { ...state, isLoading: false, sessionId: action.sessionId ?? state.sessionId };
      }
      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}-assistant`,
        role: 'assistant',
        content: state.streamingContent,
        timestamp: new Date(),
      };
      return {
        ...state,
        messages: [...state.messages, assistantMessage],
        streamingContent: '',
        isLoading: false,
        sessionId: action.sessionId ?? state.sessionId,
      };
    }
    case 'ERROR':
      return { ...state, isLoading: false, streamingContent: '', error: action.error };
    case 'CLEAR_ERROR':
      return { ...state, error: null };
    default:
      return state;
  }
}

const initialState: ChatState = {
  messages: [],
  streamingContent: '',
  isLoading: false,
  error: null,
  sessionId: null,
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useChat(initialSessionId?: string) {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    sessionId: initialSessionId ?? null,
  });

  // Prevent overlapping requests
  const abortRef = useRef<AbortController | null>(null);

  const sendMessage = useCallback(
    async (text: string) => {
      if (!text.trim() || state.isLoading) return;

      // Cancel any prior in-flight request
      abortRef.current?.abort();
      abortRef.current = new AbortController();

      const userMessage: ChatMessage = {
        id: `msg-${Date.now()}-user`,
        role: 'user',
        content: text.trim(),
        timestamp: new Date(),
      };
      dispatch({ type: 'SEND', message: userMessage });

      try {
        const body: { messages: Array<{ role: string; content: string }>; sessionId?: string } = {
          messages: [{ role: 'user', content: text.trim() }],
        };
        if (state.sessionId) body.sessionId = state.sessionId;

        const response = await apiClient.postStream('/chat/stream', body);

        for await (const chunk of streamChatResponse(response)) {
          if (chunk.type === 'token' && chunk.content) {
            dispatch({ type: 'TOKEN', content: chunk.content });
          } else if (chunk.type === 'done') {
            dispatch({ type: 'DONE', sessionId: chunk.sessionId });
            break;
          } else if (chunk.type === 'error') {
            dispatch({ type: 'ERROR', error: chunk.error ?? 'Unknown error' });
            break;
          }
        }
      } catch (err) {
        if (err instanceof ChimeraAuthError) {
          dispatch({ type: 'ERROR', error: err.message });
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          dispatch({ type: 'ERROR', error: msg });
        }
      }
    },
    [state.isLoading, state.sessionId],
  );

  const clearError = useCallback(() => dispatch({ type: 'CLEAR_ERROR' }), []);

  return { state, sendMessage, clearError };
}

export type { ToolUse };
