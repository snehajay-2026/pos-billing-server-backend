// server/db/queries/reports.js
//
// Computes the three report shapes the frontend expects:
//   - sales  : totals + daily buckets + byType + byPayment
//   - gst    : B2C invoices + HSN summary (for the GST return)
//   - pnl    : revenue - expenses + COGS estimate
//
// All three filter by date range + scope (storeType/storeId).
//
// Scope filtering uses invoices._store_type / _store_id (and expenses.\_
// store_type / _store_id) — the same convention as the rest of the app.
// SUPER_OWNER passes through with null fields → sees everything.
//
// Math note: totals come straight from SQL aggregates. Sub-totals
// (sub_total / gst_total / grand_total) are stored on each invoice row
// at checkout time — no recomputation needed.

const { query } = require("../pool");

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Build the WHERE clause + params shared by all three reports.
// Filters: from (YYYY-MM-DD), to (YYYY-MM-DD), storeType, storeId.
const buildScopeWhere = (filters, tableAlias = "") => {
  const alias = tableAlias ? `${tableAlias}.` : "";
  const conds = [];
  const params = [];
  if (filters.from) {
    conds.push(`${alias}\`date\` >= ?`);
    params.push(String(filters.from));
  }
  if (filters.to) {
    conds.push(`${alias}\`date\` <= ?`);
    params.push(String(filters.to));
  }
  if (filters.storeType) {
    conds.push(`${alias}_store_type = ?`);
    params.push(String(filters.storeType));
  }
  if (filters.storeId) {
    conds.push(`${alias}_store_id = ?`);
    params.push(String(filters.storeId));
  }
  return {
    sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
};

// === Sales report ===========================================================

const salesReport = async (filters = {}) => {
  const where = buildScopeWhere(filters);

  // Aggregate totals.
  const totalsRows = await query(
    `SELECT
       COUNT(*) AS invoice_count,
       COALESCE(SUM(sub_total), 0) AS revenue_subtotal,
       COALESCE(SUM(gst_total), 0) AS gst_collected,
       COALESCE(SUM(grand_total), 0) AS grand_total,
       COALESCE(SUM(discount), 0) AS discount_total
     FROM invoices ${where.sql}`,
    where.params
  );
  const t = totalsRows[0][0] || {};

  // Daily buckets.
  const bucketRows = await query(
    `SELECT DATE_FORMAT(\`date\`, '%Y-%m-%d') AS day,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(grand_total), 0) AS revenue,
            COALESCE(SUM(gst_total), 0) AS gst
     FROM invoices ${where.sql}
     GROUP BY day
     ORDER BY day ASC`,
    where.params
  );

  // By store type (vertical).
  const typeRows = await query(
    `SELECT _store_type AS store_type,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(grand_total), 0) AS revenue
     FROM invoices ${where.sql}
     GROUP BY _store_type
     ORDER BY revenue DESC`,
    where.params
  );

  // By payment mode.
  const paymentRows = await query(
    `SELECT COALESCE(payment_mode, 'unknown') AS payment_mode,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(grand_total), 0) AS revenue
     FROM invoices ${where.sql}
     GROUP BY payment_mode
     ORDER BY revenue DESC`,
    where.params
  );

  return {
    from: filters.from || null,
    to: filters.to || null,
    scope: { storeType: filters.storeType || null, storeId: filters.storeId || null },
    totals: {
      invoiceCount: Number(t.invoice_count) || 0,
      revenueSubtotal: toNumber(t.revenue_subtotal) ?? 0,
      gstCollected: toNumber(t.gst_collected) ?? 0,
      grandTotal: toNumber(t.grand_total) ?? 0,
      discountTotal: toNumber(t.discount_total) ?? 0,
    },
    buckets: bucketRows[0].map((r) => ({
      day: r.day,
      invoiceCount: Number(r.invoice_count) || 0,
      revenue: toNumber(r.revenue) ?? 0,
      gst: toNumber(r.gst) ?? 0,
    })),
    byType: typeRows[0].map((r) => ({
      storeType: r.store_type || null,
      invoiceCount: Number(r.invoice_count) || 0,
      revenue: toNumber(r.revenue) ?? 0,
    })),
    byPayment: paymentRows[0].map((r) => ({
      paymentMode: r.payment_mode,
      invoiceCount: Number(r.invoice_count) || 0,
      revenue: toNumber(r.revenue) ?? 0,
    })),
  };
};

// === GST report =============================================================
//
// Simplified B2C + HSN shape matching what the frontend renders. A real
// GST return needs more (B2B, advances, amendments) — out of scope here.

const gstReport = async (filters = {}) => {
  const where = buildScopeWhere(filters);

  // B2C: invoices under 2.5L aggregate (simplification — real B2C vs B2B
  // detection requires a per-customer aggregate per FY).
  const b2cRows = await query(
    `SELECT DATE_FORMAT(\`date\`, '%Y-%m-%d') AS day,
            COALESCE(SUM(sub_total), 0) AS taxable,
            COALESCE(SUM(gst_total), 0) AS tax
     FROM invoices ${where.sql}
     GROUP BY day
     ORDER BY day ASC`,
    where.params
  );

  // HSN summary pulled from JSON items (best-effort; not all items carry
  // hsn code). Frontend treats missing HSN as "—".
  const itemsRows = await query(
    `SELECT items, gst_total, sub_total, grand_total
     FROM invoices ${where.sql}`,
    where.params
  );

  const hsnMap = new Map(); // hsn -> {taxable, tax, count}
  for (const row of itemsRows[0]) {
    let items = row.items;
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items)) continue;
    const lineTaxable = toNumber(row.sub_total) || 0;
    const lineTax = toNumber(row.gst_total) || 0;
    const itemCount = items.length || 1;
    // Distribute invoice totals across items proportionally to their line totals.
    let itemTotal = 0;
    for (const it of items) itemTotal += Number(it?.total ?? it?.price ?? 0) || 0;
    for (const it of items) {
      const hsn = String(it?.hsn || it?.HSN || "").trim() || "—";
      const share = itemTotal > 0
        ? (Number(it?.total ?? it?.price ?? 0) || 0) / itemTotal
        : 1 / itemCount;
      const taxable = lineTaxable * share;
      const tax = lineTax * share;
      const cur = hsnMap.get(hsn) || { hsn, taxable: 0, tax: 0, count: 0 };
      cur.taxable += taxable;
      cur.tax += tax;
      cur.count += 1;
      hsnMap.set(hsn, cur);
    }
  }

  const totalsRows = await query(
    `SELECT
       COUNT(*) AS invoice_count,
       COALESCE(SUM(sub_total), 0) AS taxable,
       COALESCE(SUM(gst_total), 0) AS tax
     FROM invoices ${where.sql}`,
    where.params
  );
  const t = totalsRows[0][0] || {};

  return {
    from: filters.from || null,
    to: filters.to || null,
    scope: { storeType: filters.storeType || null, storeId: filters.storeId || null },
    totals: {
      invoiceCount: Number(t.invoice_count) || 0,
      taxable: toNumber(t.taxable) ?? 0,
      tax: toNumber(t.tax) ?? 0,
    },
    b2cs: b2cRows[0].map((r) => ({
      day: r.day,
      taxable: toNumber(r.taxable) ?? 0,
      tax: toNumber(r.tax) ?? 0,
    })),
    hsns: Array.from(hsnMap.values()).map((h) => ({
      hsn: h.hsn,
      taxable: h.taxable,
      tax: h.tax,
      itemCount: h.count,
    })),
    notes: ["HSN summary is best-effort; missing HSN codes aggregate under '—'."],
  };
};

