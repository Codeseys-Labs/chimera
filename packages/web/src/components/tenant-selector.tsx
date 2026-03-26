import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface Tenant {
  id: string
  name: string
}

interface TenantSelectorProps {
  tenants: Tenant[]
  activeTenantId: string
  onChange: (tenantId: string) => void
}

/**
 * Dropdown for switching between tenants (admin users with multi-tenant access).
 */
export function TenantSelector({ tenants, activeTenantId, onChange }: TenantSelectorProps) {
  return (
    <Select value={activeTenantId} onValueChange={onChange}>
      <SelectTrigger className="w-48">
        <SelectValue placeholder="Select tenant" />
      </SelectTrigger>
      <SelectContent>
        {tenants.map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
