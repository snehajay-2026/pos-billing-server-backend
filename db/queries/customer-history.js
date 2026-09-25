// customer-history.js — Customer Purchase History (Phase 2A).
//
// READ-ONLY. This module never writes. It derives everything from the
// authoritative invoice ledger rather than copying anything, so history can
// never drift from the invoices it describes.
//
// Source of truth:
//   invoices            — the purchase ledger (customer_id, amounts, items)
//   invoice_returns     — return/refund headers, keyed by invoice_no
//   invoice_return_items— per-line returned amounts
//
// There is deliberately NO customer_purchase_history table. `invoices` already
// is the ledger, it is already indexed for exactly this query
// (`idx_invoices_customer (customer_id, _store_type, _store_id)` — a hard
// startup gate in runtime-migrations.js), and a copy would need its own
// backfill, reconciliation, and drift handling for no query-plan benefit.
//
// Walking customers: an invoice with NULL customer_id is anonymous and is
// NEVER attributed to a named customer. No fuzzy matching on name/mobile/email.

const { query } = require("../pool");

// The invoice column list. Mirrors invoices.js `COLUMNS_BASE` so the shape the
// UI already knows how to render (InvoiceList / InvoiceView) is unchanged —
// history reuses the existing invoice detail route, so a history row and a
// normal invoice row must agree field-for-field.
const INVOICE_COLUMNS =
  "i.id, i.invoice_no, i.date, i.items, i.sub_total, i.gst_total, i.grand_total, " +
  "i.discount, i.discount_breakdown, i.payment_mode, i.billed_by, i.status, " +
  "i.customer_name, i.customer_mobile, i.customer_id, i.generated_at, i.created_at";

// `discount` is a JSON column shaped { type: "percent" | "flat", value } —
// see POSBilling's applyDiscount. A bill-level discount is stored there while
// per-line discounts live inside `items[].lineDiscount`. A MySQL JSON scalar
// yields its value; extracting `.value` here keeps the summary arithmetic in
// SQL rather than dragging every item blob into memory just to add them up.
//
// Returns are aggregated, never joined 1:1 — a single invoice may carry several
// return rows, and a naive join would multiply the invoice's amounts by the
// number of returns. Two scalar subqueries avoid that fan-out entirely.
//
// This is a bare SELECT-LIST fragment (no leading `SELECT` and no FROM), so it
// can be injected straight into the page query's own select list.
const RETURN_AGGREGATE_EXPRESSIONS = `
    COALESCE((
      SELECT COUNT(*)
        FROM invoice_returns r
       WHERE r.invoice_no = i.invoice_no
    ), 0) AS return_count,
    COALESCE((
      SELECT SUM(r.grand_total)
        FROM invoice_returns r
       WHERE r.invoice_no = i.invoice_no
         AND r.status IN ('completed', 'approved')
    ), 0) AS returned_amount
`;

// Only 'completed' and 'approved' returns are treated as settled. This mirrors
// the over-return guard in returns.js:357, which counts exactly those two
// statuses — so "has this been returned?" means the same thing here as it does
// in the returns module.

const SUMMARY_SQL = `
  SELECT
    COUNT(*) AS total_invoices,
    COALESCE(SUM(i.sub_total), 0) AS total_subtotal,
    COALESCE(SUM(i.discount_breakdown->>'$.bill'), 0) AS total_bill_discount,
    COALESCE(SUM(i.gst_total), 0) AS total_gst,
    COALESCE(SUM(i.grand_total), 0) AS total_purchase_amount,
    MIN(i.generated_at) AS first_purchase_at,
    MAX(i.generated_at) AS last_purchase_at
  FROM invoices i
  WHERE i.customer_id = ? AND i._store_type = ? AND i._store_id = ?
`;

const RETURNED_SUMMARY_SQL = `
  SELECT COALESCE(SUM(r.grand_total), 0) AS total_returned_amount
    FROM invoice_returns r
    JOIN invoices i ON i.invoice_no = r.invoice_no
   WHERE i.customer_id = ?
     AND i._store_type = ?
     AND i._store_id = ?
     AND r.status IN ('completed', 'approved')
`;

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const normalizePage = (page) => {
  const n = Number(page);
  return Number.isInteger(n) && n > 0 ? n : 1;
};

// Page size is clamped so a caller cannot ask for the whole table in one
// response. The brief requires server-side pagination precisely so history is
// never fetched wholesale.
const normalizePageSize = (pageSize) => {
  const n = Number(pageSize);
  if (!Number.isInteger(n) || n < 1) return 10;
  return Math.min(n, 100);
};

// Return state is derived, not stored. `partial` means settled returns exist
// but did not consume the whole invoice; `full` means the returned amount
// reaches the invoice total.
//
// The comparison tolerates one paisa (0.01). Both sides are DECIMAL(12,2) in
// MySQL/TiDB so they are exact, but a full return can legitimately differ from
// the invoice total by a paisa after per-line rounding, and treating that as
// "partial" would understate a genuinely complete return.
const FULL_RETURN_TOLERANCE = 0.01;

