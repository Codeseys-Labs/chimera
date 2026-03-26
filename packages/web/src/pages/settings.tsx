import { getCurrentUser, updatePassword } from 'aws-amplify/auth'
import { useEffect, useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTheme } from '@/components/theme-provider'

export function SettingsPage() {
  const [email, setEmail] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    getCurrentUser()
      .then((u) => {
        setEmail(u.signInDetails?.loginId ?? '')
        setDisplayName(u.username)
      })
      .catch(console.error)
  }, [])

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault()
    setPwLoading(true)
    setPwError('')
    setPwSuccess('')
    try {
      await updatePassword({ oldPassword, newPassword })
      setPwSuccess('Password updated successfully.')
      setOldPassword('')
      setNewPassword('')
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Password change failed')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Tabs defaultValue="account">
        <TabsList>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="security">Security</TabsTrigger>
          <TabsTrigger value="integrations">Integrations</TabsTrigger>
          <TabsTrigger value="appearance">Appearance</TabsTrigger>
        </TabsList>

        {/* Account */}
        <TabsContent value="account">
          <Card>
            <CardHeader>
              <CardTitle>Account</CardTitle>
              <CardDescription>Your profile information from Cognito</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input value={email} disabled className="cursor-not-allowed" />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Security */}
        <TabsContent value="security">
          <Card>
            <CardHeader>
              <CardTitle>Security</CardTitle>
              <CardDescription>Change your password and MFA settings</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                {pwError && (
                  <Alert variant="destructive">
                    <AlertDescription>{pwError}</AlertDescription>
                  </Alert>
                )}
                {pwSuccess && (
                  <Alert>
                    <AlertDescription>{pwSuccess}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="old-pw">Current Password</Label>
                  <Input
                    id="old-pw"
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="new-pw">New Password</Label>
                  <Input
                    id="new-pw"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </div>
                <Button type="submit" disabled={pwLoading}>
                  {pwLoading ? 'Updating…' : 'Update Password'}
                </Button>
              </form>

              <Separator className="my-6" />
              <div>
                <h3 className="mb-2 text-sm font-medium">Multi-Factor Authentication</h3>
                <p className="text-sm text-muted-foreground">
                  MFA setup is managed through Cognito. Contact your administrator to configure TOTP.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Integrations */}
        <TabsContent value="integrations">
          <Card>
            <CardHeader>
              <CardTitle>Integrations</CardTitle>
              <CardDescription>Connected services</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between rounded-md border p-4">
                <div>
                  <p className="font-medium">Slack</p>
                  <p className="text-sm text-muted-foreground">Connect your Slack workspace</p>
                </div>
                <Button variant="outline" size="sm">Connect</Button>
              </div>
              <div className="flex items-center justify-between rounded-md border p-4">
                <div>
                  <p className="font-medium">Discord</p>
                  <p className="text-sm text-muted-foreground">Add the Chimera Discord bot</p>
                </div>
                <Button variant="outline" size="sm" asChild>
                  <a href="#discord-invite" target="_blank" rel="noreferrer">
                    Invite Bot
                  </a>
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Appearance */}
        <TabsContent value="appearance">
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Customize the interface theme</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-3">
                {(['light', 'dark', 'system'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={`rounded-md border p-3 text-sm capitalize transition-colors hover:bg-accent ${
                      theme === t ? 'border-primary bg-accent' : ''
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
