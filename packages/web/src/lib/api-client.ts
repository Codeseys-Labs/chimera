import { fetchAuthSession } from 'aws-amplify/auth'

export async function authFetch(path: string, init?: RequestInit): Promise<Response> {
  const session = await fetchAuthSession()
  const token = session.tokens?.idToken?.toString()

  if (!token) {
    throw new Error('Not authenticated')
  }

  const base = import.meta.env.VITE_API_BASE_URL as string
  return fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    },
  })
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await authFetch(path)
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

export async function apiDelete(path: string): Promise<void> {
  const res = await authFetch(path, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`)
  }
}
