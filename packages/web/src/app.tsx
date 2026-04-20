import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from '@/hooks/use-auth';
import { ProtectedRoute } from '@/components/protected-route';
import { ErrorBoundary } from '@/components/error-boundary';
import { LoginPage } from '@/pages/login';
import { DashboardPage } from '@/pages/dashboard';
import { ChatPage } from '@/pages/chat';
import { AdminPage } from '@/pages/admin';
import { SettingsPage } from '@/pages/settings';
import { AppLayout } from '@/components/app-layout';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Subscribe to browser navigation events so the pathname-based router re-renders
 * on back/forward and programmatic pushState calls. Lets focus management and
 * route rendering stay in sync without pulling in a full router library yet.
 */
function useCurrentPath(): string {
  const [path, setPath] = useState(
    () => window.location.pathname.replace(/\/$/, '') || '/'
  );

  useEffect(() => {
    const handler = (): void => {
      setPath(window.location.pathname.replace(/\/$/, '') || '/');
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  return path;
}

/**
 * Simple pathname-based routing to avoid CloudFront-SPA conflicts during early dev.
 * TanStack Router integration can replace this once auth is stable.
 */
function Router() {
  const path = useCurrentPath();
  const mainRef = useRef<HTMLDivElement>(null);

  // Move focus to the main content region on route change so keyboard users
  // land on the new page's content instead of the previous control. Honors
  // the accessibility guidance in the hardening spec (fresh-gaps.md #8).
  useEffect(() => {
    mainRef.current?.focus();
  }, [path]);

  if (path === '/login') {
    return <LoginPage />;
  }

  const knownRoutes = ['/dashboard', '/', '/chat', '/admin', '/settings'];

  return (
    <ProtectedRoute>
      <AppLayout>
        <div
          ref={mainRef}
          tabIndex={-1}
          // `outline-none` — focus is programmatic on route change, not a user
          // keyboard action, so suppressing the ring keeps the UI quiet.
          className="outline-none"
        >
          {path === '/dashboard' || path === '/' ? <DashboardPage /> : null}
          {path === '/chat' ? <ChatPage /> : null}
          {path === '/admin' ? <AdminPage /> : null}
          {path === '/settings' ? <SettingsPage /> : null}
          {!knownRoutes.includes(path) ? (
            <div className="flex h-64 items-center justify-center text-muted-foreground">
              404 — Page not found
            </div>
          ) : null}
        </div>
      </AppLayout>
    </ProtectedRoute>
  );
}

export function App() {
  // ErrorBoundary wraps everything — including the router — so a crash in any
  // page renders the recoverable fallback instead of an empty DOM.
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider defaultTheme="dark">
          <AuthProvider>
            <Router />
          </AuthProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
