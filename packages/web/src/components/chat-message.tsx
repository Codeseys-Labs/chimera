import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import { cn } from '@/lib/utils'

interface ChatMessageProps {
  role: 'user' | 'assistant'
  content: string
  timestamp?: string
  isStreaming?: boolean
}

/**
 * Renders a single chat message with role indicator, timestamp,
 * markdown body, and animated streaming cursor when isStreaming=true.
 */
export function ChatMessage({ role, content, timestamp, isStreaming = false }: ChatMessageProps) {
  const isUser = role === 'user'

  return (
    <div className={cn('flex gap-3 py-2', isUser ? 'flex-row-reverse' : 'flex-row')}>
      {/* Role avatar */}
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-bold',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
        aria-label={isUser ? 'You' : 'Agent'}
      >
        {isUser ? 'U' : 'A'}
      </div>

      {/* Message bubble */}
      <div
        className={cn(
          'max-w-[75%] rounded-lg px-4 py-2',
          isUser
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-foreground',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm">{content}</p>
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown rehypePlugins={[rehypeHighlight]}>
              {content || '\u200b'}
            </ReactMarkdown>
          </div>
        )}

        {/* Streaming cursor */}
        {isStreaming && (
          <span className="inline-block h-4 w-0.5 animate-blink bg-current ml-0.5" aria-hidden />
        )}

        {/* Timestamp */}
        {timestamp && (
          <p
            className={cn(
              'mt-1 text-xs',
              isUser ? 'text-primary-foreground/70' : 'text-muted-foreground',
            )}
          >
            {new Date(timestamp).toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  )
}
