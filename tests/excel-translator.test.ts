/**
 * Excel Translator Tests
 *
 * Validates the semantic translation layer that converts raw Excel rows
 * into LLM-friendly natural language and knowledge cards.
 */
import { describe, it, expect } from 'vitest'
import {
  excelDateToISO,
  detectSheetCategory,
  normalizeSpec,
  translatePurchaseRow,
  translateSalesRow,
  translateLogisticsRow,
  translatePaymentRow,
  translateGenericRow,
  translateRow,
  generateSupplierCard,
  generateCustomerCard,
  generateProductCard,
  generateLogisticsInfoCard,
  generateKnowledgeCards,
  computePurchaseAggregations,
  computeSalesAggregations,
  isBaseInfoSheet,
  isTransactionSheet,
  isTranslatableSheet,
} from '../src/connector/tools/excel-translator.js'

// ========== excelDateToISO ==========
describe('excelDateToISO', () => {
  it('converts Excel serial 46087 to 2026-03-05', () => {
    expect(excelDateToISO(46087)).toBe('2026-03-05')
  })

  it('converts serial 45658 to 2024-12-31', () => {
    expect(excelDateToISO(45658)).toBe('2024-12-31')
  })

  it('passes through ISO date strings', () => {
    expect(excelDateToISO('2026-03-05')).toBe('2026-03-05')
  })

  it('converts slash dates to dash format', () => {
    expect(excelDateToISO('2026/03/05')).toBe('2026-03-05')
  })

  it('handles string-encoded serial numbers', () => {
    expect(excelDateToISO('46087')).toBe('2026-03-05')
  })

  it('returns original string for non-date values', () => {
    expect(excelDateToISO('not-a-date')).toBe('not-a-date')
  })

  it('returns string for out-of-range serials', () => {
    expect(excelDateToISO(0)).toBe('0')
    expect(excelDateToISO(200000)).toBe('200000')
  })
})

// ========== detectSheetCategory ==========
describe('detectSheetCategory', () => {
  it('detects purchase sheets', () => {
    expect(detectSheetCategory('采购录入')).toBe('purchase')
    expect(detectSheetCategory('采购记录')).toBe('purchase')
    expect(detectSheetCategory('采购明细')).toBe('purchase')
  })

  it('detects sales sheets', () => {
    expect(detectSheetCategory('销售录入')).toBe('sales')
    expect(detectSheetCategory('销售记录')).toBe('sales')
  })

  it('detects logistics sheets', () => {
    expect(detectSheetCategory('物流录入')).toBe('logistics')
    expect(detectSheetCategory('物流记录')).toBe('logistics')
  })

  it('detects payment sheets', () => {
    expect(detectSheetCategory('收付款')).toBe('payment')
    expect(detectSheetCategory('付款记录')).toBe('payment')
  })

  it('detects inventory sheets', () => {
    expect(detectSheetCategory('库存动态')).toBe('inventory')
    expect(detectSheetCategory('库存表')).toBe('inventory')
  })

  it('detects receivable/payable sheets', () => {
    expect(detectSheetCategory('应收账款')).toBe('receivable')
    expect(detectSheetCategory('应付账款')).toBe('payable')
  })

  it('detects base-info sheets', () => {
    expect(detectSheetCategory('产品信息')).toBe('product_info')
    expect(detectSheetCategory('供应商信息')).toBe('supplier_info')
    expect(detectSheetCategory('客户与项目')).toBe('customer_info')
    expect(detectSheetCategory('物流基础')).toBe('logistics_info')
  })

  it('detects summary and dashboard sheets', () => {
    expect(detectSheetCategory('年度汇总')).toBe('summary')
    expect(detectSheetCategory('利润分析')).toBe('summary')
    expect(detectSheetCategory('经营仪表')).toBe('dashboard')
  })

  it('returns unknown for unrecognized sheets', () => {
    expect(detectSheetCategory('自定义表')).toBe('unknown')
    expect(detectSheetCategory('使用说明')).toBe('unknown')
  })
})

