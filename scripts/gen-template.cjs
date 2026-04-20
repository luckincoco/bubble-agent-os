/**
 * Generate clean Excel template for Bubble Agent OS import
 * 
 * Usage: node scripts/gen-template.cjs [source-xlsx-path]
 * Output: ~/Desktop/2026华瑞隆进销存_Bubble导入模板.xlsx
 */

const XLSX = require('xlsx');
const path = require('path');

// Read source file to extract base info
const sourcePath = process.argv[2] || path.join(
  process.env.HOME,
  'Library/Containers/com.kingsoft.wpsoffice.mac/Data/Library/Application Support/Kingsoft/WPS Cloud Files/userdata/qing/filecache/.731578905/cachedata/3975502D3B1045B4A689A2C4482FB37B/2026华瑞隆进销存管理（终版）_1.3.0.xlsx'
);

console.log('Reading source:', sourcePath);
const srcWb = XLSX.readFile(sourcePath, { cellDates: false });

// Helper: read source sheet, filter out empty rows
function readSourceSheet(name) {
  const sheet = srcWb.Sheets[name];
  if (!sheet) return [];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  return rows.filter(r => {
    const vals = Object.values(r).filter(v => v !== '' && v != null);
    return vals.length >= 2;
  });
}

// Fill-down for merged cells: copy key fields from previous row if empty
function fillDown(rows, keys) {
  for (let i = 1; i < rows.length; i++) {
    for (const k of keys) {
      if ((rows[i][k] == null || rows[i][k] === '') && rows[i-1][k] != null && rows[i-1][k] !== '') {
        rows[i][k] = rows[i-1][k];
      }
    }
  }
}

// Convert Excel date serial to YYYY-MM-DD string
function serialToDate(v) {
  if (typeof v === 'number' && v > 40000 && v < 100000) {
    const ms = Date.UTC(1899, 11, 30) + v * 86400000;
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
  }
  return v;
}

// ── Pre-build product weight lookup ──────────────────────────
// Used to compute tonnage from bundle count when formula values are missing
const srcProductsForLookup = readSourceSheet('产品信息');
const productWeightMap = new Map(); // 商品代码 → 件重(吨)
for (const p of srcProductsForLookup) {
  const code = String(p['商品代码'] || '').trim();
  const weight = Number(p['件重(吨)']);
  if (code && weight > 0) productWeightMap.set(code, weight);
}
console.log(`Product weight lookup: ${productWeightMap.size} entries`);

// Compute missing tonnage/amount from 件数*件重 and 吨位*单价
function computeMissing(row) {
  const tons = Number(row['吨位']) || 0;
  const amount = Number(row['金额(元)']) || 0;
  const pieces = Number(row['件数']) || 0;
  const unitPrice = Number(row['单价(元/吨)']) || 0;
  const code = String(row['商品代码'] || '').trim();

  if (tons <= 0 && pieces > 0 && code) {
    const weight = productWeightMap.get(code);
    if (weight) {
      row['吨位'] = Math.round(pieces * weight * 1000) / 1000;
    }
  }
  const newTons = Number(row['吨位']) || 0;
  if (amount <= 0 && newTons > 0 && unitPrice > 0) {
    row['金额(元)'] = Math.round(newTons * unitPrice * 100) / 100;
  }
}

// Same for sales
function computeMissingSales(row) {
  const tons = Number(row['吨位']) || 0;
  const amount = Number(row['销售金额']) || 0;
  const pieces = Number(row['件数']) || 0;
  const unitPrice = Number(row['销售单价']) || 0;
  const code = String(row['商品代码'] || '').trim();

  if (tons <= 0 && pieces > 0 && code) {
    const weight = productWeightMap.get(code);
    if (weight) {
      row['吨位'] = Math.round(pieces * weight * 1000) / 1000;
    }
  }
  const newTons = Number(row['吨位']) || 0;
  if (amount <= 0 && newTons > 0 && unitPrice > 0) {
    row['销售金额'] = Math.round(newTons * unitPrice * 100) / 100;
  }
  // Also compute cost amount and profit if possible
  const costPrice = Number(row['成本价(自动)'] || row['成本价(手动)']) || 0;
  if (costPrice > 0 && newTons > 0) {
    const costAmount = Math.round(newTons * costPrice * 100) / 100;
    row['采购成本'] = costAmount;
    const saleAmt = Number(row['销售金额']) || 0;
    if (saleAmt > 0) {
      row['单笔毛利'] = Math.round((saleAmt - costAmount) * 100) / 100;
    }
  }
}

