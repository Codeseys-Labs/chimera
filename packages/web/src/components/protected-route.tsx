import { useEffect, useState } from 'react'
import { getCurrentUser } from 'aws-amplify/auth'

interface ProtectedRouteProps {
  children: React.ReactNode
}

type AuthState = 'checking' | 'authenticated' | 'unauthenticated'

/**
 * Wraps content that requires authentication.
 * Redirects to /login if no active Amplify session exists.
 */
export function ProtectedRoute({ children }: ProtectedRouteProps) {
  const [authState, setAuthState] = useState<AuthState>('checking')

  useEffect(() => {
    getCurrentUser()
      .then(() => setAuthState('authenticated'))
      .catch(() => setAuthState('unauthenticated'))
  }, [])

  if (authState === 'checking') {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    )
  }

  if (authState === 'unauthenticated') {
    window.location.href = '/login'
    return null
  }

  return <>{children}</>
}
