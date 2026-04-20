import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** Optional leading icon (e.g. a Lucide icon element). */
  icon?: ReactNode;
  /** Primary heading — short, human-readable. */
  title: string;
  /** Optional supporting copy explaining the empty state. */
  description?: string;
  /** Optional call-to-action (button, link, etc.). */
  action?: ReactNode;
  /** Additional Tailwind classes for the outer container. */
  className?: string;
}

/**
 * Shared empty-state presentation used across the Chimera web UI.
 *
 * Mirrors the muted-foreground pattern established by the dashboard's
 * "No sessions yet" row (see `pages/dashboard.tsx`) so empty states read
 * consistently regardless of which page the user lands on.
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-md p-8 text-center',
        className
      )}
    >
      {icon ? <div className="mb-2 text-muted-foreground">{icon}</div> : null}
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
