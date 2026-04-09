import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { CostChart } from '@/components/cost-chart';
import { useAuth } from '@/hooks/use-auth';
import { useSessions } from '@/hooks/use-sessions';
import { useTenant } from '@/hooks/use-tenant';

export function DashboardPage() {
  const { tenantId } = useAuth();
  const { data: tenant, isLoading: tenantLoading } = useTenant(tenantId);
  const { data: sessions, isLoading: sessionsLoading } = useSessions(tenantId, 10);

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Overview cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <OverviewCard
          title="Active Sessions"
          value={tenant?.activeSessions}
          loading={tenantLoading}
        />
        <OverviewCard
          title="Installed Skills"
          value={tenant?.installedSkills}
          loading={tenantLoading}
        />
        <OverviewCard
          title="Monthly Cost"
          value={tenant ? `$${tenant.monthlyCostUsd.toFixed(2)}` : undefined}
          loading={tenantLoading}
        />
      </div>

      {/* Cost chart */}
      <Card>
        <CardHeader>
          <CardTitle>Monthly Costs</CardTitle>
          <CardDescription>Cost breakdown by AI model</CardDescription>
        </CardHeader>
        <CardContent>
          <CostChart data={[]} />
        </CardContent>
      </Card>

      {/* Recent sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sessions</CardTitle>
          <CardDescription>Last 10 agent sessions</CardDescription>
        </CardHeader>
        <CardContent>
          {sessionsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Session</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Activity</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions?.sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.title}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          s.status === 'active'
                            ? 'default'
                            : s.status === 'error'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {s.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(s.updatedAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
                {!sessions?.sessions.length && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      No sessions yet
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function OverviewCard({
  title,
  value,
  loading,
}: {
  title: string;
  value: string | number | undefined;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>{title}</CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-8 w-24" />
        ) : (
          <p className="text-3xl font-bold">{value ?? '\u2014'}</p>
        )}
      </CardContent>
    </Card>
  );
}
