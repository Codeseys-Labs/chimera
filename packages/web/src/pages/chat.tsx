import { getCurrentUser } from 'aws-amplify/auth'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChatMessage } from '@/components/chat-message'
import { SessionList } from '@/components/session-list'
import { useChat } from '@/hooks/use-chat'
import { useSessions } from '@/hooks/use-sessions'
import { Send, Square } from 'lucide-react'

export function ChatPage() {
  const [tenantId, setTenantId] = useState('')
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getCurrentUser()
      .then((u) => setTenantId(u.userId))
      .catch(console.error)
  }, [])

  const { data: sessionsData } = useSessions(tenantId, 20)
  const { messages, isStreaming, error, sendMessage, abort, clearMessages, sessionId } = useChat({
    tenantId,
  })

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || isStreaming) return
    sendMessage(input)
    setInput('')
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r">
        <SessionList
          sessions={sessionsData?.sessions ?? []}
          activeSessionId={sessionId ?? undefined}
          onSelect={() => {
            /* TODO: load existing session */
          }}
          onNew={clearMessages}
        />
      </aside>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col">
        {/* Messages */}
        <ScrollArea className="flex-1 px-4">
          <div className="mx-auto max-w-3xl py-4">
            {messages.length === 0 && (
              <div className="flex h-64 flex-col items-center justify-center text-center text-muted-foreground">
                <p className="text-lg font-medium">Welcome to Chimera</p>
                <p className="text-sm">Start a conversation with your AI assistant.</p>
              </div>
            )}

            {messages.map((msg, i) => {
              const isLast = i === messages.length - 1
              return (
                <ChatMessage
                  key={msg.id}
                  role={msg.role}
                  content={msg.content}
                  timestamp={msg.timestamp}
                  isStreaming={isLast && isStreaming && msg.role === 'assistant'}
                />
              )
            })}

            {error && (
              <div className="mx-auto max-w-3xl rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        </ScrollArea>

        {/* Input area */}
        <div className="border-t bg-background px-4 py-3">
          <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              rows={3}
              placeholder="Type a message…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isStreaming}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSubmit(e)
                }
              }}
            />
            {isStreaming ? (
              <Button type="button" variant="outline" size="icon" onClick={abort} aria-label="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!input.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            )}
          </form>
        </div>
      </div>
    </div>
  )
}
