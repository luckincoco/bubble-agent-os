import { useAuthStore } from '../stores/authStore'
import type { SpaceMember, SpaceRole, CustomAgent } from '../types'

const BASE = import.meta.env.DEV ? 'http://localhost:3000' : ''

function getHeaders(): HeadersInit {
  const token = useAuthStore.getState().token
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    ...options,
    headers: { ...getHeaders(), ...(options.headers || {}) },
  })
  if (res.status === 401) {
    useAuthStore.getState().logout()
    throw new Error('登录已过期，请重新登录')
  }
  return res
}

export async function fetchMemories(spaceId?: string) {
  const qs = spaceId ? `?spaceId=${spaceId}` : ''
  const res = await authFetch(`${BASE}/api/memories${qs}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function fetchHealth() {
  const res = await fetch(`${BASE}/api/health`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/change-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword, newPassword }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

export async function uploadExcel(file: File): Promise<{ created: number; sheet: string; columns: string[] }> {
  const form = new FormData()
  form.append('file', file)
  const res = await authFetch(`${BASE}/api/import-excel`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// --- P2-1: OCR image import ---

export async function uploadImage(file: File): Promise<{ bubbleId: string; text: string; confidence: number; regions: number }> {
  const form = new FormData()
  form.append('file', file)
  const res = await authFetch(`${BASE}/api/import-image`, { method: 'POST', body: form })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

// --- P2-4: Space member management ---

export async function createSpace(name: string, description?: string): Promise<{ id: string; name: string }> {
  const res = await authFetch(`${BASE}/api/spaces`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, description }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export async function fetchSpaceMembers(spaceId: string): Promise<SpaceMember[]> {
  const res = await authFetch(`${BASE}/api/spaces/${spaceId}/members`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.members
}

export async function addSpaceMember(spaceId: string, username: string, role: SpaceRole = 'editor'): Promise<void> {
  const res = await authFetch(`${BASE}/api/spaces/${spaceId}/members`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, role }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

export async function updateMemberRole(spaceId: string, userId: string, role: SpaceRole): Promise<void> {
  const res = await authFetch(`${BASE}/api/spaces/${spaceId}/members/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

export async function removeSpaceMember(spaceId: string, userId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/spaces/${spaceId}/members/${userId}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

// --- P2-3: Custom Agent CRUD ---

export async function fetchAgents(): Promise<CustomAgent[]> {
  const res = await authFetch(`${BASE}/api/agents`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.agents
}

export async function createAgentApi(agent: { name: string; description?: string; systemPrompt: string; avatar?: string; tools?: string[]; spaceIds?: string[] }): Promise<CustomAgent> {
  const res = await authFetch(`${BASE}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(agent),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const data = await res.json()
  return data.agent
}

export async function updateAgentApi(id: string, updates: Partial<{ name: string; description: string; systemPrompt: string; avatar: string; tools: string[]; spaceIds: string[] }>): Promise<CustomAgent> {
  const res = await authFetch(`${BASE}/api/agents/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const data = await res.json()
  return data.agent
}

export async function deleteAgentApi(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/agents/${id}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

export async function activateAgent(agentId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/agents/${agentId}/activate`, { method: 'POST' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}
