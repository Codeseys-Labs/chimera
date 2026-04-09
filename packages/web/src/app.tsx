import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/components/theme-provider';
import { AuthProvider } from '@/hooks/use-auth';
import { ProtectedRoute } from '@/components/protected-route';
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
 * Simple pathname-based routing to avoid CloudFront-SPA conflicts during early dev.
 * TanStack Router integration can replace this once auth is stable.
 */
function Router() {
  const path = window.location.pathname.replace(/\/$/, '') || '/';

  if (path === '/login') {
    return <LoginPage />;
  }

  return (
    <ProtectedRoute>
      <AppLayout>
        {path === '/dashboard' || path === '/' ? <DashboardPage /> : null}
        {path === '/chat' ? <ChatPage /> : null}
        {path === '/admin' ? <AdminPage /> : null}
        {path === '/settings' ? <SettingsPage /> : null}
        {!['/dashboard', '/', '/chat', '/admin', '/settings'].includes(path) ? (
          <div className="flex h-64 items-center justify-center text-muted-foreground">
            404 — Page not found
          </div>
        ) : null}
      </AppLayout>
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark">
        <AuthProvider>
          <Router />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