// ========== normalizeSpec ==========
describe('normalizeSpec', () => {
  it('normalizes "25*12" to "Φ25×12m"', () => {
    expect(normalizeSpec('25*12')).toBe('Φ25×12m')
  })

  it('normalizes "25×9" to "Φ25×9m"', () => {
    expect(normalizeSpec('25×9')).toBe('Φ25×9m')
  })

  it('normalizes "25x12" with lowercase x', () => {
    expect(normalizeSpec('25x12')).toBe('Φ25×12m')
  })

  it('normalizes "6mm" to "Φ6"', () => {
    expect(normalizeSpec('6mm')).toBe('Φ6')
  })

  it('normalizes "8MM" case insensitively', () => {
    expect(normalizeSpec('8MM')).toBe('Φ8')
  })

  it('passes through already-formatted specs', () => {
    expect(normalizeSpec('Φ25×12m')).toBe('Φ25×12m')
  })

  it('handles empty/null input gracefully', () => {
    expect(normalizeSpec('')).toBe('')
  })

  it('handles specs with spaces', () => {
    expect(normalizeSpec('25 * 12')).toBe('Φ25×12m')
  })
})

// ========== translatePurchaseRow ==========
describe('translatePurchaseRow', () => {
  const fullRow = {
    '采购日期': 46087,
    '入库单号': 'RK-2026-001',
    '供应商': '供应商A',
    '品牌': '品牌A',
    '商品名称': '螺纹钢',
    '规格': '25*12',
    '件数': 10,
    '吨位': 23.5,
    '单价(元/吨)': 3650,
    '金额(元)': 85775,
    '付款状态': '已付',
    '关联项目': '示例项目A',
    '发票状态': '已开票',
  }

  it('translates a full purchase row with all fields', () => {
    const result = translatePurchaseRow(fullRow)
    expect(result.content).toContain('2026-03-05')
    expect(result.content).toContain('示例公司通过供应商A采购品牌A牌螺纹钢')
    expect(result.content).toContain('规格Φ25×12m')
    expect(result.content).toContain('入库单号RK-2026-001')
    expect(result.content).toContain('共10件23.5吨')
    expect(result.content).toContain('单价3650元/吨')
    expect(result.content).toContain('金额85775元')
    expect(result.content).toContain('货款已付')
    expect(result.content).toContain('该批材料供示例项目A使用')
  })

  it('generates correct tags', () => {
    const result = translatePurchaseRow(fullRow)
    expect(result.tags).toContain('采购')
    expect(result.tags).toContain('供应商A')
    expect(result.tags).toContain('品牌A')
    expect(result.tags).toContain('螺纹钢')
    expect(result.tags).toContain('25*12')
    expect(result.tags).toContain('示例项目A')
  })

  it('generates meaningful title', () => {
    const result = translatePurchaseRow(fullRow)
    expect(result.title).toContain('采购')
    expect(result.title).toContain('供应商A')
    expect(result.title).toContain('Φ25×12m')
    expect(result.title).toContain('23.5吨')
  })

  it('handles minimal row with missing fields', () => {
    const minRow = { '供应商': '供应商B', '商品名称': '线材', '吨位': 5 }
    const result = translatePurchaseRow(minRow)
    expect(result.content).toContain('供应商B')
    expect(result.content).toContain('线材')
    expect(result.content).toContain('5吨')
    expect(result.content).not.toContain('undefined')
    expect(result.content).not.toContain('NaN')
  })

  it('handles empty row without crashing', () => {
    const result = translatePurchaseRow({})
    expect(result.content).toContain('(未知供应商)')
    expect(result.tags).toContain('采购')
  })

  it('handles custom company name', () => {
    const result = translatePurchaseRow(fullRow, '测试公司')
    expect(result.content).toContain('测试公司通过供应商A采购')
  })

  it('handles unpaid status', () => {
    const row = { ...fullRow, '付款状态': '未付' }
    const result = translatePurchaseRow(row)
    expect(result.content).toContain('付款状态：未付')
  })
})

