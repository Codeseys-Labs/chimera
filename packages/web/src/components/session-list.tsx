import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { Loader2, MessageSquare, Plus } from 'lucide-react';

interface Session {
  id: string;
  title: string;
  status: 'active' | 'idle' | 'error';
  lastMessage?: string;
  updatedAt: string;
}

interface SessionListProps {
  sessions: Session[];
  activeSessionId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
}

const STATUS_VARIANT: Record<Session['status'], 'default' | 'secondary' | 'destructive'> = {
  active: 'default',
  idle: 'secondary',
  error: 'destructive',
};

const STATUS_LABEL: Record<Session['status'], string> = {
  active: 'Streaming',
  idle: 'Complete',
  error: 'Error',
};

/**
 * Format a timestamp into a human-readable relative string.
 * Shows "just now", "Xm ago", "Xh ago", or the date for older entries.
 */
function formatRelativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffMs = now - then;
  if (diffMs < 0 || Number.isNaN(diffMs)) return '';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * Sidebar list of agent sessions with status badges, streaming indicator,
 * message preview, and relative timestamp.
 */
export function SessionList({ sessions, activeSessionId, onSelect, onNew }: SessionListProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <button onClick={onNew} className="rounded-md p-1 hover:bg-accent" aria-label="New session">
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
            {sessions.map((session) => {
              const isActive = session.status === 'active';
              const isError = session.status === 'error';

              return (
                <button
                  key={session.id}
                  onClick={() => onSelect(session.id)}
                  className={cn(
                    'w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
                    session.id === activeSessionId && 'bg-accent'
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{session.title}</span>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isActive && (
                        <Loader2
                          className="h-3 w-3 animate-spin text-primary"
                          aria-label="Streaming"
                        />
                      )}
                      <Badge
                        variant={STATUS_VARIANT[session.status]}
                        className={cn('text-xs', isError && 'animate-pulse')}
                      >
                        {STATUS_LABEL[session.status]}
                      </Badge>
                    </div>
                  </div>

                  {/* Message preview */}
                  {session.lastMessage && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {session.lastMessage.slice(0, 80)}
                      {session.lastMessage.length > 80 ? '...' : ''}
                    </p>
                  )}

                  {/* Relative timestamp */}
                  {session.updatedAt && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground/60">
                      {formatRelativeTime(session.updatedAt)}
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
