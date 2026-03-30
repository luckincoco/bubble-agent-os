import { useAuthStore } from '../stores/authStore'
import type { SpaceMember, SpaceRole, CustomAgent, BizProduct, BizCounterparty, BizProject, BizPurchase, BizSale, BizLogisticsRecord, BizPayment, BizInvoice, InventoryItem, ReceivableItem, PayableItem, BizDashboardData, ProjectReconciliationItem, UserPreferences, DocStatus, DocLink, ProfitReportRow, CounterpartyStatementResult, MonthlyOverviewRow } from '../types'

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

export async function softDeleteBubbleApi(id: string, reason: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/bubbles/${id}/soft`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error || `HTTP ${res.status}`)
  }
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

function bizUrl(path: string): string {
  const spaceId = useAuthStore.getState().currentSpaceId
  const sep = path.includes('?') ? '&' : '?'
  return spaceId ? `${BASE}/api/biz${path}${sep}spaceId=${spaceId}` : `${BASE}/api/biz${path}`
}

async function bizGet<T>(path: string): Promise<T> {
  const res = await authFetch(bizUrl(path))
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json()
  return json.data
}

async function bizPost<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(bizUrl(path), {
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
  const res = await authFetch(bizUrl(path), {
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
  const res = await authFetch(bizUrl(path), { method: 'DELETE' })
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

// v0.7: WithLines APIs (multi-line purchase/sale events)
export interface BizLineInput {
  productId: string
  brand: string
  material: string
  spec: string
  measureUnit: string
  weighMode: '理计' | '过磅'
  bundleCount?: number
  weightPerPc?: number
  quantity: number
  unitPrice: number
  taxInclusive: boolean
  subtotal: number
  notes?: string
}

export interface CreatePurchaseWithLinesPayload {
  date: string
  supplierId: string
  location?: string
  docNo?: string
  projectId?: string
  notes?: string
  paidAmount?: number
  paymentMethod?: string
  paymentNotes?: string
  lines: BizLineInput[]
}

export interface CreateSaleWithLinesPayload {
  date: string
  customerId: string
  location?: string
  docNo?: string
  projectId?: string
  notes?: string
  paidAmount?: number
  paymentMethod?: string
  paymentNotes?: string
  lines: BizLineInput[]
}

export const createPurchaseWithLinesApi = (data: CreatePurchaseWithLinesPayload) =>
  bizPost<BizPurchase>('/purchases-with-lines', data)

export const createSaleWithLinesApi = (data: CreateSaleWithLinesPayload) =>
  bizPost<BizSale>('/sales-with-lines', data)

// Reports (v0.6 SaaS + v0.7 enhancements)
export interface ProfitReportFilter {
  dateFrom?: string; dateTo?: string; customerId?: string; supplierId?: string
}

export function fetchProfitReport(filter: ProfitReportFilter = {}) {
  const params = new URLSearchParams()
  if (filter.dateFrom) params.set('dateFrom', filter.dateFrom)
  if (filter.dateTo) params.set('dateTo', filter.dateTo)
  if (filter.customerId) params.set('customerId', filter.customerId)
  if (filter.supplierId) params.set('supplierId', filter.supplierId)
  const qs = params.toString()
  return bizGet<ProfitReportRow[]>(`/reports/profit${qs ? `?${qs}` : ''}`)
}

export interface ProfitByOrderRow {
  docNo: string; date: string; supplierName: string; customerName: string
  purchaseAmount: number; purchaseTons: number; salesAmount: number; salesTons: number
  logisticsCost: number; grossProfit: number; margin: number
}

export function fetchProfitByOrder(filter: ProfitReportFilter = {}) {
  const params = new URLSearchParams()
  if (filter.dateFrom) params.set('dateFrom', filter.dateFrom)
  if (filter.dateTo) params.set('dateTo', filter.dateTo)
  if (filter.customerId) params.set('customerId', filter.customerId)
  if (filter.supplierId) params.set('supplierId', filter.supplierId)
  const qs = params.toString()
  return bizGet<ProfitByOrderRow[]>(`/reports/profit-by-order${qs ? `?${qs}` : ''}`)
}

export function fetchCounterpartyStatement(counterpartyId: string, dateFrom?: string, dateTo?: string) {
  const params = new URLSearchParams()
  if (dateFrom) params.set('dateFrom', dateFrom)
  if (dateTo) params.set('dateTo', dateTo)
  const qs = params.toString()
  return bizGet<CounterpartyStatementResult>(`/reports/statement/${counterpartyId}${qs ? `?${qs}` : ''}`)
}

export function fetchMonthlyOverview(year?: number) {
  return bizGet<MonthlyOverviewRow[]>(`/reports/monthly${year ? `?year=${year}` : ''}`)
}

// Lookup
export const lookupProduct = (code: string) => bizGet<BizProduct | null>(`/lookup/product?code=${encodeURIComponent(code)}`)
export const lookupLastPrice = (productId: string) => bizGet<number | null>(`/lookup/last-price?productId=${productId}`)

// Invoices
export const fetchInvoices = (filter?: Record<string, string>) => {
  const qs = filter ? '?' + new URLSearchParams(filter).toString() : ''
  return bizGet<BizInvoice[]>(`/invoices${qs}`)
}
export const createInvoiceApi = (data: Partial<BizInvoice>) => bizPost<BizInvoice>('/invoices', data)
export const deleteInvoiceApi = (id: string) => bizDel(`/invoices/${id}`)

// ── Document Lifecycle (v0.6) ─────────────────────────────────────

export async function transitionDocStatus(docType: string, id: string, newStatus: DocStatus, cancelReason?: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/biz/doc/transition`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docType, id, newStatus, cancelReason }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}

export async function fetchDocLinks(docType: string, id: string): Promise<{ children: DocLink[]; parents: DocLink[] }> {
  const res = await authFetch(`${BASE}/api/biz/doc/links/${docType}/${id}`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export async function createFromDoc(action: string, sourceId: string): Promise<{ doc: unknown; link: DocLink }> {
  const res = await authFetch(`${BASE}/api/biz/doc/create-from`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, sourceId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const json = await res.json()
  return json.data
}

export async function linkPaymentToInvoiceApi(paymentId: string, invoiceId: string): Promise<DocLink> {
  const res = await authFetch(`${BASE}/api/biz/doc/link-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentId, invoiceId }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const json = await res.json()
  return json.data
}

export async function amendDocApi(docType: string, id: string): Promise<string> {
  const res = await authFetch(`${BASE}/api/biz/doc/amend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ docType, id }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  const json = await res.json()
  return json.newId
}

// --- User Preferences ---

export async function fetchPreferences(): Promise<UserPreferences> {
  const res = await authFetch(`${BASE}/api/preferences`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  return data.preferences
}

export async function updatePreferences(preferences: UserPreferences): Promise<void> {
  const res = await authFetch(`${BASE}/api/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ preferences }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
}
