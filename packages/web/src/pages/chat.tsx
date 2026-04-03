import { fetchAuthSession } from 'aws-amplify/auth';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatMessage } from '@/components/chat-message';
import { SessionList } from '@/components/session-list';
import { useChat } from '@/hooks/use-chat';
import { useSessions } from '@/hooks/use-sessions';
import { Send, Square, Loader2 } from 'lucide-react';

export function ChatPage() {
  const [tenantId, setTenantId] = useState('');
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchAuthSession()
      .then((session) => {
        const claims = session.tokens?.idToken?.payload;
        const tid = (claims?.['custom:tenant_id'] as string) || 'default-tenant';
        setTenantId(tid);
      })
      .catch(console.error);
  }, []);

  const { data: sessionsData } = useSessions(tenantId, 20);
  const {
    messages,
    isStreaming,
    isLoadingSession,
    error,
    sendMessage,
    loadSession,
    abort,
    clearMessages,
    sessionId,
  } = useChat({ tenantId });

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
    if (id === sessionId) return; // already active
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
          onNew={clearMessages}
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
                const hasError = msg.status === 'error';

                return (
                  <div key={msg.id}>
                    <ChatMessage
                      role={msg.role}
                      content={msg.content}
                      timestamp={msg.timestamp}
                      isStreaming={msgStreaming}
                    />
                    {hasError && msg.errorMessage && (
                      <div className="ml-11 mb-2 rounded-md bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
                        Error: {msg.errorMessage}
                      </div>
                    )}
                  </div>
                );
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
              disabled={isStreaming || isLoadingSession}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e);
                }
              }}
            />
            {isStreaming ? (
              <Button type="button" variant="outline" size="icon" onClick={abort} aria-label="Stop">
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
