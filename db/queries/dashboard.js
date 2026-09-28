// db/queries/dashboard.js
//
// Server-side aggregation for the mobile Manager Dashboard.
//
// Why this module exists instead of composing the existing report/invoice
// endpoints on the client:
//
//   - `GET /api/invoices` has no dedicated route; it falls through the generic
//     `app.get("/api/:resource")` catch-all, whose full-list mode selects the
//     `items` JSON array for every invoice in the store. A phone would download
//     every line item of every invoice to compute five numbers.
//   - `invoices.list` additionally filters `_user_email = ?`, so a STORE_ADMIN
//     receives only their own invoices. Its `stats` block inherits the same
//     predicate, so even the "aggregated" pagination mode is wrong for an admin.
//   - `expenses.list` filters `_user_email` unconditionally for the same reason.
//   - `/api/inventory/low-stock` has no role gate at all.
//
// So the dashboard runs its own aggregates, reusing the *existing canonical
// formulas* (the same SQL expressions reports.js and shifts.js use) rather than
// the existing *endpoints*. One round-trip, a fixed-size payload.
//
// This module is READ-ONLY. It never writes, and it never touches the locked
// hotel lodging/dining realtime or sync paths — the hotel section reads the
// ordinary `hotel_bookings` table and nothing else.

// The pool is required LAZILY. `db/pool.js` throws at require time when
// DB_USER / DB_PASSWORD / DB_NAME are unset, and every function below this
// point is a pure SQL-building helper that needs no connection — so a unit test
// (or any tool) can import and exercise them without database credentials.
let poolRef = null;
const getPool = () => {
  if (!poolRef) poolRef = require("../pool");
  return poolRef;
};

// Pure SQL-expression builder; safe to require eagerly, no DB access.
const { discountSumSql } = require("../../lib/discount-sql");

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

// Deny-by-default allowlist. `normalizeRole` in db/queries/users.js coerces any
// unrecognised role to CASHIER, so listing the permitted roles explicitly means
// a role added to VALID_ROLES later is refused rather than silently granted.
const DASHBOARD_ROLES = new Set(["SUPER_OWNER", "ADMIN", "STORE_ADMIN"]);

const isDashboardRoleAllowed = (role) =>
  DASHBOARD_ROLES.has(String(role || "").toUpperCase());

// ---------------------------------------------------------------------------
// SQL building blocks (pure — exported for the authorization test suite)
// ---------------------------------------------------------------------------

// The canonical discount expression, shared with reports.js, shifts.js and
// customer-history.js so a report can never disagree with another report or
// with the printed receipt.
//
// This module originally hardcoded `SUM(JSON_EXTRACT(discount_breakdown,
// '$.totalSavings'))`, which is correct for Retail and Hotel but returned 0 for
// Service — that vertical writes `{ bill: <number>, taxableAmount }` with no
// `totalSavings` key, and it has no line discounts, so `bill` IS its whole
// discount. The shared expression falls back to `$.bill` when it is numeric.
//
// We deliberately do not recompute anything from `discount.value`:
// `sub_total` is stored POST-discount, so a percent cannot be re-derived from
// the row at all. See lib/discount-sql.js for the full per-vertical breakdown.
const DISCOUNT_SUM_SQL = discountSumSql("discount", "discount_breakdown");