// ========== translateSalesRow ==========
describe('translateSalesRow', () => {
  const fullRow = {
    '销售日期': 46090,
    '销售单号': 'XS-2026-088',
    '供应商': '供应商A',
    '客户/项目': '示例项目A',
    '品牌': '品牌A',
    '商品名称': '螺纹钢',
    '规格': '25*12',
    '件数': 5,
    '吨位': 11.75,
    '销售单价': 3780,
    '销售金额': 44415,
    '成本价(自动)': 3650,
    '单笔毛利': 1527.5,
    '物流商': '顺达物流',
  }

  it('translates a full sales row', () => {
    const result = translateSalesRow(fullRow)
    expect(result.content).toContain('示例公司向示例项目A销售品牌A牌螺纹钢')
    expect(result.content).toContain('规格Φ25×12m')
    expect(result.content).toContain('共5件11.75吨')
    expect(result.content).toContain('售价3780元/吨')
    expect(result.content).toContain('销售额44415元')
    expect(result.content).toContain('成本3650元/吨')
    expect(result.content).toContain('单笔毛利1527.5元')
    expect(result.content).toContain('货源来自供应商A')
    expect(result.content).toContain('物流由顺达物流承运')
  })

  it('rounds floating point correctly', () => {
    const row = { ...fullRow, '单笔毛利': 817.200000000001 }
    const result = translateSalesRow(row)
    expect(result.content).toContain('单笔毛利817.2元')
    expect(result.content).not.toContain('817.200000000001')
  })

  it('handles negative profit', () => {
    const row = { ...fullRow, '单笔毛利': -200 }
    const result = translateSalesRow(row)
    expect(result.content).toContain('单笔毛利-200元')
  })

  it('generates correct tags for sales', () => {
    const result = translateSalesRow(fullRow)
    expect(result.tags).toContain('销售')
    expect(result.tags).toContain('示例项目A')
    expect(result.tags).toContain('供应商A')
    expect(result.tags).toContain('品牌A')
  })

  it('handles minimal row', () => {
    const result = translateSalesRow({ '客户/项目': '示例项目C' })
    expect(result.content).toContain('示例项目C')
    expect(result.content).not.toContain('undefined')
  })
})

// ========== translateLogisticsRow ==========
describe('translateLogisticsRow', () => {
  const fullRow = {
    '装车日期': 46090,
    '运单号': 'YD-2026-005',
    '托运公司': '物流公司A',
    '目的地/项目': '示例项目A',
    '车牌号': '沪A12345',
    '司机': '张三',
    '吨位': 30,
    '运费(元)': 2400,
    '吊费(元)': 600,
    '费用合计': 3000,
    '结算状态': '已结',
  }

  it('translates a full logistics row', () => {
    const result = translateLogisticsRow(fullRow)
    expect(result.content).toContain('物流公司A承运货物至示例项目A')
    expect(result.content).toContain('运单号YD-2026-005')
    expect(result.content).toContain('30吨')
    expect(result.content).toContain('司机张三')
    expect(result.content).toContain('沪A12345')
    expect(result.content).toContain('运费2400元')
    expect(result.content).toContain('吊费600元')
    expect(result.content).toContain('合计3000元')
    expect(result.content).toContain('已结')
  })

  it('handles minimal logistics row', () => {
    const result = translateLogisticsRow({})
    expect(result.content).toContain('(未知物流)')
    expect(result.content).toContain('(未知目的地)')
    expect(result.content).not.toContain('undefined')
  })

  it('generates correct tags', () => {
    const result = translateLogisticsRow(fullRow)
    expect(result.tags).toContain('物流')
    expect(result.tags).toContain('物流公司A')
    expect(result.tags).toContain('示例项目A')
    expect(result.tags).toContain('张三')
  })
})

