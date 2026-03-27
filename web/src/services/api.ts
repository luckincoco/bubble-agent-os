import { useAuthStore } from '../stores/authStore'
import type { SpaceMember, SpaceRole, CustomAgent, BizProduct, BizCounterparty, BizProject, BizPurchase, BizSale, BizLogisticsRecord, BizPayment, InventoryItem, ReceivableItem, PayableItem, BizDashboardData, ProjectReconciliationItem } from '../types'

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

// ── Structured Business API (进销存 v0.5) ────────────────────────

async function bizGet<T>(path: string): Promise<T> {
  const res = await authFetch(`${BASE}/api/biz${path}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json.data
}

async function bizPost<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(`${BASE}/api/biz${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const json = await res.json()
  return json.data
}

async function bizPut(path: string, body: unknown): Promise<void> {
  const res = await authFetch(`${BASE}/api/biz${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

async function bizDel(path: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/biz${path}`, { method: 'DELETE' })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

// Products
export const fetchProducts = (q?: string) => bizGet<BizProduct[]>(`/products${q ? `?q=${encodeURIComponent(q)}` : ''}`)
export const createProductApi = (data: Partial<BizProduct>) => bizPost<BizProduct>('/products', data)
export const updateProductApi = (id: string, data: Partial<BizProduct>) => bizPut(`/products/${id}`, data)
export const deleteProductApi = (id: string) => bizDel(`/products/${id}`)

// Counterparties
export const fetchCounterparties = (type?: string) => bizGet<BizCounterparty[]>(`/counterparties${type ? `?type=${type}` : ''}`)
export const createCounterpartyApi = (data: Partial<BizCounterparty>) => bizPost<BizCounterparty>('/counterparties', data)
export const updateCounterpartyApi = (id: string, data: Partial<BizCounterparty>) => bizPut(`/counterparties/${id}`, data)
export const deleteCounterpartyApi = (id: string) => bizDel(`/counterparties/${id}`)

// Projects
export const fetchProjects = () => bizGet<BizProject[]>('/projects')
export const createProjectApi = (data: Partial<BizProject>) => bizPost<BizProject>('/projects', data)
export const updateProjectApi = (id: string, data: Partial<BizProject>) => bizPut(`/projects/${id}`, data)
export const deleteProjectApi = (id: string) => bizDel(`/projects/${id}`)

// Purchases
export const fetchPurchases = (filter?: Record<string, string>) => {
  const qs = filter ? '?' + new URLSearchParams(filter).toString() : ''
  return bizGet<BizPurchase[]>(`/purchases${qs}`)
}
export const createPurchaseApi = (data: Partial<BizPurchase>) => bizPost<BizPurchase>('/purchases', data)
export const updatePurchaseApi = (id: string, data: Partial<BizPurchase>) => bizPut(`/purchases/${id}`, data)
export const deletePurchaseApi = (id: string) => bizDel(`/purchases/${id}`)

// Sales
export const fetchSales = (filter?: Record<string, string>) => {
  const qs = filter ? '?' + new URLSearchParams(filter).toString() : ''
  return bizGet<BizSale[]>(`/sales${qs}`)
}
export const createSaleApi = (data: Partial<BizSale>) => bizPost<BizSale>('/sales', data)
export const updateSaleApi = (id: string, data: Partial<BizSale>) => bizPut(`/sales/${id}`, data)
export const deleteSaleApi = (id: string) => bizDel(`/sales/${id}`)

// Logistics
export const fetchLogistics = (filter?: Record<string, string>) => {
  const qs = filter ? '?' + new URLSearchParams(filter).toString() : ''
  return bizGet<BizLogisticsRecord[]>(`/logistics${qs}`)
}
export const createLogisticsApi = (data: Partial<BizLogisticsRecord>) => bizPost<BizLogisticsRecord>('/logistics', data)
export const deleteLogisticsApi = (id: string) => bizDel(`/logistics/${id}`)

// Payments
export const fetchPayments = (filter?: Record<string, string>) => {
  const qs = filter ? '?' + new URLSearchParams(filter).toString() : ''
  return bizGet<BizPayment[]>(`/payments${qs}`)
}
export const createPaymentApi = (data: Partial<BizPayment>) => bizPost<BizPayment>('/payments', data)
export const deletePaymentApi = (id: string) => bizDel(`/payments/${id}`)

// Computed Views
export const fetchInventory = () => bizGet<InventoryItem[]>('/inventory')
export const fetchReceivables = () => bizGet<ReceivableItem[]>('/receivables')
export const fetchPayables = () => bizGet<PayableItem[]>('/payables')
export const fetchBizDashboard = () => bizGet<BizDashboardData>('/dashboard')
export const fetchReconciliation = () => bizGet<ProjectReconciliationItem[]>('/reconciliation')

// Lookup
export const lookupProduct = (code: string) => bizGet<BizProduct | null>(`/lookup/product?code=${encodeURIComponent(code)}`)
export const lookupLastPrice = (productId: string) => bizGet<number | null>(`/lookup/last-price?productId=${productId}`)
