import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useSessions } from '../hooks/use-sessions'

// Mock auth and api-client
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: vi.fn().mockResolvedValue({
    tokens: { idToken: { toString: () => 'tok', payload: {} } },
  }),
}))

vi.mock('../lib/api-client', () => ({
  apiGet: vi.fn(),
}))

vi.stubEnv('VITE_API_BASE_URL', 'https://api.test.com')

import { apiGet } from '../lib/api-client'
const mockApiGet = vi.mocked(apiGet)

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return createElement(QueryClientProvider, { client: qc }, children)
}

describe('useSessions', () => {
  beforeEach(() => vi.resetAllMocks())

  it('returns session list on success', async () => {
    const mockSessions = {
      sessions: [
        { id: '1', title: 'Session 1', status: 'active', createdAt: '', updatedAt: '' },
        { id: '2', title: 'Session 2', status: 'idle', createdAt: '', updatedAt: '' },
      ],
    }
    mockApiGet.mockResolvedValue(mockSessions)

    const { result } = renderHook(() => useSessions('tenant-abc'), { wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.sessions).toHaveLength(2)
    expect(result.current.data?.sessions[0].title).toBe('Session 1')
  })

  it('returns error state on failure', async () => {
    mockApiGet.mockRejectedValue(new Error('Network error'))

    const { result } = renderHook(() => useSessions('tenant-abc'), { wrapper })

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error).toBeDefined()
  })

  it('does not fetch when tenantId is empty', () => {
    const { result } = renderHook(() => useSessions(''), { wrapper })
    expect(result.current.fetchStatus).toBe('idle')
    expect(mockApiGet).not.toHaveBeenCalled()
  })
})