// ========== translatePaymentRow ==========
describe('translatePaymentRow', () => {
  it('translates a payment (付款) row', () => {
    const row = {
      '日期': 46087,
      '单据号': 'FK-001',
      '类型': '付款',
      '对象(客户/供应商)': '供应商A',
      '关联项目': '',
      '金额(元)': 500000,
      '方式': '银行转账',
      '摘要': '2月采购货款',
    }
    const result = translatePaymentRow(row)
    expect(result.content).toContain('示例公司向供应商A付款500000元')
    expect(result.content).toContain('银行转账')
    expect(result.content).toContain('摘要：2月采购货款')
    expect(result.tags).toContain('付款')
    expect(result.tags).toContain('供应商A')
  })

  it('translates a receipt (收款) row', () => {
    const row = {
      '日期': 46090,
      '类型': '收款',
      '对象(客户/供应商)': '示例项目A',
      '关联项目': '示例项目A',
      '金额(元)': 200000,
      '方式': '承兑汇票',
    }
    const result = translatePaymentRow(row)
    expect(result.content).toContain('示例公司收到示例项目A回款200000元')
    expect(result.content).toContain('承兑汇票')
    expect(result.tags).toContain('收款')
    expect(result.tags).toContain('示例项目A')
  })

  it('handles empty row', () => {
    const result = translatePaymentRow({})
    expect(result.content).toContain('(未知对象)')
    expect(result.content).not.toContain('undefined')
  })
})

// ========== translateGenericRow ==========
describe('translateGenericRow', () => {
  it('creates key: value content for unknown sheet types', () => {
    const row = { '列A': '值1', '列B': 123, '列C': '' }
    const result = translateGenericRow(row, '自定义表')
    expect(result.content).toContain('列A: 值1')
    expect(result.content).toContain('列B: 123')
    expect(result.content).not.toContain('列C')  // Empty values excluded
    expect(result.tags).toEqual(['自定义表'])
  })

  it('converts date serials in date-named columns', () => {
    const row = { '入库日期': 46087, '数量': 10 }
    const result = translateGenericRow(row, '库存表')
    expect(result.content).toContain('入库日期: 2026-03-05')
  })
})

// ========== translateRow dispatcher ==========
describe('translateRow', () => {
  it('dispatches to purchase translator', () => {
    const row = { '供应商': '供应商A', '吨位': 10 }
    const result = translateRow(row, '采购录入', 'purchase')
    expect(result.content).toContain('供应商A')
    expect(result.metadata._sheetType).toBe('purchase')
  })

  it('dispatches to sales translator', () => {
    const row = { '客户/项目': '示例项目A' }
    const result = translateRow(row, '销售录入', 'sales')
    expect(result.content).toContain('示例项目A')
    expect(result.metadata._sheetType).toBe('sales')
  })

  it('dispatches to logistics translator', () => {
    const row = { '托运公司': '物流公司A' }
    const result = translateRow(row, '物流录入', 'logistics')
    expect(result.content).toContain('物流公司A')
    expect(result.metadata._sheetType).toBe('logistics')
  })

  it('dispatches to payment translator', () => {
    const row = { '类型': '付款', '对象(客户/供应商)': '供应商A', '金额(元)': 10000 }
    const result = translateRow(row, '收付款', 'payment')
    expect(result.content).toContain('供应商A')
    expect(result.metadata._sheetType).toBe('payment')
  })

  it('falls back to generic for unknown types', () => {
    const row = { '列A': '值1' }
    const result = translateRow(row, '自定义表', 'unknown')
    expect(result.metadata._sheetType).toBe('generic')
  })
})

