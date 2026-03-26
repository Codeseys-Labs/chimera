import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/lib/api-client'

export interface TenantProfile {
  tenantId: string
  name: string
  tier: 'basic' | 'advanced' | 'enterprise' | 'dedicated'
  status: string
  features: Record<string, boolean>
  monthlyCostUsd: number
  activeSessions: number
  installedSkills: number
}

export function useTenant(tenantId: string) {
  return useQuery({
    queryKey: ['tenant', tenantId],
    queryFn: () => apiGet<TenantProfile>(`/tenants/${tenantId}`),
    enabled: !!tenantId,
    staleTime: 30_000,
  })
}
