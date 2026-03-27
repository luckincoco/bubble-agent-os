import { create } from 'zustand'
import type {
  BizProduct, BizCounterparty, BizProject,
  BizPurchase, BizSale, BizLogisticsRecord, BizPayment,
  InventoryItem, ReceivableItem, PayableItem, BizDashboardData, ProjectReconciliationItem,
} from '../types'
import {
  fetchProducts, fetchCounterparties, fetchProjects,
  fetchPurchases, fetchSales, fetchLogistics, fetchPayments,
  fetchInventory, fetchReceivables, fetchPayables, fetchBizDashboard, fetchReconciliation,
  createProductApi, updateProductApi, deleteProductApi,
  createCounterpartyApi, updateCounterpartyApi, deleteCounterpartyApi,
  createProjectApi, updateProjectApi, deleteProjectApi,
  createPurchaseApi, createSaleApi, createLogisticsApi, createPaymentApi,
  deletePurchaseApi, deleteSaleApi, deleteLogisticsApi, deletePaymentApi,
} from '../services/api'

interface BizState {
  // Master data
  products: BizProduct[]
  counterparties: BizCounterparty[]
  projects: BizProject[]

  // Transaction data
  purchases: BizPurchase[]
  sales: BizSale[]
  logistics: BizLogisticsRecord[]
  payments: BizPayment[]

  // Computed views
  inventory: InventoryItem[]
  receivables: ReceivableItem[]
  payables: PayableItem[]
  reconciliation: ProjectReconciliationItem[]
  dashboard: BizDashboardData | null

  // UI state
  loading: boolean
  error: string | null

  // Actions
  loadMasterData: () => Promise<void>
  loadDashboard: () => Promise<void>
  loadPurchases: (filter?: Record<string, string>) => Promise<void>
  loadSales: (filter?: Record<string, string>) => Promise<void>
  loadLogistics: (filter?: Record<string, string>) => Promise<void>
  loadPayments: (filter?: Record<string, string>) => Promise<void>
  loadInventory: () => Promise<void>
  loadReceivables: () => Promise<void>
  loadPayables: () => Promise<void>
  loadReconciliation: () => Promise<void>

  // Master data CRUD
  addProduct: (data: Partial<BizProduct>) => Promise<void>
  editProduct: (id: string, data: Partial<BizProduct>) => Promise<void>
  removeProduct: (id: string) => Promise<void>
  addCounterparty: (data: Partial<BizCounterparty>) => Promise<void>
  editCounterparty: (id: string, data: Partial<BizCounterparty>) => Promise<void>
  removeCounterparty: (id: string) => Promise<void>
  addProject: (data: Partial<BizProject>) => Promise<void>
  editProject: (id: string, data: Partial<BizProject>) => Promise<void>
  removeProject: (id: string) => Promise<void>

  createPurchase: (data: Partial<BizPurchase>) => Promise<BizPurchase>
  createSale: (data: Partial<BizSale>) => Promise<BizSale>
  createLogistic: (data: Partial<BizLogisticsRecord>) => Promise<BizLogisticsRecord>
  createPayment: (data: Partial<BizPayment>) => Promise<BizPayment>

  removePurchase: (id: string) => Promise<void>
  removeSale: (id: string) => Promise<void>
  removeLogistic: (id: string) => Promise<void>
  removePayment: (id: string) => Promise<void>
}