// Invoice status values are free-form; the frontend's live set is
// pending | paid | cleared | cancelled. Cancelled bills are excluded from the
// invoice COUNT but NOT from the money sums: the cash physically crossed the
// drawer, and dropping it would make the dashboard disagree with the shift
// reconciliation the manager is looking at beside it.
const buildSalesWhere = ({ scope = {}, from, to } = {}) => {
  const conds = [];
  const params = [];
  if (from) {
    conds.push("`date` >= ?");
    params.push(String(from));
  }
  if (to) {
    conds.push("`date` <= ?");
    params.push(String(to));
  }
  if (scope.storeType) {
    conds.push("_store_type = ?");
    params.push(String(scope.storeType));
  }
  if (scope.storeId) {
    conds.push("_store_id = ?");
    params.push(String(scope.storeId));
  }
  return {
    sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
};

// `invoice_returns` has no DATE column — only `created_at` (DATETIME(3)). The
// bound is widened to cover the whole `to` day, hence the exclusive next-day
// upper bound, so a returns total and an invoice total for the same period
// describe the same window instead of silently excluding the final day.
const buildReturnsWhere = ({ scope = {}, from, to } = {}) => {
  const conds = [];
  const params = [];
  if (from) {
    conds.push("created_at >= ?");
    params.push(`${String(from)} 00:00:00`);
  }
  if (to) {
    conds.push("created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    params.push(String(to));
  }
  if (scope.storeType) {
    conds.push("_store_type = ?");
    params.push(String(scope.storeType));
  }
  if (scope.storeId) {
    conds.push("_store_id = ?");
    params.push(String(scope.storeId));
  }
  return {
    sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
};

// `invoices.payment_mode` is a free-form VARCHAR, not an ENUM: the POS writes
// "Cash" | "UPI" | "Card" | "Split", the service flow writes "Bank Transfer",
// and the laundry flow writes "Slip". Canonicalise only for DISPLAY — the
// aggregation groups on the raw string, so a mode we have never seen still
// appears in the data rather than being hidden.
//
// Split payments are never persisted (the invoices INSERT has no `payments`
// column), so a split bill's per-mode amounts do not exist anywhere. Folding
// "Split" into "Other" alongside genuine unrecognised modes would destroy the
// only surviving signal that a split happened, so it stays a distinct bucket
// and the UI footnotes it.
const PAYMENT_LABELS = {
  cash: "Cash",
  upi: "UPI",
  card: "Card",
  "bank transfer": "Bank Transfer",
  banktransfer: "Bank Transfer",
  "bank-transfer": "Bank Transfer",
};

const foldPaymentMode = (mode) => {
  const key = String(mode == null ? "" : mode).trim().toLowerCase();
  return PAYMENT_LABELS[key] || "Other";
};

// ---------------------------------------------------------------------------
// Numerics
// ---------------------------------------------------------------------------
// db/pool.js is configured with `decimalNumbers: false`, so every DECIMAL
// arrives as a string. Coerce once, here, and never let a string reach JSON —
// the frontend would then do arithmetic on it.
const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ---------------------------------------------------------------------------
// Returns-table availability
// ---------------------------------------------------------------------------
// Migration 017 declares `KEY idx_invoice_return_items_invoice
// (original_invoice_no)` inside the CREATE TABLE, but that column is only added
// afterwards by a stored procedure — so the CREATE TABLE fails outright and the
// script aborts. There is no TiDB fix-up file and no runtime-migration entry,
// which means a deployed database may simply not have `invoice_returns`.
//
// We therefore probe once and cache. Absent tables produce a `returns: null`
// section the UI renders as "unavailable" — never a fabricated ₹0, which a
// manager would read as "we had no returns today".
let returnsTableChecked = false;
let returnsTablePresent = false;

const hasReturnsTable = async () => {
  if (returnsTableChecked) return returnsTablePresent;
  try {
    const { query } = getPool();
    const rows = await query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'invoice_returns' LIMIT 1`,
      [process.env.DB_NAME]
    );
    returnsTablePresent = !!(rows && rows[0] && rows[0].length);
  } catch {
    // A failed probe is not a licence to report zero returns.
    returnsTablePresent = false;
  }
  returnsTableChecked = true;
  return returnsTablePresent;
};

// Exposed so a test (or a future health check) can reset the memo.
const __resetReturnsProbe = () => {
  returnsTableChecked = false;
  returnsTablePresent = false;
};

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

// The one round-trip that answers most of the screen. `sub_total` is stored
// POST-discount (POSBilling.jsx: `subTotal = subTotalBeforeBillDiscount -
// billDiscountAmount`), so gross is a derived figure — there is no stored
// column for it — and it is only as complete as `totalSavings`, which the
// Retail / Service / Hotel flows write and Laundry does not (Laundry applies no
// discount at all, so its `sub_total` is already gross and the sum is correct
// there).
const salesSection = async (exec, scope, from, to) => {
  const where = buildSalesWhere({ scope, from, to });
  const [rows] = await exec(
    `SELECT COUNT(*) AS invoice_count,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,'pending')) = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_count,
            COALESCE(SUM(sub_total), 0)   AS sub_total_sum,
            COALESCE(SUM(gst_total), 0)   AS gst_sum,
            COALESCE(SUM(grand_total), 0) AS grand_total_sum,
            ${DISCOUNT_SUM_SQL}           AS discount_sum
       FROM invoices ${where.sql}`,
    where.params
  );
  const r = (rows && rows[0]) || {};
  const subTotal = toNumber(r.sub_total_sum);
  const discount = toNumber(r.discount_sum);
  return {
    invoiceCount: toNumber(r.invoice_count),
    cancelledCount: toNumber(r.cancelled_count),
    netInvoiceCount: Math.max(0, toNumber(r.invoice_count) - toNumber(r.cancelled_count)),
    grandTotal: toNumber(r.grand_total_sum),
    subTotal,
    gstTotal: toNumber(r.gst_sum),
    discountTotal: discount,
    grossTotal: subTotal + discount,
    averageBill: toNumber(r.invoice_count) > 0
      ? Math.round((toNumber(r.grand_total_sum) / toNumber(r.invoice_count)) * 100) / 100
      : 0,
  };
};

// `invoices.date` is a DATE column and the pool returns dateStrings, so it comes
// back as YYYY-MM-DD with no DATE_FORMAT needed.
const trendSection = async (exec, scope, from, to) => {
  const where = buildSalesWhere({ scope, from, to });
  const [rows] = await exec(
    `SELECT \`date\` AS day,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(grand_total), 0) AS revenue
       FROM invoices ${where.sql}
      GROUP BY day
      ORDER BY day ASC`,
    where.params
  );
  return (rows || []).map((r) => ({
    day: r.day,
    invoiceCount: toNumber(r.invoice_count),
    revenue: toNumber(r.revenue),
  }));
};

// Grouping on the raw string keeps every recorded mode visible; folding to
// labels happens in JS so an unrecognised mode still surfaces as "Other"
// rather than vanishing. Split bills keep their own bucket — see foldPaymentMode.
const paymentsSection = async (exec, scope, from, to) => {
  const where = buildSalesWhere({ scope, from, to });
  const [rows] = await exec(
    `SELECT COALESCE(payment_mode, 'unknown') AS payment_mode,
            COUNT(*) AS invoice_count,
            COALESCE(SUM(grand_total), 0) AS revenue
       FROM invoices ${where.sql}
      GROUP BY payment_mode
      ORDER BY revenue DESC`,
    where.params
  );
  const buckets = new Map();
  for (const row of rows || []) {
    const label = foldPaymentMode(row.payment_mode);
    const cur = buckets.get(label) || { mode: label, invoiceCount: 0, total: 0 };
    cur.invoiceCount += toNumber(row.invoice_count);
    cur.total += toNumber(row.revenue);
    buckets.set(label, cur);
  }
  return Array.from(buckets.values()).sort((a, b) => b.total - a.total);
};

// Store-wide, deliberately WITHOUT `_user_email`.
//
// `expenses.list` binds expenses to their creator, which is right for an
// editable list but wrong for a manager rollup: an admin would see "₹4,200
// expenses" while the store spent ₹31,000, and would make a decision on the
// wrong number. This matches pnlReport, which already scopes expenses by store
// alone.
const expensesSection = async (exec, scope, from, to) => {
  const where = buildSalesWhere({ scope, from, to });
  const [rows] = await exec(
    `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS entry_count
       FROM expenses ${where.sql}`,
    where.params
  );
  const [byCategoryRows] = await exec(
    `SELECT COALESCE(category, 'uncategorised') AS category,
            COALESCE(SUM(amount), 0) AS total
       FROM expenses ${where.sql}
      GROUP BY category
      ORDER BY total DESC
      LIMIT 5`,
    where.params
  );
  const r = (rows && rows[0]) || {};
  return {
    total: toNumber(r.total),
    entryCount: toNumber(r.entry_count),
    byCategory: (byCategoryRows || []).map((row) => ({
      category: row.category,
      total: toNumber(row.total),
    })),
  };
};

const returnsSection = async (exec, scope, from, to) => {
  if (!(await hasReturnsTable())) return null;
  const where = buildReturnsWhere({ scope, from, to });
  const [rows] = await exec(
    `SELECT COUNT(*) AS return_count,
            COALESCE(SUM(grand_total), 0) AS total,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(status,'completed')) IN ('pending','approved') THEN 1 ELSE 0 END), 0) AS unsettled_count
       FROM invoice_returns ${where.sql}`,
    where.params
  );
  const [byMethodRows] = await exec(
    `SELECT COALESCE(refund_method, 'none') AS refund_method,
            COUNT(*) AS return_count,
            COALESCE(SUM(grand_total), 0) AS total
       FROM invoice_returns ${where.sql}
      GROUP BY refund_method
      ORDER BY total DESC`,
    where.params
  );
  const r = (rows && rows[0]) || {};
  return {
    returnCount: toNumber(r.return_count),
    total: toNumber(r.total),
    unsettledCount: toNumber(r.unsettled_count),
    byRefundMethod: (byMethodRows || []).map((row) => ({
      method: row.refund_method,
      returnCount: toNumber(row.return_count),
      total: toNumber(row.total),
    })),
  };
};

// "New" customers are counted over the SELECTED period, not a fixed window —
// a manager asking for "today" wants today's sign-ups. `customers.created_at`
// is a nullable DATETIME with no index, so this reuses the store predicate
// rather than adding one; the customer book is small enough that the scan is
// not the bottleneck.
const customersSection = async (exec, scope, from, to) => {
  const where = buildSalesWhere({ scope });
  const createdConds = [];
  const createdParams = [];
  if (from) {
    createdConds.push("created_at >= ?");
    createdParams.push(`${String(from)} 00:00:00`);
  }
  if (to) {
    createdConds.push("created_at < DATE_ADD(?, INTERVAL 1 DAY)");
    createdParams.push(String(to));
  }
  const newExpr = createdConds.length
    ? `COALESCE(SUM(CASE WHEN ${createdConds.join(" AND ")} THEN 1 ELSE 0 END), 0)`
    : "0";
  const [rows] = await exec(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN LOWER(COALESCE(approval_status,'approved')) = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
            ${newExpr} AS new_in_period
       FROM customers ${where.sql}`,
    [...createdParams, ...where.params]
  );
  const r = (rows && rows[0]) || {};
  return {
    total: toNumber(r.total),
    pendingCount: toNumber(r.pending),
    newInPeriod: toNumber(r.new_in_period),
  };
};

// Purchase orders: counts only. `listPurchaseOrders` fans out one `listPoItems`
// query per PO, which is the N+1 this dashboard exists to avoid — a manager
// needs the count of open POs, not every line of every one.
const purchaseOrdersSection = async (exec, scope) => {
  const where = buildSalesWhere({ scope });
  const [rows] = await exec(
    `SELECT COALESCE(LOWER(status), 'draft') AS status, COUNT(*) AS po_count,
            COALESCE(SUM(total_amount), 0) AS total
       FROM purchase_orders ${where.sql}
      GROUP BY status`,
    where.params
  );
  return (rows || []).map((r) => ({
    status: r.status,
    count: toNumber(r.po_count),
    total: toNumber(r.total),
  }));
};

// ---------------------------------------------------------------------------
// Hotel (read-only)
// ---------------------------------------------------------------------------
// `hotel_bookings` is an ordinary MySQL table with a `kind` discriminator and a
// plain status column — reading it is safe. What is NOT available:
//
//   - MONEY. The table has no amount columns at all; hotel revenue reaches the
//     database only when a bill is generated as an `invoices` row. So there is
//     no "hotel revenue" tile to build here, and inventing one is worse than
//     omitting it.
//   - LIVE OCCUPANCY. Table and room state live in the `hotel_state` JSON
//     singleton, reachable only through the locked lodging/dining realtime
//     channel. This dashboard does not subscribe to or read it.
//
// Counts below are therefore historical/booking-level only.
const hotelSection = async (exec, scope) => {
  const where = buildSalesWhere({ scope });
  const [rows] = await exec(
    `SELECT COALESCE(kind, 'unknown') AS kind,
            COALESCE(LOWER(COALESCE(status,'unknown')), 'unknown') AS status,
            COUNT(*) AS booking_count
       FROM hotel_bookings ${where.sql}
      GROUP BY kind, status`,
    where.params
  );
  const byKind = new Map();
  for (const row of rows || []) {
    const cur = byKind.get(row.kind) || { kind: row.kind, total: 0, byStatus: {} };
    const count = toNumber(row.booking_count);
    cur.total += count;
    cur.byStatus[row.status] = count;
    byKind.set(row.kind, cur);
  }
  return {
    bookings: Array.from(byKind.values()),
    // Stated explicitly so the UI can explain the gap rather than the manager
    // assuming zero revenue.
    revenueAvailable: false,
    liveOccupancyAvailable: false,
  };
};

// ---------------------------------------------------------------------------
// summary()
// ---------------------------------------------------------------------------
// Store-type aware in the only way the data allows: the sales/payments/trend
// sections read `invoices`, which is the single settlement table shared by
// every vertical, so they are correct for retail, service, msme-service,
// laundry and hotel alike. Vertical-specific sections are ADDED for the types
// that have them rather than replacing the base — a hotel manager still wants
// to see today's sales alongside their occupancy counts.
const summary = async (scope = {}, { from, to, storeType } = {}) => {
  const { query } = getPool();
  const exec = (sql, params) => query(sql, params);

  // Reuse the existing modules wherever one already computes the metric
  // correctly, rather than re-implementing shift reconciliation or severity
  // banding. Both are imported lazily for the same reason the pool is: this
  // module must be importable without DB credentials for the auth tests.
  const inventoryQueries = require("./inventory");
  const shiftsQueries = require("./shifts");

  const vertical = String(storeType || "").toLowerCase();

  const [sales, trend, payments, expenses, returns, customers, purchaseOrders, lowStock, activeShift] =
    await Promise.all([
      salesSection(exec, scope, from, to),
      trendSection(exec, scope, from, to),
      paymentsSection(exec, scope, from, to),
      expensesSection(exec, scope, from, to),
      returnsSection(exec, scope, from, to),
      customersSection(exec, scope, from, to),
      // POs and stock only mean something where there is stock to order.
      ["retail", "inventory", "laundry"].includes(vertical)
        ? purchaseOrdersSection(exec, scope)
        : Promise.resolve(null),
      ["retail", "inventory", "laundry"].includes(vertical)
        ? inventoryQueries.lowStockAlerts(scope)
        : Promise.resolve(null),
      shiftsQueries.getActiveForStore(scope.storeType, scope.storeId),
    ]);

  // Expected cash comes from the shift module's own reconciliation, so the
  // figure the manager reads here is the same one the close-shift dialog shows.
  let shift = null;
  if (activeShift && activeShift.id != null) {
    const recon = await shiftsQueries.reconciliation(activeShift.id);
    shift = {
      id: activeShift.id,
      status: activeShift.status,
      openedAt: activeShift.openedAt ?? null,
      userId: activeShift.userId ?? null,
      branchName: activeShift.branchName ?? null,
      openingFloat: recon ? recon.openingFloat : 0,
      expectedCash: recon ? recon.expectedCash : 0,
    };
  }

  const hotel = vertical === "hotel" ? await hotelSection(exec, scope) : null;

  const inventory = lowStock
    ? {
        outOfStock: lowStock.filter((p) => p.severity === "out").length,
        critical: lowStock.filter((p) => p.severity === "critical").length,
        low: lowStock.filter((p) => p.severity === "low").length,
        total: lowStock.length,
        // A handful only — the full list can run to 200 rows.
        criticalItems: lowStock.slice(0, 5).map((p) => ({
          id: p.id,
          name: p.name,
          stock: p.stock,
          lowStock: p.lowStock,
          severity: p.severity,
        })),
      }
    : null;

  return {
    scope: {
      storeType: scope.storeType || null,
      storeId: scope.storeId || null,
    },
    range: { from: from || null, to: to || null },
    generatedAt: new Date().toISOString(),
    sales,
    payments,
    trend,
    expenses,
    // `null` means "not available for this store type"; the UI must render that
    // differently from a genuine zero.
    returns,
    customers,
    purchaseOrders,
    inventory,
    shifts: shift,
    hotel,
  };
};

module.exports = {
  summary,
  DASHBOARD_ROLES,
  isDashboardRoleAllowed,
  DISCOUNT_SUM_SQL,
  buildSalesWhere,
  buildReturnsWhere,
  foldPaymentMode,
  PAYMENT_LABELS,
  hasReturnsTable,
  __resetReturnsProbe,
};
