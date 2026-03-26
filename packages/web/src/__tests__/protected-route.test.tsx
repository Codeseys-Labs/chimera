import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { ProtectedRoute } from '../components/protected-route'

vi.mock('aws-amplify/auth', () => ({
  getCurrentUser: vi.fn(),
}))

import { getCurrentUser } from 'aws-amplify/auth'
const mockGetCurrentUser = vi.mocked(getCurrentUser)

// Mock window.location.href assignment
const locationSpy = vi.spyOn(window, 'location', 'get')

describe('ProtectedRoute', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    // Reset location mock
    locationSpy.mockReturnValue({ href: '' } as Location)
  })

  it('renders children when authenticated', async () => {
    mockGetCurrentUser.mockResolvedValue({
      userId: 'user-123',
      username: 'testuser',
    } as Awaited<ReturnType<typeof getCurrentUser>>)

    render(
      <ProtectedRoute>
        <div>Protected Content</div>
      </ProtectedRoute>,
    )

    await waitFor(() => {
      expect(screen.getByText('Protected Content')).toBeTruthy()
    })
  })

  it('shows loading spinner while checking auth', () => {
    // Never resolves
    mockGetCurrentUser.mockImplementation(() => new Promise(() => {}))

    const { container } = render(
      <ProtectedRoute>
        <div>Content</div>
      </ProtectedRoute>,
    )

    // Loading spinner should be present
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeTruthy()
    // Content should NOT be visible yet
    expect(screen.queryByText('Content')).toBeNull()
  })

  it('redirects to /login when unauthenticated', async () => {
    mockGetCurrentUser.mockRejectedValue(new Error('Not authenticated'))

    const locationAssign = vi.fn()
    Object.defineProperty(window, 'location', {
      value: { href: '', assign: locationAssign },
      writable: true,
    })

    render(
      <ProtectedRoute>
        <div>Content</div>
      </ProtectedRoute>,
    )

    await waitFor(() => {
      expect(window.location.href).toBe('/login')
    })
  })
})
