/**
 * Business record types for natural language entry.
 * Follows the "Time - Person - Thing - Value" paradigm.
 */

export type BizType = 'procurement' | 'sales' | 'payment' | 'logistics'

export interface BizRecordBase {
  bizType: BizType
  date: string          // YYYY-MM-DD
  rawInput: string      // original user input
  project?: string      // associated project / construction site
}

export interface ProcurementRecord extends BizRecordBase {
  bizType: 'procurement'
  supplier: string
  product: string
  spec?: string
  quantity: number
  unitPrice: number
  totalAmount?: number
  invoiceStatus?: string
  paymentStatus?: string
}

export interface SalesRecord extends BizRecordBase {
  bizType: 'sales'
  customer: string
  product: string
  spec?: string
  quantity: number
  unitPrice: number
  totalAmount?: number
  invoiceStatus?: string
  collectionStatus?: string
}

export interface PaymentRecord extends BizRecordBase {
  bizType: 'payment'
  counterparty: string
  direction: '收' | '付'
  amount: number
  method?: string
}

export interface LogisticsRecord extends BizRecordBase {
  bizType: 'logistics'
  carrier?: string
  waybillNo?: string
  destination: string
  tonnage: number
  freight?: number
  liftingFee?: number
  driver?: string
  licensePlate?: string
}

export type BizRecord = ProcurementRecord | SalesRecord | PaymentRecord | LogisticsRecord

/** Chinese display names for biz types */
export const BIZ_TYPE_LABELS: Record<BizType, string> = {
  procurement: '采购',
  sales: '销售',
  payment: '收付款',
  logistics: '物流',
}

// ── Structured business data types (v0.5 进销存) ──────────────────

/** Product master data */
export interface BizProduct {
  id: string
  tenantId: string
  code: string
  brand: string
  name: string
  spec: string
  specDisplay?: string
  category: string
  measureType: string
  weightPerBundle?: number
  piecesPerBundle?: number
  liftingFee?: number
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** Counterparty (supplier / customer / logistics provider) */
export interface BizCounterparty {
  id: string
  tenantId: string
  name: string
  type: 'supplier' | 'customer' | 'logistics' | 'both'
  contact?: string
  phone?: string
  address?: string
  bankInfo?: string
  taxId?: string
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** Customer project / construction site */
export interface BizProject {
  id: string
  tenantId: string
  name: string
  customerId?: string
  contractNo?: string
  address?: string
  builder?: string
  developer?: string
  contact?: string
  phone?: string
  status: 'active' | 'completed' | 'suspended'
  metadata?: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

/** Purchase record (structured) */
export interface BizPurchase {
  id: string
  tenantId: string
  date: string
  orderNo?: string
  supplierId: string
  productId: string
  bundleCount?: number
  tonnage: number
  unitPrice: number
  totalAmount: number
  projectId?: string
  invoiceStatus: string
  paymentStatus: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/** Sales record (structured) */
export interface BizSale {
  id: string
  tenantId: string
  date: string
  orderNo?: string
  customerId: string
  supplierId?: string
  productId: string
  bundleCount?: number
  tonnage: number
  unitPrice: number
  totalAmount: number
  costPrice?: number
  costAmount?: number
  profit?: number
  projectId?: string
  logisticsProvider?: string
  invoiceStatus: string
  collectionStatus: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/** Logistics record (structured) */
export interface BizLogisticsRecord {
  id: string
  tenantId: string
  date: string
  waybillNo?: string
  carrierId?: string
  projectId?: string
  destination?: string
  tonnage?: number
  freight: number
  liftingFee: number
  totalFee: number
  driver?: string
  driverPhone?: string
  licensePlate?: string
  settlementStatus: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/** Payment record (structured) */
export interface BizPayment {
  id: string
  tenantId: string
  date: string
  docNo?: string
  direction: 'in' | 'out'
  counterpartyId: string
  projectId?: string
  amount: number
  method?: string
  referenceNo?: string
  notes?: string
  bubbleId?: string
  rawInput?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

/** Invoice record (structured) */
export interface BizInvoice {
  id: string
  tenantId: string
  date: string
  direction: 'in' | 'out'
  invoiceNo?: string
  counterpartyId: string
  amount: number
  taxRate: number
  taxAmount?: number
  totalAmount?: number
  relatedIds: string[]
  status: string
  notes?: string
  bubbleId?: string
  createdBy?: string
  createdAt: number
  updatedAt: number
  deletedAt?: number
}

// ── Computed view types ──────────────────────────────────────────

export interface InventoryItem {
  productId: string
  code: string
  brand: string
  name: string
  spec: string
  purchaseTons: number
  salesTons: number
  stockTons: number
}

export interface ReceivableItem {
  customerId: string
  name: string
  totalSales: number
  received: number
  outstanding: number
}

export interface PayableItem {
  supplierId: string
  name: string
  totalPurchases: number
  paid: number
  outstanding: number
}

export interface DashboardData {
  todayPurchases: number
  todaySales: number
  todayLogistics: number
  totalStockTons: number
  totalReceivable: number
  totalPayable: number
  recentTransactions: Array<{
    type: string
    date: string
    counterparty: string
    product?: string
    amount: number
  }>
}

export interface ProjectReconciliationItem {
  projectId: string
  projectName: string
  status: string
  totalSales: number
  totalLogistics: number
  totalPaymentsIn: number
  totalPaymentsOut: number
  outstanding: number
}
