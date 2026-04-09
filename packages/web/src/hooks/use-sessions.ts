import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api-client';

export interface AgentSession {
  id: string;
  title: string;
  status: 'active' | 'idle' | 'error';
  messageCount?: number;
  lastMessage?: string;
  createdAt: string;
  updatedAt: string;
}

interface SessionsPage {
  sessions: AgentSession[];
  count: number;
  nextCursor?: string;
}

export function useSessions(tenantId: string, limit = 20) {
  return useQuery({
    queryKey: ['sessions', tenantId, limit],
    queryFn: () => apiGet<SessionsPage>(`/chat/sessions?limit=${limit}`),
    enabled: !!tenantId,
    staleTime: 15_000,
  });
}

export function useSessionsInfinite(tenantId: string, pageSize = 20) {
  return useInfiniteQuery({
    queryKey: ['sessions-infinite', tenantId],
    queryFn: ({ pageParam }) =>
      apiGet<SessionsPage>(
        `/chat/sessions?limit=${pageSize}${pageParam ? `&cursor=${pageParam}` : ''}`
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: SessionsPage) => lastPage.nextCursor,
    enabled: !!tenantId,
  });
}
