import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback UI to render when an error is caught. */
  fallback?: ReactNode;
  /** Optional callback invoked when componentDidCatch fires. */
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level error boundary for the Chimera web UI.
 *
 * React requires class components for error boundaries — hooks cannot currently
 * implement `getDerivedStateFromError` / `componentDidCatch`. This class wraps
 * the entire app (see `app.tsx`) so a runtime error in any descendant component
 * renders a recoverable fallback instead of crashing the whole tree.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Structured log payload so CloudWatch/Sentry-style collectors can index it.
    // Kept to console.error for v1; replace with a telemetry hook when available.
    console.error('[ErrorBoundary] React render error', {
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
    this.props.onError?.(error, info);
  }

  handleReset = (): void => {
    // Simplest viable recovery: reload. Avoids half-recovered state where
    // caches, queries, or auth tokens are in an inconsistent shape.
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex min-h-screen items-center justify-center bg-background p-6"
      >
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Something went wrong</CardTitle>
            <CardDescription>
              An unexpected error occurred. Try refreshing the page — if the problem persists,
              contact your administrator.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {this.state.error?.message ? (
              <pre className="max-h-32 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
                {this.state.error.message}
              </pre>
            ) : null}
            <Button onClick={this.handleReset} className="w-full">
              Reload page
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }
}
