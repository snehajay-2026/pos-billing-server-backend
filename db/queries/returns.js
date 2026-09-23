// server/db/queries/returns.js
//
// All SQL touching `invoice_returns` + `invoice_return_items`. Mirrors
// the structure of `invoices.js` and `inventory.js` — small, focused,
// and the only module that knows about the returns schema.
//
// The single public write entry point is `createWithStockReconciliation`,
// which wraps the whole refund event in a transaction:
//   1. Lock the source invoice (FOR UPDATE) and validate scope + items.
//   2. Verify the request does NOT over-return any product — sum every
//      prior approved return's quantity per product against the invoice's
//      original line quantity. Throws 409 OVER_RETURNED on the first
//      violation.
//   3. INSERT the invoice_returns header row.
//   4. INSERT one invoice_return_items row per returned line.
//   5. For each returned line: write a stock_movements row AND adjust
//      products.stock atomically. resalable → +qty; damaged → -qty with
//      a separate 'damaged' movement (the existing stock_movements.type
//      ENUM is in/out/adjustment so 'damaged' lands under 'out' with a
//      reason that distinguishes it from a normal sale).
//   6. If refund_method='cash' AND there's an active shift: append a
//      `shift_cash_movements` row with type='cash_out', reason='refund:
//      <invoice_no>', ref_type='return', ref_id=<new return id>. The
//      UNIQUE (shift_id, ref_type, ref_id) added by migration 013 makes
//      this idempotent if the cashier re-submits after a network blip.
//   7. Emit an audit-log row via the caller-supplied `recordAudit` so
//      RecentActivity picks it up. (The route layer wraps recordAudit
//      around this helper to keep the audit emission co-located with
//      SSE side-effects.)
//
// All other write paths (approve / reject / cancel) are deliberately
// excluded for v1: the cashier-submits pattern matches the customer-
// approval workflow already in customers.js. If we need admin-approves
// later, add it under the same hook.
//
// Reads: listByScope (paginated), findById (with items joined), and
// listByInvoiceNo (history against a single invoice — used for the
// "Returns" panel on the invoice preview).

const { query, withTransaction } = require("../pool");
const invoicesQueries = require("./invoices");
const productsQueries = require("./products");
const inventoryQueries = require("./inventory");

// ============================================================================
// Helpers
// ============================================================================

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const num = (v, fallback = 0) => {
  const n = toNumber(v);
  return n == null ? fallback : n;
};

const clean = (v) => (v == null ? "" : String(v).trim());

const ALLOWED_TYPES = new Set(["return", "refund", "exchange", "cancel"]);
const ALLOWED_METHODS = new Set([
  "cash",
  "upi",
  "card",
  "bank_transfer",
  "store_credit",
  "exchange",
  "none",
]);

// Resolve the effective quantity for an invoice line. Mirrors the
// `resolveQty` convention in invoices.js: items in kg carry qtyKg, items
// sold by unit carry qty.
const resolveQty = (item) => {
  if (!item) return 0;
  if (item.unit === "kg" && item.qtyKg != null) return Number(item.qtyKg) || 0;
  if (item.qty != null) return Number(item.qty) || 0;
  if (item.quantity != null) return Number(item.quantity) || 0;
  return 0;
};

// Read the items[] JSON column back into the canonical line shape used
// by the route layer. We DON'T trust the per-line discount / gst fields
// the cashier typed — we recompute them server-side from unit_price *
// qty - discount + gst so a tampered client can't inflate the refund.
const computeLineTotals = (line) => {
  const qty = resolveQty(line);
  const unitPrice = num(line.price ?? line.unitPrice ?? line.unit_price);
  const lineSubtotal = +(unitPrice * qty).toFixed(2);
  const lineDiscount = num(line.lineDiscount ?? line.line_discount ?? line.discount ?? 0);
  const lineGst = num(line.lineGst ?? line.line_gst ?? line.gst ?? 0);
  const lineTotal = +(lineSubtotal - lineDiscount + lineGst).toFixed(2);
  return {
    qty,
    unitPrice,
    lineSubtotal,
    lineDiscount,
    lineGst,
    lineTotal,
  };
};

// ============================================================================
// Reads
// ============================================================================

