import { useCallback, useRef, useState } from 'react'
import { streamChatResponse } from '@/lib/sse-client'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: string
}

interface UseChatOptions {
  tenantId: string
  initialSessionId?: string
}

/**
 * Manages chat message state and SSE streaming.
 */
export function useChat({ tenantId, initialSessionId }: UseChatOptions) {
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId ?? null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim() || isStreaming) return

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      }

      // Placeholder for assistant response
      const assistantId = crypto.randomUUID()
      const assistantMessage: Message = {
        id: assistantId,
        role: 'assistant',
        content: '',
        timestamp: new Date().toISOString(),
      }

      setMessages((prev) => [...prev, userMessage, assistantMessage])
      setIsStreaming(true)
      setError(null)

      const history = messages.concat(userMessage).map(({ role, content: c }) => ({ role, content: c }))

      abortRef.current = streamChatResponse(history, tenantId, sessionId, {
        onToken: (token) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: m.content + token } : m,
            ),
          )
        },
        onComplete: () => {
          setIsStreaming(false)
          abortRef.current = null
        },
        onError: (err) => {
          setIsStreaming(false)
          setError(err.message)
          abortRef.current = null
        },
        onSessionId: (id) => setSessionId(id),
      })
    },
    [isStreaming, messages, tenantId, sessionId],
  )

  const abort = useCallback(() => {
    abortRef.current?.abort()
    setIsStreaming(false)
  }, [])

  const clearMessages = useCallback(() => {
    abort()
    setMessages([])
    setSessionId(null)
    setError(null)
  }, [abort])

  return { messages, isStreaming, sessionId, error, sendMessage, abort, clearMessages }
}