// ========== Knowledge Card Generation ==========
describe('generateSupplierCard', () => {
  it('generates supplier card with full info', () => {
    const row = {
      '供应商名称': '供应商A',
      '经销品牌': '品牌A',
      '提货地址': '吴淞江仓库',
      '联系人': '李总',
      '联系电话': '138-0000-0001',
      '已付金额': 2136000,
      '未付余款': 50000,
    }
    const card = generateSupplierCard(row)
    expect(card).not.toBeNull()
    expect(card!.title).toBe('供应商: 供应商A')
    expect(card!.content).toContain('供应商A是示例公司的钢材供应商')
    expect(card!.content).toContain('经销品牌A品牌')
    expect(card!.content).toContain('提货地点在吴淞江仓库')
    expect(card!.content).toContain('联系人李总')
    expect(card!.content).toContain('138-0000-0001')
    expect(card!.content).toContain('累计已付金额213.6万元')
    expect(card!.content).toContain('尚欠5.0万元')
    expect(card!.pinned).toBe(true)
    expect(card!.abstractionLevel).toBe(1)
    expect(card!.tags).toContain('供应商')
    expect(card!.tags).toContain('供应商A')
    expect(card!.tags).toContain('品牌A')
  })

  it('handles supplier with multiple brands', () => {
    const row = { '供应商名称': '供应商C', '经销品牌': '品牌A、品牌B' }
    const card = generateSupplierCard(row)
    expect(card!.tags).toContain('品牌A')
    expect(card!.tags).toContain('品牌B')
  })

  it('detects overpayment', () => {
    const row = { '供应商名称': '测试', '已付金额': 100000, '未付余款': -5000 }
    const card = generateSupplierCard(row)
    expect(card!.content).toContain('超付0.5万元')
  })

  it('detects settled payments', () => {
    const row = { '供应商名称': '测试', '已付金额': 100000, '未付余款': 0 }
    const card = generateSupplierCard(row)
    expect(card!.content).toContain('货款基本结清')
  })

  it('returns null for empty row', () => {
    expect(generateSupplierCard({})).toBeNull()
  })
})

describe('generateCustomerCard', () => {
  it('generates customer/project card with full info', () => {
    const row = {
      '项目名称': '示例项目A',
      '合同编号': 'HT-2026-001',
      '工程地址': '示例市示例区示例路',
      '施工单位': '万路建设',
      '建设单位': '嘉定城投',
      '联系人': '王工',
      '电话': '139-0000-0002',
      '项目状态': '在建',
      '累计销售额': 3640000,
      '已回款': 2000000,
      '未回款余额': 1640000,
    }
    const card = generateCustomerCard(row)
    expect(card).not.toBeNull()
    expect(card!.title).toBe('项目: 示例项目A')
    expect(card!.content).toContain('示例项目A是示例公司的销售项目')
    expect(card!.content).toContain('当前状态：在建')
    expect(card!.content).toContain('示例市示例区示例路')
    expect(card!.content).toContain('施工单位：万路建设')
    expect(card!.content).toContain('建设单位：嘉定城投')
    expect(card!.content).toContain('联系人王工')
    expect(card!.content).toContain('累计销售额364.0万元')
    expect(card!.content).toContain('未回款164.0万元')
    expect(card!.content).toContain('已回款200.0万元')
    expect(card!.pinned).toBe(true)
    expect(card!.tags).toContain('项目')
    expect(card!.tags).toContain('示例项目A')
    expect(card!.tags).toContain('万路建设')
  })

  it('returns null for missing project name', () => {
    expect(generateCustomerCard({})).toBeNull()
  })
})

describe('generateProductCard', () => {
  it('generates product card with full info', () => {
    const row = {
      '商品代码': 'GX-LW-25-12',
      '品牌': '品牌A',
      '商品名称': '螺纹钢',
      '规格': '25*12',
      '规格(调整格式)': 'Φ25×12m',
      '计量方式': '过磅',
      '件重(吨)': 2.35,
      '支数': 4,
      '吊费(元/吨)': 30,
      '类型': '热轧',
    }
    const card = generateProductCard(row)
    expect(card).not.toBeNull()
    expect(card!.content).toContain('品牌A螺纹钢 Φ25×12m')
    expect(card!.content).toContain('热轧')
    expect(card!.content).toContain('商品代码GX-LW-25-12')
    expect(card!.content).toContain('过磅计量')
    expect(card!.content).toContain('每件约2.35吨')
    expect(card!.content).toContain('4支/件')
    expect(card!.content).toContain('吊费标准30元/吨')
    expect(card!.pinned).toBe(false) // Products are not pinned
    expect(card!.tags).toContain('产品')
    expect(card!.tags).toContain('品牌A')
  })

  it('returns null for empty row', () => {
    expect(generateProductCard({})).toBeNull()
  })
})