// ── 1. 采购录入 ─────────────────────────────────────────────
// Bridge expects: 采购日期, 入库单号, 供应商, 品牌, 商品名称, 规格, 件数, 吨位, 单价(元/吨), 金额(元), 发票状态, 付款状态, 关联项目
const purchaseHeaders = ['采购日期', '入库单号', '供应商', '品牌', '商品名称', '规格', '件数', '吨位', '单价(元/吨)', '金额(元)', '发票状态', '付款状态', '关联项目'];

// Extract existing purchase data with fill-down for merged cells
const srcPurchases = readSourceSheet('采购录入');
fillDown(srcPurchases, ['采购日期', '供应商', '关联项目', '付款状态', '入库单号']);
srcPurchases.forEach(computeMissing);
const purchases = srcPurchases
  .filter(r => {
    const tons = Number(r['吨位']);
    const amount = Number(r['金额(元)']);
    const pieces = Number(r['件数']);
    const price = Number(r['单价(元/吨)']);
    const supplier = r['供应商'];
    // Keep if has tonnage/amount, or has meaningful data (supplier + pieces/price)
    return (tons > 0 || amount > 0) || (supplier && (pieces > 0 || price > 0));
  })
  .map(r => {
    const row = {};
    for (const h of purchaseHeaders) {
      let v = r[h];
      if (h === '采购日期') v = serialToDate(v);
      // Clean [object Object]
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v;
    }
    return row;
  });

console.log(`采购录入: ${srcPurchases.length} source rows → ${purchases.length} clean rows`);

// ── 2. 销售录入 ─────────────────────────────────────────────
// Bridge expects: 销售日期, 销售单号, 供应商, 客户/项目, 品牌, 商品名称, 规格, 件数, 吨位, 销售单价, 销售金额, 成本价(手动), 单笔毛利, 物流商
const salesHeaders = ['销售日期', '销售单号', '供应商', '客户/项目', '品牌', '商品名称', '规格', '件数', '吨位', '销售单价', '销售金额', '成本价(手动)', '单笔毛利', '物流商'];

const srcSales = readSourceSheet('销售录入');
fillDown(srcSales, ['销售日期', '供应商', '客户/项目', '销售单号']);
srcSales.forEach(computeMissingSales);
const sales = srcSales
  .filter(r => {
    const tons = Number(r['吨位']);
    const amount = Number(r['销售金额']);
    return tons > 0 || amount > 0;
  })
  .map(r => {
    const row = {};
    for (const h of salesHeaders) {
      let v = r[h];
      if (h === '成本价(手动)') {
        v = r['成本价(手动)'] || r['成本价(自动)'] || '';
      }
      if (h === '销售日期') v = serialToDate(v);
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v;
    }
    return row;
  });

console.log(`销售录入: ${srcSales.length} source rows → ${sales.length} clean rows`);

// ── 3. 物流录入 ─────────────────────────────────────────────
// Bridge expects: 装车日期, 运单号, 托运公司, 目的地/项目, 车牌号, 司机, 吨位, 运费(元), 吊费(元), 费用合计, 结算状态
const logisticsHeaders = ['装车日期', '运单号', '托运公司', '目的地/项目', '车牌号', '司机', '吨位', '运费(元)', '吊费(元)', '费用合计', '结算状态'];

// The source logistics sheet is a dashboard format, not transaction records.
// Create empty sheet with sample row. User needs to enter data manually.
const logisticsSample = [
  { '装车日期': '2026-04-01', '运单号': 'YD-001', '托运公司': '好运虎', '目的地/项目': '汉浦路项目', '车牌号': '鲁RR1525', '司机': '陈允傲', '吨位': 32.5, '运费(元)': 800, '吊费(元)': 400, '费用合计': 1200, '结算状态': '未结' },
];

console.log('物流录入: 源文件为仪表盘格式，已创建正确的交易记录格式（含样例行）');

// ── 4. 收付款记录 ────────────────────────────────────────────
// Bridge expects: 日期, 单据号, 类型, 对象(客户/供应商), 关联项目, 金额(元), 方式, 摘要
const paymentHeaders = ['日期', '单据号', '类型', '对象(客户/供应商)', '关联项目', '金额(元)', '方式', '摘要'];

