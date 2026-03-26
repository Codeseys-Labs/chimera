import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { MessageSquare, Plus } from 'lucide-react'

interface Session {
  id: string
  title: string
  status: 'active' | 'idle' | 'error'
  lastMessage?: string
  updatedAt: string
}

interface SessionListProps {
  sessions: Session[]
  activeSessionId?: string
  onSelect: (id: string) => void
  onNew: () => void
}

const STATUS_VARIANT: Record<Session['status'], 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  idle: 'secondary',
  error: 'destructive',
}

/**
 * Sidebar list of agent sessions with status badges and last-message preview.
 */
export function SessionList({ sessions, activeSessionId, onSelect, onNew }: SessionListProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <button
          onClick={onNew}
          className="rounded-md p-1 hover:bg-accent"
          aria-label="New session"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <ScrollArea className="flex-1">
        {sessions.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted-foreground">
            <MessageSquare className="h-8 w-8 opacity-40" />
            <p>No sessions yet</p>
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => onSelect(session.id)}
                className={cn(
                  'w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                  session.id === activeSessionId && 'bg-accent',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{session.title}</span>
                  <Badge variant={STATUS_VARIANT[session.status]} className="shrink-0 text-xs">
                    {session.status}
                  </Badge>
                </div>
                {session.lastMessage && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {session.lastMessage}
                  </p>
                )}
              </button>
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