describe('generateLogisticsInfoCard', () => {
  it('generates logistics info card', () => {
    const row = {
      '托运公司': '物流公司A',
      '常送目的地': '示例项目A',
      '车牌号': '沪A12345',
      '司机': '张三',
      '司机电话': '137-0000-0003',
    }
    const card = generateLogisticsInfoCard(row)
    expect(card).not.toBeNull()
    expect(card!.title).toBe('物流: 物流公司A')
    expect(card!.content).toContain('物流公司A是示例公司使用的物流运输方')
    expect(card!.content).toContain('常送目的地：示例项目A')
    expect(card!.content).toContain('司机张三')
    expect(card!.content).toContain('137-0000-0003')
    expect(card!.content).toContain('车牌沪A12345')
    expect(card!.pinned).toBe(true)
    expect(card!.tags).toContain('物流')
    expect(card!.tags).toContain('物流公司A')
  })

  it('handles card with only plate (no driver)', () => {
    const row = { '托运公司': '运达', '车牌号': '苏B99999' }
    const card = generateLogisticsInfoCard(row)
    expect(card!.content).toContain('车牌苏B99999')
  })

  it('returns null for empty row', () => {
    expect(generateLogisticsInfoCard({})).toBeNull()
  })
})

describe('generateKnowledgeCards', () => {
  it('generates multiple supplier cards', () => {
    const rows = [
      { '供应商名称': '供应商A', '经销品牌': '品牌A' },
      { '供应商名称': '供应商B', '经销品牌': '品牌B' },
      {},  // Should be skipped
    ]
    const cards = generateKnowledgeCards(rows, 'supplier_info')
    expect(cards).toHaveLength(2)
    expect(cards[0].title).toBe('供应商: 供应商A')
    expect(cards[1].title).toBe('供应商: 供应商B')
  })

  it('generates customer cards', () => {
    const rows = [{ '项目名称': '示例项目C' }]
    const cards = generateKnowledgeCards(rows, 'customer_info')
    expect(cards).toHaveLength(1)
    expect(cards[0].title).toBe('项目: 示例项目C')
  })
})

// ========== Pre-computed Aggregations ==========
describe('computePurchaseAggregations', () => {
  const purchaseRows = [
    { '供应商': '供应商A', '关联项目': '示例项目A', '吨位': 23.5, '金额(元)': 85775, '规格': '25*12' },
    { '供应商': '供应商A', '关联项目': '示例项目A', '吨位': 15.0, '金额(元)': 54750, '规格': '22*12' },
    { '供应商': '供应商A', '关联项目': '示例项目C', '吨位': 10.0, '金额(元)': 36500, '规格': '25*12' },
    { '供应商': '供应商B', '关联项目': '示例项目A', '吨位': 20.0, '金额(元)': 73000, '规格': '25*9' },
    { '供应商': '供应商B', '关联项目': '示例项目C', '吨位': 8.0, '金额(元)': 29200, '规格': '6mm' },
  ]

  it('aggregates by supplier', () => {
    const results = computePurchaseAggregations(purchaseRows)
    const matai = results.find(r => r.title === '采购汇总: 供应商A')
    expect(matai).toBeDefined()
    expect(matai!.content).toContain('3笔')
    expect(matai!.content).toContain('48.5吨')
    expect(matai!.content).toContain('177025元')
    expect(matai!.abstractionLevel).toBe(1)
    expect(matai!.tags).toContain('采购汇总')
    expect(matai!.tags).toContain('供应商A')

    const bny = results.find(r => r.title === '采购汇总: 供应商B')
    expect(bny).toBeDefined()
    expect(bny!.content).toContain('2笔')
    expect(bny!.content).toContain('28.0吨')
  })

  it('aggregates by project', () => {
    const results = computePurchaseAggregations(purchaseRows)
    const hanpu = results.find(r => r.title === '项目采购汇总: 示例项目A')
    expect(hanpu).toBeDefined()
    expect(hanpu!.content).toContain('3笔')
    expect(hanpu!.content).toContain('58.5吨')
    expect(hanpu!.content).toContain('供应商：供应商A、供应商B')
  })

  it('returns empty for empty input', () => {
    expect(computePurchaseAggregations([])).toHaveLength(0)
  })
})

