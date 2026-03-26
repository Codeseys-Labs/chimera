import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiGet, apiPost } from '@/lib/api-client'

export interface Skill {
  id: string
  name: string
  description: string
  version: string
  installed: boolean
}

export function useSkills(tenantId: string) {
  return useQuery({
    queryKey: ['skills', tenantId],
    queryFn: () => apiGet<{ skills: Skill[] }>(`/skills?tenantId=${tenantId}`),
    enabled: !!tenantId,
    staleTime: 60_000,
  })
}

export function useInstallSkill(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (skillId: string) => apiPost(`/skills/${skillId}/install`, { tenantId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', tenantId] }),
  })
}

export function useUninstallSkill(tenantId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (skillId: string) => apiDelete(`/skills/${skillId}/install?tenantId=${tenantId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills', tenantId] }),
  })
}
