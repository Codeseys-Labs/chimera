import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from 'react';
import { getCurrentUser, fetchAuthSession, signOut, type AuthUser } from 'aws-amplify/auth';

interface AuthContextValue {
  /** Cognito user object (null while loading or if unauthenticated) */
  user: AuthUser | null;
  /** Tenant ID from JWT custom claim, falls back to userId */
  tenantId: string;
  /** Cognito user sub */
  userId: string;
  /** True while the initial auth check is in progress */
  isLoading: boolean;
  /** Whether a valid session exists */
  isAuthenticated: boolean;
  /** Get a fresh ID token for API calls */
  getAuthToken: () => Promise<string | undefined>;
  /** Sign out and redirect to login */
  handleSignOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenantId, setTenantId] = useState('');
  const [userId, setUserId] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function init() {
      try {
        const currentUser = await getCurrentUser();
        const session = await fetchAuthSession();
        const claims = session.tokens?.idToken?.payload;
        const tid = (claims?.['custom:tenant_id'] as string) || currentUser.userId;

        setUser(currentUser);
        setTenantId(tid);
        setUserId(currentUser.userId);
      } catch {
        // Not authenticated — leave defaults
      } finally {
        setIsLoading(false);
      }
    }
    init();
  }, []);

  const getAuthToken = useCallback(async () => {
    const session = await fetchAuthSession();
    return session.tokens?.idToken?.toString();
  }, []);

  const handleSignOut = useCallback(async () => {
    await signOut();
    window.location.href = '/login';
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        tenantId,
        userId,
        isLoading,
        isAuthenticated: !!user,
        getAuthToken,
        handleSignOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
