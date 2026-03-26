import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'

interface Skill {
  id: string
  name: string
  description: string
  version: string
  installed: boolean
}

interface SkillCardProps {
  skill: Skill
  onInstall: (id: string) => void
  onUninstall: (id: string) => void
  isLoading?: boolean
}

/**
 * Card displaying a skill name, description, version, and install/uninstall button.
 */
export function SkillCard({ skill, onInstall, onUninstall, isLoading = false }: SkillCardProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">{skill.name}</CardTitle>
          <Badge variant="outline" className="shrink-0 text-xs">
            v{skill.version}
          </Badge>
        </div>
        <CardDescription className="text-xs">{skill.description}</CardDescription>
      </CardHeader>
      <CardContent />
      <CardFooter>
        {skill.installed ? (
          <Button
            variant="destructive"
            size="sm"
            disabled={isLoading}
            onClick={() => onUninstall(skill.id)}
            className="w-full"
          >
            {isLoading ? 'Uninstalling…' : 'Uninstall'}
          </Button>
        ) : (
          <Button
            variant="default"
            size="sm"
            disabled={isLoading}
            onClick={() => onInstall(skill.id)}
            className="w-full"
          >
            {isLoading ? 'Installing…' : 'Install'}
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}
