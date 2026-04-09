import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatMessage } from '@/components/chat-message';
import { SessionList } from '@/components/session-list';
import { useChatSession, getMessageText } from '@/hooks/use-chat';
import { useAuth } from '@/hooks/use-auth';
import { useSessions } from '@/hooks/use-sessions';
import { Send, Square, Loader2 } from 'lucide-react';

export function ChatPage() {
  const { tenantId } = useAuth();
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: sessionsData } = useSessions(tenantId, 20);
  const {
    messages,
    isStreaming,
    isLoadingSession,
    error,
    sendMessage,
    stop,
    loadSession,
    clearSession,
    sessionId,
  } = useChatSession({ tenantId });

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isStreaming) return;
    sendMessage(input);
    setInput('');
  }

  function handleSelectSession(id: string) {
    if (id === sessionId) return;
    void loadSession(id);
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="w-64 shrink-0 border-r">
        <SessionList
          sessions={sessionsData?.sessions ?? []}
          activeSessionId={sessionId ?? undefined}
          onSelect={handleSelectSession}
          onNew={clearSession}
        />
      </aside>

      {/* Main chat area */}
      <div className="flex flex-1 flex-col">
        {/* Messages */}
        <ScrollArea className="flex-1 px-4">
          <div className="mx-auto max-w-3xl py-4">
            {isLoadingSession && (
              <div className="flex h-64 flex-col items-center justify-center text-center text-muted-foreground">
                <Loader2 className="h-6 w-6 animate-spin" />
                <p className="mt-2 text-sm">Loading conversation...</p>
              </div>
            )}

            {!isLoadingSession && messages.length === 0 && (
              <div className="flex h-64 flex-col items-center justify-center text-center text-muted-foreground">
                <p className="text-lg font-medium">Welcome to Chimera</p>
                <p className="text-sm">Start a conversation with your AI assistant.</p>
              </div>
            )}

            {!isLoadingSession &&
              messages.map((msg, i) => {
                const isLast = i === messages.length - 1;
                const msgStreaming = isLast && isStreaming && msg.role === 'assistant';
                const textContent = getMessageText(msg);

                return (
                  <ChatMessage
                    key={msg.id}
                    role={msg.role as 'user' | 'assistant'}
                    content={textContent}
                    isStreaming={msgStreaming}
                  />
                );
              })}

            {error && (
              <div className="mx-auto max-w-3xl rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">
                {error.message}
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
              placeholder="Type a message..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isStreaming || isLoadingSession}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
            {isStreaming ? (
              <Button type="button" variant="outline" size="icon" onClick={stop} aria-label="Stop">
                <Square className="h-4 w-4" />
              </Button>
            ) : (
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || isLoadingSession}
                aria-label="Send"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </form>
        </div>
      </div>
    </div>
  );
}