// === P&L report =============================================================
//
// Revenue: invoices.grand_total in range.
// COGS: not tracked in the schema; reported as null with a flag.
// Expenses: expenses.amount in range.
// Monthly buckets: split by year-month.

const pnlReport = async (filters = {}) => {
  const invWhere = buildScopeWhere(filters);
  const expWhere = buildScopeWhere(filters);

  // Revenue (from invoices).
  const revRows = await query(
    `SELECT COALESCE(SUM(grand_total), 0) AS revenue,
            COALESCE(SUM(gst_total), 0) AS gst_collected
     FROM invoices ${invWhere.sql}`,
    invWhere.params
  );
  const revenue = toNumber(revRows[0][0].revenue) ?? 0;
  const gst = toNumber(revRows[0][0].gst_collected) ?? 0;

  // Expenses total.
  const expRows = await query(
    `SELECT COALESCE(SUM(amount), 0) AS expenses FROM expenses ${expWhere.sql}`,
    expWhere.params
  );
  const expenses = toNumber(expRows[0][0].expenses) ?? 0;

  // Monthly buckets from invoices.
  const monthRows = await query(
    `SELECT DATE_FORMAT(\`date\`, '%Y-%m') AS month,
            COALESCE(SUM(grand_total), 0) AS revenue
     FROM invoices ${invWhere.sql}
     GROUP BY month
     ORDER BY month ASC`,
    invWhere.params
  );

  // Expenses by category.
  const expCatRows = await query(
    `SELECT COALESCE(category, 'uncategorised') AS category,
            COALESCE(SUM(amount), 0) AS amount
     FROM expenses ${expWhere.sql}
     GROUP BY category
     ORDER BY amount DESC`,
    expWhere.params
  );

  // COGS by category from invoice items (best-effort — uses items.cost if present).
  const cogsRows = await query(
    `SELECT items FROM invoices ${invWhere.sql}`,
    invWhere.params
  );
  const cogsByCategory = new Map();
  let cogsTotal = 0;
  for (const row of cogsRows[0]) {
    let items = row.items;
    if (typeof items === "string") {
      try { items = JSON.parse(items); } catch { items = []; }
    }
    if (!Array.isArray(items)) continue;
    for (const it of items) {
      const cost = Number(it?.cost ?? it?.cogs ?? 0) || 0;
      if (cost <= 0) continue;
      const cat = String(it?.category || "uncategorised").trim() || "uncategorised";
      cogsByCategory.set(cat, (cogsByCategory.get(cat) || 0) + cost);
      cogsTotal += cost;
    }
  }
  const cogsAvailable = cogsTotal > 0;

  return {
    from: filters.from || null,
    to: filters.to || null,
    scope: { storeType: filters.storeType || null, storeId: filters.storeId || null },
    totals: {
      revenue,
      gstCollected: gst,
      expenses,
      cogs: cogsTotal,
      netProfit: revenue - expenses - cogsTotal,
    },
    monthly: monthRows[0].map((r) => ({
      month: r.month,
      revenue: toNumber(r.revenue) ?? 0,
    })),
    expensesByCategory: expCatRows[0].map((r) => ({
      category: r.category,
      amount: toNumber(r.amount) ?? 0,
    })),
    cogsByCategory: cogsAvailable
      ? Array.from(cogsByCategory.entries()).map(([category, amount]) => ({ category, amount }))
      : null,
    cogsAvailable,
    note: cogsAvailable
      ? null
      : "Cost of goods sold is not tracked per-item; revenue - expenses shown as a fallback.",
  };
};

module.exports = {
  salesReport,
  gstReport,
  pnlReport,
};