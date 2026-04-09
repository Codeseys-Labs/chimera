import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement } from 'react';

// Mock aws-amplify/auth
const mockGetCurrentUser = vi.fn();
const mockFetchAuthSession = vi.fn();
const mockSignOut = vi.fn();

vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
  fetchAuthSession: (...args: unknown[]) => mockFetchAuthSession(...args),
  signOut: (...args: unknown[]) => mockSignOut(...args),
}));

process.env.VITE_API_BASE_URL = 'https://api.test.com';

import { AuthProvider, useAuth } from '../hooks/use-auth';

function wrapper({ children }: { children: React.ReactNode }) {
  return createElement(AuthProvider, null, children);
}

describe('useAuth', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: unauthenticated
    mockGetCurrentUser.mockRejectedValue(new Error('Not authenticated'));
    mockFetchAuthSession.mockResolvedValue({ tokens: undefined });
    mockSignOut.mockResolvedValue(undefined);
  });

  it('throws error when useAuth used outside AuthProvider', () => {
    // Suppress console.error for the expected error
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');
    spy.mockRestore();
  });

  it('isLoading is true initially, false after init', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'user-1',
      username: 'testuser',
    });
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => 'tok-123', payload: {} } },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    // Initially loading
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('user is set after successful getCurrentUser', async () => {
    const mockUser = { userId: 'user-1', username: 'testuser' };
    mockGetCurrentUser.mockResolvedValue(mockUser);
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => 'tok-123', payload: {} } },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.user).toEqual(mockUser);
    expect(result.current.userId).toBe('user-1');
  });

  it('isAuthenticated is true when user exists, false when not', async () => {
    // Case 1: authenticated
    const mockUser = { userId: 'user-1', username: 'testuser' };
    mockGetCurrentUser.mockResolvedValue(mockUser);
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => 'tok', payload: {} } },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('isAuthenticated is false when getCurrentUser rejects', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('No user'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('tenantId falls back to userId when no custom:tenant_id claim', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'user-42',
      username: 'fallbackuser',
    });
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => 'tok', payload: {} } },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tenantId).toBe('user-42');
  });

  it('tenantId uses custom:tenant_id from JWT claims', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'user-42',
      username: 'tenantuser',
    });
    mockFetchAuthSession.mockResolvedValue({
      tokens: {
        idToken: {
          toString: () => 'tok',
          payload: { 'custom:tenant_id': 'tenant-abc' },
        },
      },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.tenantId).toBe('tenant-abc');
  });

  it('getAuthToken returns idToken string', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'user-1',
      username: 'testuser',
    });
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => 'my-id-token-123', payload: {} } },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let token: string | undefined;
    await act(async () => {
      token = await result.current.getAuthToken();
    });

    expect(token).toBe('my-id-token-123');
  });

  it('handleSignOut calls signOut and redirects to /login', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'user-1',
      username: 'testuser',
    });
    mockFetchAuthSession.mockResolvedValue({
      tokens: { idToken: { toString: () => 'tok', payload: {} } },
    });
    mockSignOut.mockResolvedValue(undefined);

    // Mock window.location
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...originalLocation, href: '' },
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.handleSignOut();
    });

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(window.location.href).toBe('/login');

    // Restore
    Object.defineProperty(window, 'location', {
      writable: true,
      value: originalLocation,
    });
  });
});
