import { KeyRound, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/use-auth';
import { useTenant } from '@/hooks/use-tenant';
import { apiGet } from '@/lib/api-client';
import { useQuery } from '@tanstack/react-query';

interface User {
  sub: string;
  email: string;
  name: string;
  status: 'CONFIRMED' | 'UNCONFIRMED' | 'DISABLED';
  groups: string[];
}

interface ApiKey {
  id: string;
  maskedKey: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function AdminPage() {
  const { tenantId } = useAuth();
  const { data: tenant, isLoading: tenantLoading } = useTenant(tenantId);

  const { data: usersData, isLoading: usersLoading } = useQuery({
    queryKey: ['users', tenantId],
    queryFn: () => apiGet<{ users: User[] }>(`/tenants/${tenantId}/users`),
    enabled: !!tenantId,
  });

  const { data: keysData, isLoading: keysLoading } = useQuery({
    queryKey: ['api-keys', tenantId],
    queryFn: () => apiGet<{ keys: ApiKey[] }>(`/tenants/${tenantId}/api-keys`),
    enabled: !!tenantId,
  });

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Admin</h1>

      <Tabs defaultValue="config">
        <TabsList>
          <TabsTrigger value="config">Tenant Config</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="apikeys">API Keys</TabsTrigger>
        </TabsList>

        {/* Tenant config */}
        <TabsContent value="config">
          <Card>
            <CardHeader>
              <CardTitle>Tenant Configuration</CardTitle>
              <CardDescription>Tier and feature flags</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {tenantLoading ? (
                <Skeleton className="h-20 w-full" />
              ) : (
                <>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-medium">Tier:</span>
                    <Badge>{tenant?.tier ?? '\u2014'}</Badge>
                  </div>
                  <div>
                    <p className="mb-2 text-sm font-medium">Features:</p>
                    {Object.keys(tenant?.features ?? {}).length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No feature flags configured for this tenant.
                      </p>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(tenant?.features ?? {}).map(([key, enabled]) => (
                          <Badge key={key} variant={enabled ? 'default' : 'secondary'}>
                            {key}: {enabled ? 'on' : 'off'}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* User management */}
        <TabsContent value="users">
          <Card>
            <CardHeader>
              <CardTitle>User Management</CardTitle>
            </CardHeader>
            <CardContent>
              {usersLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : !usersData?.users.length ? (
                <EmptyState
                  icon={<Users className="h-8 w-8" />}
                  title="No users yet"
                  description="Invite teammates from the Cognito user pool to see them here."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Groups</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usersData.users.map((u) => (
                      <TableRow key={u.sub}>
                        <TableCell>{u.name}</TableCell>
                        <TableCell>{u.email}</TableCell>
                        <TableCell>
                          <Badge variant={u.status === 'DISABLED' ? 'destructive' : 'default'}>
                            {u.status}
                          </Badge>
                        </TableCell>
                        <TableCell>{u.groups.join(', ')}</TableCell>
                        <TableCell>
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="ghost" size="sm">
                                Manage
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Manage User: {u.email}</DialogTitle>
                              </DialogHeader>
                              <p className="text-sm text-muted-foreground">
                                User management actions coming soon.
                              </p>
                            </DialogContent>
                          </Dialog>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* API Keys */}
        <TabsContent value="apikeys">
          <Card>
            <CardHeader>
              <CardTitle>API Keys</CardTitle>
            </CardHeader>
            <CardContent>
              {keysLoading ? (
                <Skeleton className="h-40 w-full" />
              ) : !keysData?.keys.length ? (
                <EmptyState
                  icon={<KeyRound className="h-8 w-8" />}
                  title="No API keys"
                  description="Generate an API key to issue OpenAI-compatible requests against this tenant."
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Key</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead>Last Used</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {keysData.keys.map((k) => (
                      <TableRow key={k.id}>
                        <TableCell>{k.name}</TableCell>
                        <TableCell className="font-mono text-xs">{k.maskedKey}</TableCell>
                        <TableCell>{new Date(k.createdAt).toLocaleDateString()}</TableCell>
                        <TableCell>
                          {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : 'Never'}
                        </TableCell>
                        <TableCell>
                          <Button variant="destructive" size="sm">
                            Revoke
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
