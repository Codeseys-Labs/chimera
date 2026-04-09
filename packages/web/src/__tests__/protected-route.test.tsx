import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProtectedRoute } from '../components/protected-route';

// Mock the useAuth hook
vi.mock('../hooks/use-auth', () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from '../hooks/use-auth';
const mockUseAuth = useAuth as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

describe('ProtectedRoute', () => {
  it('shows spinner when loading', () => {
    mockUseAuth.mockReturnValue({
      isLoading: true,
      isAuthenticated: false,
      user: null,
      tenantId: '',
      userId: '',
      getAuthToken: vi.fn(),
      handleSignOut: vi.fn(),
    });

    const { container } = render(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>
    );

    expect(container.querySelector('.animate-spin')).toBeTruthy();
    expect(screen.queryByText('Protected content')).toBeNull();
  });

  it('renders children when authenticated', () => {
    mockUseAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: true,
      user: { userId: 'test-user', username: 'test' },
      tenantId: 'tenant-1',
      userId: 'test-user',
      getAuthToken: vi.fn(),
      handleSignOut: vi.fn(),
    });

    render(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>
    );

    expect(screen.getByText('Protected content')).toBeTruthy();
  });

  it('redirects to /login when unauthenticated', () => {
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
    });

    mockUseAuth.mockReturnValue({
      isLoading: false,
      isAuthenticated: false,
      user: null,
      tenantId: '',
      userId: '',
      getAuthToken: vi.fn(),
      handleSignOut: vi.fn(),
    });

    render(
      <ProtectedRoute>
        <div>Protected content</div>
      </ProtectedRoute>
    );

    expect(window.location.href).toBe('/login');
  });
});
