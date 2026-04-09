import { LayoutDashboard, MessageSquare, Settings, Shield, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { useAuth } from '@/hooks/use-auth';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/admin', label: 'Admin', icon: Shield },
  { href: '/settings', label: 'Settings', icon: Settings },
];

interface AppLayoutProps {
  children: React.ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const current = window.location.pathname.replace(/\/$/, '') || '/dashboard';
  const { handleSignOut } = useAuth();

  return (
    <div className="flex h-screen">
      {/* Sidebar nav */}
      <nav className="flex w-56 shrink-0 flex-col border-r bg-card">
        <div className="px-4 py-5">
          <h1 className="text-lg font-bold">Chimera</h1>
          <p className="text-xs text-muted-foreground">Agent Platform</p>
        </div>

        <Separator />

        <div className="flex-1 space-y-1 px-2 py-3">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <a
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent',
                current === href && 'bg-accent font-medium'
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </a>
          ))}
        </div>

        <div className="px-2 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-3"
            onClick={handleSignOut}
          >
            <LogOut className="h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </nav>

      {/* Page content */}
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