// Map a raw returns row to the API shape. The route layer joins items
// separately and slots them under `items: [...]`.
const rowToReturn = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    invoiceNo: row.invoice_no || null,
    type: row.type || null,
    scope: row.scope || null,
    refundMethod: row.refund_method || null,
    replacementInvoiceNo: row.replacement_invoice_no || null,
    subTotal: num(row.sub_total),
    gstTotal: num(row.gst_total),
    grandTotal: num(row.grand_total),
    priceDifference: num(row.price_difference),
    reason: row.reason || null,
    status: row.status || null,
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    approvedBy: row.approved_by != null ? Number(row.approved_by) : null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const rowToReturnItem = (row) => ({
  id: row.id != null ? Number(row.id) : null,
  returnId: row.return_id != null ? Number(row.return_id) : null,
  productId: row.product_id != null ? Number(row.product_id) : null,
  productName: row.product_name || null,
  originalInvoiceNo: row.original_invoice_no || null,
  originalQuantity: num(row.original_quantity),
  returnedQuantity: num(row.returned_quantity),
  unitPrice: num(row.unit_price),
  lineDiscount: num(row.line_discount),
  lineGst: num(row.line_gst),
  lineTotal: num(row.line_total),
  condition: row.condition || null,
});

// listByScope: all returns for the authorized store scope. SUPER_OWNER
// without an explicit store sees all rows. Cashiers see all rows in their
// store — we deliberately don't filter by `_user_email` here because the
// admin who opens the page needs to see the cashier's returns too.
const listByScope = async (scope, filters = {}) => {
  const conds = [];
  const params = [];
  if (scope.storeType) {
    conds.push("r._store_type = ?");
    params.push(String(scope.storeType));
  }
  if (scope.storeId) {
    conds.push("r._store_id = ?");
    params.push(String(scope.storeId));
  }
  if (filters.invoiceNo) {
    conds.push("r.invoice_no = ?");
    params.push(String(filters.invoiceNo));
  }
  if (filters.type) {
    conds.push("r.type = ?");
    params.push(String(filters.type));
  }
  if (filters.status) {
    conds.push("r.status = ?");
    params.push(String(filters.status));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await query(
    `SELECT r.* FROM invoice_returns r ${where}
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 500`,
    params
  );
  const headerRows = rows[0].map(rowToReturn);
  if (headerRows.length === 0) return [];
  // Batch-fetch all items for these return ids. N+1 fan-out would burn a
  // round-trip per return; one IN-clause query keeps this cheap.
  const ids = headerRows.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  const itemRows = await query(
    `SELECT * FROM invoice_return_items WHERE return_id IN (${placeholders})`,
    ids
  );
  const itemsByReturn = new Map();
  for (const item of itemRows[0].map(rowToReturnItem)) {
    if (!itemsByReturn.has(item.returnId)) itemsByReturn.set(item.returnId, []);
    itemsByReturn.get(item.returnId).push(item);
  }
  return headerRows.map((h) => ({ ...h, items: itemsByReturn.get(h.id) || [] }));
};

// listByInvoiceNo: short helper for the "all returns against this
// invoice" drilldown on the invoice preview page.
const listByInvoiceNo = async (invoiceNo, scope) => {
  return listByScope(scope, { invoiceNo: String(invoiceNo || "") });
};

const findById = async (id, scope) => {
  const rows = await query(
    `SELECT * FROM invoice_returns WHERE id = ? LIMIT 1`,
    [Number(id)]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  const header = rowToReturn(rows[0][0]);
  if (scope) {
    if (
      scope.storeType &&
      header._storeType &&
      String(header._storeType) !== String(scope.storeType)
    ) return null;
    if (
      scope.storeId &&
      header._storeId &&
      String(header._storeId) !== String(scope.storeId)
    ) return null;
  }
  const itemRows = await query(
    `SELECT * FROM invoice_return_items WHERE return_id = ?`,
    [Number(id)]
  );
  return { ...header, items: itemRows[0].map(rowToReturnItem) };
};

// ============================================================================
// Writes
// ============================================================================

// validateRequest: enforce the route layer's input contract before opening
// a transaction. Each branch throws a specific {status, code, message} so
// the route layer can surface a clean 400/409 to the frontend without the
// frontend having to translate generic MySQL errors.
const validateRequest = (payload = {}) => {
  if (!payload.invoiceNo && payload.type !== "refund") {
    const e = new Error("invoiceNo is required for non-refund types");
    e.status = 400;
    e.code = "VALIDATION_ERROR";
    throw e;
  }
  if (!ALLOWED_TYPES.has(payload.type)) {
    const e = new Error(`type must be one of: ${[...ALLOWED_TYPES].join(", ")}`);
    e.status = 400;
    e.code = "VALIDATION_ERROR";
    throw e;
  }
  if (payload.refundMethod && !ALLOWED_METHODS.has(payload.refundMethod)) {
    const e = new Error(
      `refundMethod must be one of: ${[...ALLOWED_METHODS].join(", ")}`
    );
    e.status = 400;
    e.code = "VALIDATION_ERROR";
    throw e;
  }
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (payload.type !== "refund" && items.length === 0) {
    const e = new Error("At least one line item is required");
    e.status = 400;
    e.code = "VALIDATION_ERROR";
    throw e;
  }
  for (const item of items) {
    if (!item.productId) {
      const e = new Error("Each line item requires productId");
      e.status = 400;
      e.code = "VALIDATION_ERROR";
      throw e;
  }
    const qty = resolveQty(item);
    if (qty <= 0) {
      const e = new Error("Return quantity must be positive");
      e.status = 400;
      e.code = "VALIDATION_ERROR";
      e.productId = item.productId;
      throw e;
    }
    if (item.condition && !["resalable", "damaged"].includes(item.condition)) {
      const e = new Error("condition must be 'resalable' or 'damaged'");
      e.status = 400;
      e.code = "VALIDATION_ERROR";
      throw e;
    }
  }
  return items;
};

// createWithStockReconciliation: the atomic refund primitive. Mirrors
// `invoices.createWithStockDecrement` and `inventory.receivePurchaseOrder`
// — three things in one transaction, no partial state on failure.
//
// Inputs:
//   payload — the request body. Shape:
//     {
//       invoiceNo, type, scope, refundMethod, reason,
//       replacementInvoiceNo, priceDifference,
//       items: [{ productId, qty/qtyKg, condition, unitPrice, lineDiscount, lineGst }],
//     }
//   scope — { storeType, storeId, email } from getRequestScope(req).
//   options:
//     shift — the cashier's currently-open shift (or null). When set AND
//             refundMethod='cash', append a shift_cash_movement row.
//     userId — id of the cashier submitting the return (audit + stock
//              movement created_by).
//
// Returns: { return: <header>, items: [...], stockMovements: [...] } so
// the route layer can publish a single realtime fan-out.
const createWithStockReconciliation = async (payload, scope, options = {}) => {
  const items = validateRequest(payload);

  // For 'refund' type the items list may be empty — money-only adjustment.
  // For everything else, look up the original invoice so we can validate
  // the per-product over-return guard and scope.
  const invoiceNo = clean(payload.invoiceNo);
  const invoice = invoiceNo
    ? await invoicesQueries.findByInvoiceNoScoped(invoiceNo, scope)
    : null;
  if (invoiceNo && !invoice) {
    const e = new Error("Original invoice not found");
    e.status = 404;
    e.code = "INVOICE_NOT_FOUND";
    throw e;
  }

  return withTransaction(async (conn) => {
    // Lock the source invoice row so two simultaneous refund attempts on
    // the same bill can't both win the over-return check.
    if (invoice) {
      const [invoiceRows] = await conn.query(
        "SELECT id FROM invoices WHERE invoice_no = ? FOR UPDATE",
        [invoiceNo]
      );
      if (invoiceRows.length === 0) {
        const e = new Error("Original invoice was deleted mid-transaction");
        e.status = 409;
        e.code = "INVOICE_NOT_FOUND";
        throw e;
      }
    }

    // Build a per-product ledger of what's already been returned against
    // this invoice, so we can refuse a return that exceeds the original.
    const returnedSoFar = new Map();
    if (invoiceNo) {
      const [priorRows] = await conn.query(
        `SELECT ri.product_id, SUM(ri.returned_quantity) AS qty
           FROM invoice_return_items ri
           JOIN invoice_returns r ON r.id = ri.return_id
          WHERE r.invoice_no = ? AND r.status IN ('completed','approved')
          GROUP BY ri.product_id`,
        [invoiceNo]
      );
      for (const row of priorRows) {
        returnedSoFar.set(
          Number(row.product_id),
          Number(row.qty) || 0
        );
      }
    }

    // Lock + adjust each product's stock in the same transaction.
    // resalable → +qty (returns to inventory), damaged → -qty (waste-out).
    const updatedStock = [];
    const stockMovements = [];
    for (const item of items) {
      const [productRows] = await conn.query(
        "SELECT id, name, stock FROM products WHERE id = ? FOR UPDATE",
        [item.productId]
      );
      if (productRows.length === 0) {
        const e = new Error("Product not found");
        e.status = 404;
        e.code = "PRODUCT_NOT_FOUND";
        e.productId = item.productId;
        throw e;
      }
      const product = productRows[0];
      const requested = resolveQty(item);
      const available = Number(product.stock) || 0;

      // Over-return check: only meaningful when we have an original invoice.
      if (invoiceNo) {
        const originalLine = (invoice.items || []).find(
          (line) => Number(line.id) === Number(item.productId)
        );
        if (!originalLine) {
          const e = new Error("Product not on original invoice");
          e.status = 409;
          e.code = "NOT_ON_INVOICE";
          e.productId = item.productId;
          e.productName = product.name;
          throw e;
        }
        const originalQty = resolveQty(originalLine);
        const alreadyReturned = returnedSoFar.get(Number(item.productId)) || 0;
        const remainingQty = +(originalQty - alreadyReturned).toFixed(3);
        if (requested > remainingQty) {
          const e = new Error("Return quantity exceeds remaining");
          e.status = 409;
          e.code = "OVER_RETURNED";
          e.productId = item.productId;
          e.productName = product.name;
          e.originalQty = originalQty;
          e.alreadyReturned = alreadyReturned;
          e.remainingQty = remainingQty;
          e.requested = requested;
          throw e;
        }
      }

      const condition = item.condition || "resalable";
      // Damaged items DECREMENT stock (waste-out); resalable INCREMENT.
      const stockDelta = condition === "damaged" ? -requested : +requested;
      const nextStock = +(available + stockDelta).toFixed(3);
      // Guard against negative stock in the damaged case — this would
      // only happen if inventory has drifted (e.g. concurrent sell-out)
      // but we want a loud failure rather than silent corruption.
      if (nextStock < 0) {
        const e = new Error("Insufficient stock to write off as damaged");
        e.status = 409;
        e.code = "INSUFFICIENT_STOCK";
        e.productId = item.productId;
        e.productName = product.name;
        e.available = available;
        throw e;
      }
      await conn.query(
        "UPDATE products SET stock = ?, updated_at = NOW(3) WHERE id = ?",
        [nextStock, item.productId]
      );
      updatedStock.push({
        id: Number(product.id),
        name: product.name,
        stock: nextStock,
      });

      // Mirror the stock change in stock_movements for the inventory
      // audit trail. type follows the existing ENUM ('in'|'out'|'adjustment'):
      //   resalable → 'in'   reason='return'
      //   damaged   → 'out'  reason='damaged'
      // The retail-returns module owns reason values; PO restocks use
      // 'po-receive', so the historical timeline stays distinct.
      const movementType = condition === "damaged" ? "out" : "in";
      const movementReason =
        condition === "damaged" ? "damaged" : `return:${invoiceNo || "manual"}`;
      const [movementResult] = await conn.query(
        `INSERT INTO stock_movements
           (product_id, product_name, type, quantity, reason, created_by,
            _store_type, _store_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
        [
          Number(product.id),
          product.name,
          movementType,
          // Stock movements store the magnitude; sign is encoded in `type`.
          requested,
          movementReason,
          options.userId || null,
          scope.storeType || null,
          scope.storeId || null,
        ]
      );
      stockMovements.push({
        id: Number(movementResult.insertId || 0),
        productId: Number(product.id),
        productName: product.name,
        type: movementType,
        quantity: requested,
        reason: movementReason,
      });
    }

    // Totals. Computed from the validated per-line breakdown so a tampered
    // client payload can't inflate the refund.
    let subTotal = 0;
    let gstTotal = 0;
    let grandTotal = 0;
    const enrichedItems = items.map((item) => {
      const t = computeLineTotals(item);
      subTotal += t.lineSubtotal;
      gstTotal += t.lineGst;
      grandTotal += t.lineTotal;
      return {
        productId: Number(item.productId),
        productName: item.productName || "",
        originalInvoiceNo: invoiceNo || null,
        originalQuantity: invoice
          ? resolveQty(
              (invoice.items || []).find(
                (line) => Number(line.id) === Number(item.productId)
              ) || item
            )
          : t.qty,
        returnedQuantity: t.qty,
        unitPrice: t.unitPrice,
        lineDiscount: t.lineDiscount,
        lineGst: t.lineGst,
        lineTotal: t.lineTotal,
        condition: item.condition || "resalable",
      };
    });

    // INSERT the header.
    const [insertResult] = await conn.query(
      `INSERT INTO invoice_returns
         (invoice_no, type, scope, refund_method, replacement_invoice_no,
          sub_total, gst_total, grand_total, price_difference, reason, status,
          created_by, _store_type, _store_id, _user_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [
        invoiceNo || null,
        payload.type,
        payload.scope || (enrichedItems.length === (invoice?.items?.length || 0) ? "full" : "partial"),
        payload.refundMethod || "cash",
        clean(payload.replacementInvoiceNo) || null,
        +subTotal.toFixed(2),
        +gstTotal.toFixed(2),
        +grandTotal.toFixed(2),
        num(payload.priceDifference),
        clean(payload.reason) || null,
        // Cashier-submit: directly 'completed' for small amounts. Admin-
        // approval gates are out of scope for v1 — the route layer is
        // the right place to insert that policy if/when we need it.
        "completed",
        options.userId || null,
        scope.storeType || null,
        scope.storeId || null,
        scope.email || null,
      ]
    );
    const returnId = Number(insertResult.insertId || 0);

    // INSERT each per-line row.
    for (const item of enrichedItems) {
      await conn.query(
        `INSERT INTO invoice_return_items
           (return_id, product_id, product_name, original_invoice_no,
            original_quantity, returned_quantity, unit_price,
            line_discount, line_gst, line_total, condition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          returnId,
          item.productId,
          item.productName,
          item.originalInvoiceNo,
          item.originalQuantity,
          item.returnedQuantity,
          item.unitPrice,
          item.lineDiscount,
          item.lineGst,
          item.lineTotal,
          item.condition,
        ]
      );
    }

    // Cash refunds: append a shift_cash_movements row so the close-shift
    // dialog's outflows.refund bucket picks it up and expected_cash drops.
    // The (shift_id, ref_type, ref_id) UNIQUE from migration 013 makes
    // this safe to retry; on a duplicate the existing row wins.
    let cashMovement = null;
    const refundMethod = payload.refundMethod || "cash";
    if (refundMethod === "cash" && options.shift && options.shift.id) {
      const movementAmount = +Math.abs(num(payload.priceDifference || grandTotal)).toFixed(2);
      if (movementAmount > 0) {
        await conn.query(
          `INSERT INTO shift_cash_movements
             (shift_id, type, amount, reason, ref_type, ref_id, created_at)
           VALUES (?, 'cash_out', ?, ?, 'return', ?, NOW(3))
           ON DUPLICATE KEY UPDATE id = id`,
          [
            Number(options.shift.id),
            movementAmount,
            `refund:${invoiceNo || `RET-${returnId}`}`,
            `return-${returnId}`,
          ]
        );
        cashMovement = {
          shiftId: Number(options.shift.id),
          type: "cash_out",
          amount: movementAmount,
          reason: `refund:${invoiceNo || `RET-${returnId}`}`,
          refType: "return",
          refId: `return-${returnId}`,
        };
      }
    }

    // Read back the persisted header so the route layer gets the
    // canonical created_at timestamp.
    const [headerRows] = await conn.query(
      "SELECT * FROM invoice_returns WHERE id = ? LIMIT 1",
      [returnId]
    );
    const header = headerRows && headerRows[0] ? rowToReturn(headerRows[0]) : null;

    return {
      return: header,
      items: enrichedItems.map((item, i) => ({ ...item, id: null, returnId })),
      stockMovements,
      cashMovement,
      updatedStock,
    };
  });
};

module.exports = {
  listByScope,
  listByInvoiceNo,
  findById,
  createWithStockReconciliation,
  _internal: { rowToReturn, rowToReturnItem, validateRequest, computeLineTotals, resolveQty },
};