describe('computeSalesAggregations', () => {
  const salesRows = [
    { '客户/项目': '示例项目A', '吨位': 11.75, '销售金额': 44415, '单笔毛利': 1527.5 },
    { '客户/项目': '示例项目A', '吨位': 8.0, '销售金额': 30240, '单笔毛利': 1040 },
    { '客户/项目': '示例项目C', '吨位': 5.0, '销售金额': 18900, '单笔毛利': 650 },
  ]

  it('aggregates by customer/project', () => {
    const results = computeSalesAggregations(salesRows)
    const hanpu = results.find(r => r.title === '销售汇总: 示例项目A')
    expect(hanpu).toBeDefined()
    expect(hanpu!.content).toContain('2笔')
    expect(hanpu!.content).toContain('19.8吨')
    expect(hanpu!.content).toContain('74655元')
    expect(hanpu!.content).toContain('毛利2568元')
    expect(hanpu!.content).toContain('毛利率')
  })

  it('returns empty for empty input', () => {
    expect(computeSalesAggregations([])).toHaveLength(0)
  })
})

// ========== Helper functions ==========
describe('category helpers', () => {
  it('isBaseInfoSheet', () => {
    expect(isBaseInfoSheet('supplier_info')).toBe(true)
    expect(isBaseInfoSheet('customer_info')).toBe(true)
    expect(isBaseInfoSheet('product_info')).toBe(true)
    expect(isBaseInfoSheet('logistics_info')).toBe(true)
    expect(isBaseInfoSheet('purchase')).toBe(false)
    expect(isBaseInfoSheet('unknown')).toBe(false)
  })

  it('isTransactionSheet', () => {
    expect(isTransactionSheet('purchase')).toBe(true)
    expect(isTransactionSheet('sales')).toBe(true)
    expect(isTransactionSheet('logistics')).toBe(false)
    expect(isTransactionSheet('payment')).toBe(false)
  })

  it('isTranslatableSheet', () => {
    expect(isTranslatableSheet('purchase')).toBe(true)
    expect(isTranslatableSheet('sales')).toBe(true)
    expect(isTranslatableSheet('logistics')).toBe(true)
    expect(isTranslatableSheet('payment')).toBe(true)
    expect(isTranslatableSheet('inventory')).toBe(false)
    expect(isTranslatableSheet('unknown')).toBe(false)
  })
})

// ========== Edge cases and robustness ==========
describe('edge cases', () => {
  it('handles rows with null values', () => {
    const row = { '供应商': null, '吨位': null, '金额(元)': undefined }
    const result = translatePurchaseRow(row as any)
    expect(result.content).not.toContain('null')
    expect(result.content).not.toContain('undefined')
    expect(result.content).not.toContain('NaN')
  })

  it('handles rows with numeric strings', () => {
    const row = { '供应商': '供应商A', '吨位': '23.5', '单价(元/吨)': '3650' }
    const result = translatePurchaseRow(row)
    expect(result.content).toContain('23.5吨')
    expect(result.content).toContain('单价3650元/吨')
  })

  it('deduplicates tags', () => {
    // If supplier and brand are the same
    const row = { '供应商': '品牌A', '品牌': '品牌A', '商品名称': '螺纹钢' }
    const result = translatePurchaseRow(row)
    const guixin = result.tags.filter(t => t === '品牌A')
    expect(guixin).toHaveLength(1) // No duplicates
  })

  it('handles very large amounts', () => {
    const row = {
      '供应商名称': '大供应商',
      '经销品牌': '品牌A',
      '已付金额': 15000000,
      '未付余款': 2000000,
    }
    const card = generateSupplierCard(row)
    expect(card!.content).toContain('1500.0万元')
    expect(card!.content).toContain('尚欠200.0万元')
  })
})