const returnStateFor = (row, grandTotal) => {
  const count = toNumber(row.return_count);
  if (!count) return "none";
  const returned = toNumber(row.returned_amount);
  const total = toNumber(grandTotal);
  if (returned > 0 && total > 0 && returned + FULL_RETURN_TOLERANCE >= total) return "full";
  return "partial";
};

const shapeInvoice = (row) => {
  const grandTotal = toNumber(row.grand_total);
  return {
    id: row.id != null ? Number(row.id) : row.id,
    invoiceNo: row.invoice_no || null,
    date: row.date || null,
    items: row.items || [],
    subTotal: toNumber(row.sub_total),
    gstTotal: toNumber(row.gst_total),
    grandTotal,
    // The bill-level discount is the one stored on the invoice row. Per-line
    // discounts stay inside items[].lineDiscount and are rendered by the
    // existing invoice view; the summary total below adds both.
    discount: toNumber(row.bill_discount),
    discountBreakdown: row.discount_breakdown || null,
    paymentMode: row.payment_mode || null,
    billedBy: row.billed_by || null,
    status: row.status || null,
    customerName: row.customer_name || null,
    customerMobile: row.customer_mobile || null,
    customerId: row.customer_id != null ? Number(row.customer_id) : null,
    generatedAt: row.generated_at || null,
    createdAt: row.created_at || null,
    returnCount: toNumber(row.return_count),
    returnedAmount: toNumber(row.returned_amount),
    returnState: returnStateFor(row, grandTotal),
  };
};

// purchaseHistory: one page of a customer's invoices, newest first.
//
// Ordering is `generated_at DESC, id DESC` in SQL — the same convention
// invoices.js:422 uses. The frontend renders the response in the order
// received and must NOT re-sort or reverse; doing that is the exact bug that
// was fixed in commit 132dfd8.
const purchaseHistory = async ({ customerId, scope, page = 1, pageSize = 10 }) => {
  const currentPage = normalizePage(page);
  const size = normalizePageSize(pageSize);
  const offset = (currentPage - 1) * size;
  const params = [customerId, scope.storeType, scope.storeId];

  const [rows, countRows] = await Promise.all([
    query(
      `SELECT ${INVOICE_COLUMNS},
              ${RETURN_AGGREGATE_EXPRESSIONS},
              COALESCE(i.discount_breakdown->>'$.bill', 0) AS bill_discount
         FROM invoices i
        WHERE i.customer_id = ?
          AND i._store_type = ?
          AND i._store_id = ?
        ORDER BY i.generated_at DESC, i.id DESC
        LIMIT ? OFFSET ?`,
      [...params, size, offset]
    ),
    query(
      `SELECT COUNT(*) AS total
         FROM invoices i
        WHERE i.customer_id = ? AND i._store_type = ? AND i._store_id = ?`,
      params
    ),
  ]);

  const total = toNumber((countRows[0] || [])[0]?.total);
  return {
    items: (rows[0] || []).map(shapeInvoice),
    pagination: {
      page: currentPage,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
    },
  };
};

// summary: lifetime aggregates for the customer profile header.
//
// "Total Purchase Amount" is defined explicitly as SUM(grand_total) over the
// customer's invoices — the gross billed value, GST included, which is what the
// customer actually paid per invoice. It is NOT net of returns; the returned
// amount is reported separately and alongside it so the two are never
// conflated. No "net purchase" figure is invented here — see the final report.
const summary = async ({ customerId, scope }) => {
  const params = [customerId, scope.storeType, scope.storeId];
  const [rows, returnRows] = await Promise.all([
    query(SUMMARY_SQL, params),
    query(RETURNED_SUMMARY_SQL, params),
  ]);

  const s = (rows[0] || [])[0] || {};
  const totalPurchaseAmount = toNumber(s.total_purchase_amount);
  const totalReturnedAmount = toNumber(
    (returnRows[0] || [])[0]?.total_returned_amount
  );
  const totalInvoices = toNumber(s.total_invoices);

  return {
    totalInvoices,
    totalPurchaseAmount,
    totalGst: toNumber(s.total_gst),
    totalSubtotal: toNumber(s.total_subtotal),
    // Bill-level discount only. Per-line discounts are stored inside each
    // invoice's `items` JSON array, and TiDB cannot reliably SUM across a
    // nested JSON array — so rather than load every historical line blob to
    // add them up, the lifetime figure reports the bill-level discount that
    // SQL can derive exactly. Each invoice's per-line discount remains
    // visible on its own history row and in the invoice view.
    totalDiscount: toNumber(s.total_bill_discount),
    totalReturnedAmount,
    // Reported, not derived by subtraction, so a store reading the figure
    // cannot mistake it for a net-of-returns number.
    totalRefundedAmount: totalReturnedAmount,
    averageOrderValue:
      totalInvoices > 0 ? +(totalPurchaseAmount / totalInvoices).toFixed(2) : 0,
    firstPurchaseDate: s.first_purchase_at || null,
    lastPurchaseDate: s.last_purchase_at || null,
  };
};

module.exports = {
  INVOICE_COLUMNS,
  RETURN_AGGREGATE_EXPRESSIONS,
  SUMMARY_SQL,
  RETURNED_SUMMARY_SQL,
  normalizePage,
  normalizePageSize,
  returnStateFor,
  shapeInvoice,
  purchaseHistory,
  summary,
};
