import { useState } from 'react'
import { signIn, signUp, confirmSignUp } from 'aws-amplify/auth'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type View = 'signin' | 'signup' | 'confirm' | 'forgot'

export function LoginPage() {
  const [view, setView] = useState<View>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  function clearMessages() {
    setError('')
    setSuccess('')
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await signIn({ username: email, password })
      window.location.href = '/dashboard'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await signUp({
        username: email,
        password,
        options: { userAttributes: { email, name } },
      })
      setSuccess('Account created! Check your email for a confirmation code.')
      setView('confirm')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await confirmSignUp({ username: email, confirmationCode: confirmCode })
      setSuccess('Email confirmed! You can now sign in.')
      setView('signin')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <CardTitle className="text-3xl">Chimera</CardTitle>
          <CardDescription>Multi-Tenant Agent Platform</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {success && (
            <Alert className="mb-4">
              <AlertDescription>{success}</AlertDescription>
            </Alert>
          )}

          {view === 'signin' && (
            <form onSubmit={handleSignIn} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Signing in…' : 'Sign In'}
              </Button>
              <div className="flex justify-between text-sm">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('forgot') }}
                  className="text-muted-foreground underline-offset-4 hover:underline"
                >
                  Forgot password?
                </button>
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signup') }}
                  className="text-muted-foreground underline-offset-4 hover:underline"
                >
                  Create account
                </button>
              </div>
            </form>
          )}

          {view === 'signup' && (
            <form onSubmit={handleSignUp} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Full Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-email">Email</Label>
                <Input
                  id="reg-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-password">Password</Label>
                <Input
                  id="reg-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  Min 12 characters with uppercase, lowercase, number, and special character.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Creating account…' : 'Create Account'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                Already have an account?{' '}
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signin') }}
                  className="underline-offset-4 hover:underline"
                >
                  Sign in
                </button>
              </p>
            </form>
          )}

          {view === 'confirm' && (
            <form onSubmit={handleConfirm} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="code">Confirmation Code</Label>
                <Input
                  id="code"
                  value={confirmCode}
                  onChange={(e) => setConfirmCode(e.target.value)}
                  placeholder="Enter the code from your email"
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Confirming…' : 'Confirm Email'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signin') }}
                  className="underline-offset-4 hover:underline"
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {view === 'forgot' && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Password reset via Cognito. Enter your email and follow the instructions.
              </p>
              <div className="space-y-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <Button variant="outline" className="w-full" onClick={() => { clearMessages(); setView('signin') }}>
                Back to Sign In
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