const srcPayments = readSourceSheet('收付款记录');
fillDown(srcPayments, ['日期', '对象(客户/供应商)', '类型', '关联项目']);
const payments = srcPayments
  .filter(r => {
    const amount = Number(r['金额(元)']);
    const target = r['对象(客户/供应商)'];
    return amount > 0 && target;
  })
  .map(r => {
    const row = {};
    for (const h of paymentHeaders) {
      let v = r[h];
      if (h === '日期') v = serialToDate(v);
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v;
    }
    return row;
  });

console.log(`收付款记录: ${srcPayments.length} source rows → ${payments.length} clean rows`);

// ── 5. 产品信息 ─────────────────────────────────────────────
const productHeaders = ['商品代码', '品牌', '商品名称', '规格', '规格(调整格式)', '计量方式', '件重(吨)', '支数', '吊费(元/吨)', '类型'];

const srcProducts = readSourceSheet('产品信息');
const products = srcProducts
  .filter(r => r['商品代码'] || r['品牌'])
  .map(r => {
    const row = {};
    for (const h of productHeaders) {
      let v = r[h];
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v !== undefined ? v : '';
    }
    return row;
  });

console.log(`产品信息: ${products.length} rows`);

// ── 6. 供应商信息 ────────────────────────────────────────────
const supplierHeaders = ['供应商名称', '经销品牌', '提货地址', '联系人', '联系电话'];

const srcSuppliers = readSourceSheet('供应商信息');
const suppliers = srcSuppliers
  .filter(r => r['供应商名称'])
  .map(r => {
    const row = {};
    for (const h of supplierHeaders) {
      let v = r[h];
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v !== undefined ? v : '';
    }
    return row;
  });

console.log(`供应商信息: ${suppliers.length} rows`);

// ── 7. 客户与项目 ────────────────────────────────────────────
const customerHeaders = ['项目名称', '合同编号', '工程地址', '施工单位', '建设单位', '联系人', '电话', '项目状态'];

const srcCustomers = readSourceSheet('客户与项目');
const customers = srcCustomers
  .filter(r => r['项目名称'])
  .map(r => {
    const row = {};
    for (const h of customerHeaders) {
      let v = r[h];
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v !== undefined ? v : '';
    }
    return row;
  });

console.log(`客户与项目: ${customers.length} rows`);

// ── 8. 物流基础信息 ──────────────────────────────────────────
const logInfoHeaders = ['托运公司', '常送目的地', '车牌号', '司机', '司机电话'];

const srcLogInfo = readSourceSheet('物流基础信息');
const logInfo = srcLogInfo
  .filter(r => r['托运公司'])
  .map(r => {
    const row = {};
    for (const h of logInfoHeaders) {
      let v = r[h];
      if (typeof v === 'object' && v !== null) v = '';
      row[h] = v !== undefined ? v : '';
    }
    return row;
  });

console.log(`物流基础信息: ${logInfo.length} rows`);

// ── Build output workbook ────────────────────────────────────

const wb = XLSX.utils.book_new();

function addSheet(name, data, headers) {
  if (data.length === 0) {
    // Create empty sheet with headers
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    // Set column widths
    ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length * 2, 12) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  } else {
    const ws = XLSX.utils.json_to_sheet(data, { header: headers });
    ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length * 2, 14) }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
}

// Transaction sheets
addSheet('采购录入', purchases, purchaseHeaders);
addSheet('销售录入', sales, salesHeaders);
addSheet('物流录入', logisticsSample, logisticsHeaders);
addSheet('收付款记录', payments, paymentHeaders);

// Base info sheets (pre-populated)
addSheet('产品信息', products, productHeaders);
addSheet('供应商信息', suppliers, supplierHeaders);
addSheet('客户与项目', customers, customerHeaders);
addSheet('物流基础信息', logInfo, logInfoHeaders);

// Write output
const outPath = path.join(process.env.HOME, 'Desktop', '2026华瑞隆进销存_Bubble导入模板.xlsx');
XLSX.writeFile(wb, outPath);
console.log(`\nTemplate saved to: ${outPath}`);
console.log('\nSheet summary:');
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = XLSX.utils.sheet_to_json(ws);
  console.log(`  ${name}: ${rows.length} rows`);
}