export const useBizStore = create<BizState>((set, get) => ({
  products: [],
  counterparties: [],
  projects: [],
  purchases: [],
  sales: [],
  logistics: [],
  payments: [],
  inventory: [],
  receivables: [],
  payables: [],
  reconciliation: [],
  dashboard: null,
  loading: false,
  error: null,

  loadMasterData: async () => {
    try {
      const [products, counterparties, projects] = await Promise.all([
        fetchProducts(),
        fetchCounterparties(),
        fetchProjects(),
      ])
      set({ products, counterparties, projects })
    } catch (e: any) {
      set({ error: e.message })
    }
  },

  loadDashboard: async () => {
    set({ loading: true, error: null })
    try {
      const dashboard = await fetchBizDashboard()
      set({ dashboard, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadPurchases: async (filter) => {
    set({ loading: true })
    try {
      const purchases = await fetchPurchases(filter)
      set({ purchases, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadSales: async (filter) => {
    set({ loading: true })
    try {
      const sales = await fetchSales(filter)
      set({ sales, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadLogistics: async (filter) => {
    set({ loading: true })
    try {
      const logistics = await fetchLogistics(filter)
      set({ logistics, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadPayments: async (filter) => {
    set({ loading: true })
    try {
      const payments = await fetchPayments(filter)
      set({ payments, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadInventory: async () => {
    set({ loading: true })
    try {
      const inventory = await fetchInventory()
      set({ inventory, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadReceivables: async () => {
    set({ loading: true })
    try {
      const receivables = await fetchReceivables()
      set({ receivables, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadPayables: async () => {
    set({ loading: true })
    try {
      const payables = await fetchPayables()
      set({ payables, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  loadReconciliation: async () => {
    set({ loading: true })
    try {
      const reconciliation = await fetchReconciliation()
      set({ reconciliation, loading: false })
    } catch (e: any) {
      set({ error: e.message, loading: false })
    }
  },

  // Master data CRUD
  addProduct: async (data) => {
    const p = await createProductApi(data)
    set({ products: [...get().products, p] })
  },
  editProduct: async (id, data) => {
    await updateProductApi(id, data)
    set({ products: get().products.map(p => p.id === id ? { ...p, ...data } as BizProduct : p) })
  },
  removeProduct: async (id) => {
    await deleteProductApi(id)
    set({ products: get().products.filter(p => p.id !== id) })
  },
  addCounterparty: async (data) => {
    const c = await createCounterpartyApi(data)
    set({ counterparties: [...get().counterparties, c] })
  },
  editCounterparty: async (id, data) => {
    await updateCounterpartyApi(id, data)
    set({ counterparties: get().counterparties.map(c => c.id === id ? { ...c, ...data } as BizCounterparty : c) })
  },
  removeCounterparty: async (id) => {
    await deleteCounterpartyApi(id)
    set({ counterparties: get().counterparties.filter(c => c.id !== id) })
  },
  addProject: async (data) => {
    const p = await createProjectApi(data)
    set({ projects: [...get().projects, p] })
  },
  editProject: async (id, data) => {
    await updateProjectApi(id, data)
    set({ projects: get().projects.map(p => p.id === id ? { ...p, ...data } as BizProject : p) })
  },
  removeProject: async (id) => {
    await deleteProjectApi(id)
    set({ projects: get().projects.filter(p => p.id !== id) })
  },

  createPurchase: async (data) => {
    const result = await createPurchaseApi(data)
    set({ purchases: [result, ...get().purchases] })
    return result
  },

  createSale: async (data) => {
    const result = await createSaleApi(data)
    set({ sales: [result, ...get().sales] })
    return result
  },

  createLogistic: async (data) => {
    const result = await createLogisticsApi(data)
    set({ logistics: [result, ...get().logistics] })
    return result
  },

  createPayment: async (data) => {
    const result = await createPaymentApi(data)
    set({ payments: [result, ...get().payments] })
    return result
  },

  removePurchase: async (id) => {
    await deletePurchaseApi(id)
    set({ purchases: get().purchases.filter(p => p.id !== id) })
  },

  removeSale: async (id) => {
    await deleteSaleApi(id)
    set({ sales: get().sales.filter(p => p.id !== id) })
  },

  removeLogistic: async (id) => {
    await deleteLogisticsApi(id)
    set({ logistics: get().logistics.filter(p => p.id !== id) })
  },

  removePayment: async (id) => {
    await deletePaymentApi(id)
    set({ payments: get().payments.filter(p => p.id !== id) })
  },
}))
