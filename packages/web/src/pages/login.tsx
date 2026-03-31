import { useState } from 'react'
import {
  signIn,
  signUp,
  confirmSignUp,
  confirmSignIn,
  resetPassword,
  confirmResetPassword,
  fetchAuthSession,
} from 'aws-amplify/auth'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type View =
  | 'signIn'
  | 'signUp'
  | 'confirmSignUp'
  | 'mfa'
  | 'mfaSetup'
  | 'newPassword'
  | 'forgotPassword'
  | 'confirmReset'
  | 'success'

export function LoginPage() {
  const [view, setView] = useState<View>('signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [confirmCode, setConfirmCode] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaType, setMfaType] = useState<'totp' | 'sms'>('totp')
  const [totpSecret, setTotpSecret] = useState('')
  const [totpUri, setTotpUri] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const callbackUrl = new URLSearchParams(window.location.search).get('callback')

  function clearMessages() {
    setError('')
    setSuccess('')
  }

  async function handleAuthComplete() {
    const session = await fetchAuthSession()
    const accessToken = session.tokens?.accessToken?.toString() ?? ''
    const idToken = session.tokens?.idToken?.toString() ?? ''

    if (callbackUrl && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(callbackUrl)) {
      await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: accessToken, id_token: idToken, refresh_token: '', expires_in: 3600 }),
      })
      setView('success')
    } else {
      window.location.href = '/dashboard'
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      const result = await signIn({ username: email, password })
      if (result.isSignedIn) {
        await handleAuthComplete()
        return
      }
      switch (result.nextStep.signInStep) {
        case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
          setMfaType('totp')
          setView('mfa')
          break
        case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
          setMfaType('sms')
          setView('mfa')
          break
        case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
          setTotpSecret(result.nextStep.totpSetupDetails?.sharedSecret ?? '')
          setTotpUri(result.nextStep.totpSetupDetails?.getSetupUri('Chimera', email)?.toString() ?? '')
          setView('mfaSetup')
          break
        case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
          setView('newPassword')
          break
        case 'CONFIRM_SIGN_UP':
          setView('confirmSignUp')
          break
        default:
          setError('Unexpected auth step: ' + result.nextStep.signInStep)
      }
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
      setView('confirmSignUp')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmSignUp(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await confirmSignUp({ username: email, confirmationCode: confirmCode })
      setSuccess('Email confirmed! You can now sign in.')
      setView('signIn')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Confirmation failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleMfaSubmit(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      const result = await confirmSignIn({ challengeResponse: mfaCode })
      if (result.isSignedIn) {
        await handleAuthComplete()
      } else {
        switch (result.nextStep.signInStep) {
          case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
            setMfaType('totp')
            setView('mfa')
            break
          case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
            setMfaType('sms')
            setView('mfa')
            break
          case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
            setTotpSecret(result.nextStep.totpSetupDetails?.sharedSecret ?? '')
            setTotpUri(result.nextStep.totpSetupDetails?.getSetupUri('Chimera', email)?.toString() ?? '')
            setView('mfaSetup')
            break
          case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
            setView('newPassword')
            break
          default:
            setError('Unexpected auth step: ' + result.nextStep.signInStep)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleMfaSetupSubmit(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      const result = await confirmSignIn({ challengeResponse: mfaCode })
      if (result.isSignedIn) {
        await handleAuthComplete()
      } else {
        setError('Unexpected auth step: ' + result.nextStep.signInStep)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Setup verification failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleNewPasswordSubmit(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      const result = await confirmSignIn({ challengeResponse: newPassword })
      if (result.isSignedIn) {
        await handleAuthComplete()
      } else {
        setError('Unexpected auth step: ' + result.nextStep.signInStep)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Password change failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleForgotPassword(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await resetPassword({ username: email })
      setSuccess('Reset code sent to your email.')
      setView('confirmReset')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset code')
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirmReset(e: React.FormEvent) {
    e.preventDefault()
    clearMessages()
    setLoading(true)
    try {
      await confirmResetPassword({ username: email, confirmationCode: resetCode, newPassword })
      setSuccess('Password reset! You can now sign in.')
      setView('signIn')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
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

          {view === 'signIn' && (
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
                  onClick={() => { clearMessages(); setView('forgotPassword') }}
                  className="text-muted-foreground underline-offset-4 hover:underline"
                >
                  Forgot password?
                </button>
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signUp') }}
                  className="text-muted-foreground underline-offset-4 hover:underline"
                >
                  Create account
                </button>
              </div>
            </form>
          )}

          {view === 'signUp' && (
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
                  onClick={() => { clearMessages(); setView('signIn') }}
                  className="underline-offset-4 hover:underline"
                >
                  Sign in
                </button>
              </p>
            </form>
          )}

          {view === 'confirmSignUp' && (
            <form onSubmit={handleConfirmSignUp} className="space-y-4">
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
                  onClick={() => { clearMessages(); setView('signIn') }}
                  className="underline-offset-4 hover:underline"
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {view === 'mfa' && (
            <form onSubmit={handleMfaSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {mfaType === 'totp'
                  ? 'Enter the code from your authenticator app.'
                  : 'Enter the code sent to your phone.'}
              </p>
              <div className="space-y-2">
                <Label htmlFor="mfa-code">Verification Code</Label>
                <Input
                  id="mfa-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="000000"
                  required
                  autoComplete="one-time-code"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Verifying…' : 'Verify'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signIn') }}
                  className="underline-offset-4 hover:underline"
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {view === 'mfaSetup' && (
            <form onSubmit={handleMfaSetupSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Set up your authenticator app. Scan the QR code or enter the secret key manually.
              </p>
              {totpUri && (
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Authenticator URI:</p>
                  <pre className="bg-muted p-3 rounded text-xs font-mono break-all whitespace-pre-wrap">{totpUri}</pre>
                </div>
              )}
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Secret key (manual entry):</p>
                <pre className="bg-muted p-3 rounded text-xs font-mono tracking-widest">{totpSecret}</pre>
              </div>
              <div className="space-y-2">
                <Label htmlFor="setup-code">Verification Code</Label>
                <Input
                  id="setup-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value)}
                  placeholder="000000"
                  required
                  autoComplete="one-time-code"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Verifying…' : 'Verify and Enable'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signIn') }}
                  className="underline-offset-4 hover:underline"
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {view === 'newPassword' && (
            <form onSubmit={handleNewPasswordSubmit} className="space-y-4">
              <p className="text-sm text-muted-foreground">
                A new password is required for your account.
              </p>
              <div className="space-y-2">
                <Label htmlFor="new-password">New Password</Label>
                <Input
                  id="new-password"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  Min 12 characters with uppercase, lowercase, number, and special character.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Updating…' : 'Set Password'}
              </Button>
            </form>
          )}

          {view === 'forgotPassword' && (
            <form onSubmit={handleForgotPassword} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="forgot-email">Email</Label>
                <Input
                  id="forgot-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Sending…' : 'Send Reset Code'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signIn') }}
                  className="underline-offset-4 hover:underline"
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {view === 'confirmReset' && (
            <form onSubmit={handleConfirmReset} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="reset-code">Reset Code</Label>
                <Input
                  id="reset-code"
                  value={resetCode}
                  onChange={(e) => setResetCode(e.target.value)}
                  placeholder="Enter the code from your email"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="new-pass">New Password</Label>
                <Input
                  id="new-pass"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
                <p className="text-xs text-muted-foreground">
                  Min 12 characters with uppercase, lowercase, number, and special character.
                </p>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Resetting…' : 'Reset Password'}
              </Button>
              <p className="text-center text-sm text-muted-foreground">
                <button
                  type="button"
                  onClick={() => { clearMessages(); setView('signIn') }}
                  className="underline-offset-4 hover:underline"
                >
                  Back to sign in
                </button>
              </p>
            </form>
          )}

          {view === 'success' && (
            <div className="space-y-4 text-center">
              <p className="text-lg font-medium">Authenticated!</p>
              <p className="text-sm text-muted-foreground">
                You can close this window and return to the CLI.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
