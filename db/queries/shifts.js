// server/db/queries/shifts.js
//
// `shifts` table: id, user_id, store_type, store_id, branch_name,
// customer_email, opened_by_user_id, closed_by_user_id, status
// ('open'|'closed'), opening_float, closing_cash, total_sales, variance,
// expected_cash, notes, close_notes, opened_at, closed_at.
//
// `shift_cash_movements` table: id, shift_id, type ('cash_in'|'cash_out'),
// amount, reason, ref_type, ref_id, created_at.
//
// Lifecycle:
//   1. open  → POST /api/shifts                  → INSERT INTO shifts (status='open')
//   2. cash sale → POST /api/shifts/:id/cash-movements
//      OR invoice POST stamps `invoices.shift_id` so the summary
//      endpoint can sum the row → bills/totals are derived from invoices.
//   3. close → POST /api/shifts/:id/close       → UPDATE shifts (status='closed', closing_*, total_sales, variance, closed_at)
//
// "Active shift" = the latest shifts row for a (user, store) pair whose
// status='open'. The frontend's useShiftGate hook polls this on every
// page mount.
//
// Scope rules:
//   - CASHIER / BRANCH_ADMIN: can only see their own shifts
//   - STORE_ADMIN / ADMIN:    all shifts for their store
//   - SUPER_OWNER:            every shift (unscoped)
//
// Reconciliation summary (read-only): the GET /api/shifts/:id/summary
// route assembles opening_float + sum(cash_in) - sum(cash_out) as
// expected_cash AND aggregates the invoices linked to this shift for
// total sales / per-method collections / GST / discount / bill count.

const { query, withTransaction } = require("../pool");

const SHIFT_COLUMNS =
  "id, user_id, store_type, store_id, branch_name, customer_email, opened_by_user_id, closed_by_user_id, status, opening_float, closing_cash, total_sales, variance, expected_cash, notes, close_notes, opened_at, closed_at";

// Optional JOIN columns for the read paths that surface openedBy /
// closedBy user info to the frontend's ShiftsPage. Adding these as a
// separate constant lets the inner reconciliation queries keep the
// narrow column set (the JOIN doesn't change the SUM/GROUP BY math).
//
// NOTE: the JOIN has been disabled — `LEFT JOIN users opener / closer`
// against the TiDB Cloud `users` table was hanging every read at the
// exact 30s curl/Express timeout in production (Sep 2026). The likely
// cause is TiDB's planner picking a degenerate hash-join path for the
// nullable FK columns on `shifts.opened_by_user_id` / `closed_by_user_id`.
// The frontend's ShiftsPage still has a graceful `—` fallback for the
// missing opener/closer info (rowToShift returns null for openedByUser
// / closedByUser when the JOIN columns are absent). Re-introducing the
// JOIN — or a per-shift user lookup — is tracked as a follow-up once
// the TiDB hang root-cause is identified.
const SHIFT_COLUMNS_WITH_USERS = SHIFT_COLUMNS;

// NOTE: `ref_type` / `ref_id` were planned but never migrated into the
// `shift_cash_movements` table (see migration 012 — it adds shift_id,
// branch_name, customer_email, etc. but not these two). Selecting them
// against the live schema throws "Unknown column 'ref_type' in 'field
// list'", which Express propagates as a 30s connection timeout on the
// `GET /api/shifts/:id/summary` and `GET/POST /api/shifts/:id/cash-movements`
// routes (TiDB Cloud, Sep 2026). Selecting only the columns that actually
// exist; the route handlers already pass `refType` / `refId` as INSERT
// params but those INSERTs would also fail today — they are accepted by
// the route layer but the row never lands. Restoring those columns is a
// separate migration, tracked as a follow-up.
const CASH_MOVE_COLUMNS =
  "id, shift_id, type, amount, reason, created_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToShift = (row) => {
  if (!row) return null;
  // Build the nested openedByUser / closedByUser objects only when the
  // JOIN columns are present (the read paths that use them). Without
  // the JOIN we return `null` so the frontend's `${openedByUser?.email
  // || "—"}` fallback still renders cleanly.
  const openedByUser =
    row.opened_by_email != null || row.opened_by_role != null || row.opened_by_name != null
      ? {
          id: row.opened_by_user_id != null ? Number(row.opened_by_user_id) : row.opened_by_user_id,
          email: row.opened_by_email || null,
          role: row.opened_by_role || null,
          name: row.opened_by_name || null,
        }
      : null;
  const closedByUser =
    row.closed_by_email != null || row.closed_by_role != null || row.closed_by_name != null
      ? {
          id: row.closed_by_user_id != null ? Number(row.closed_by_user_id) : row.closed_by_user_id,
          email: row.closed_by_email || null,
          role: row.closed_by_role || null,
          name: row.closed_by_name || null,
        }
      : null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    userId: row.user_id != null ? Number(row.user_id) : row.user_id,
    storeType: row.store_type || null,
    storeId: row.store_id || null,
    branchName: row.branch_name || null,
    customerEmail: row.customer_email || null,
    openedByUserId: row.opened_by_user_id != null ? Number(row.opened_by_user_id) : row.opened_by_user_id,
    closedByUserId: row.closed_by_user_id != null ? Number(row.closed_by_user_id) : row.closed_by_user_id,
    // Nested objects — the frontend's ShiftsPage reads these. The flat
    // `openedBy` / `closedBy` strings below are legacy fallbacks for
    // any older callers that read the columns directly.
    openedByUser,
    closedByUser,
    openedBy: row.opened_by_email || null,
    closedBy: row.closed_by_email || null,
    status: row.status || "open",
    openingFloat: toNumber(row.opening_float) ?? 0,
    closingCash: toNumber(row.closing_cash),
    totalSales: toNumber(row.total_sales),
    variance: toNumber(row.variance),
    expectedCash: toNumber(row.expected_cash),
    notes: row.notes || null,
    closeNotes: row.close_notes || null,
    openedAt: row.opened_at || null,
    closedAt: row.closed_at || null,
  };
};

const rowToCashMovement = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    shiftId: row.shift_id != null ? Number(row.shift_id) : row.shift_id,
    type: row.type || null,
    amount: toNumber(row.amount) ?? 0,
    reason: row.reason || null,
    refType: row.ref_type || null,
    refId: row.ref_id || null,
    createdAt: row.created_at || null,
  };
};

// === Read paths =============================================================

// getActiveForUser: most-recent 'open' shift for a (user, storeType, storeId).
// Returns null if there is none. This is what the frontend's useShiftGate
// hook polls on every page mount.
const getActiveForUser = async (userId, storeType, storeId) => {
  if (!userId) return null;
  const conds = ["user_id = ?", "status = 'open'"];
  const params = [userId];
  if (storeType) {
    conds.push("store_type = ?");
    params.push(String(storeType));
  }
  if (storeId) {
    conds.push("store_id = ?");
    params.push(String(storeId));
  }
  const rows = await query(
    `SELECT ${SHIFT_COLUMNS_WITH_USERS}
       FROM shifts
       WHERE ${conds.join(" AND ")}
       ORDER BY opened_at DESC, id DESC LIMIT 1`,
    params
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToShift(rows[0][0]);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${SHIFT_COLUMNS_WITH_USERS}
       FROM shifts
       WHERE shifts.id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToShift(rows[0][0]);
};

// list: filtered by scope + optional filters (status, userId, since, until).
// Super Owner sees everything; other roles get a storeType/storeId filter;
// an explicit userId filter narrows further.
const list = async (scope, filters = {}) => {
  const conds = [];
  const params = [];
  if (scope.storeType) {
    conds.push("store_type = ?");
    params.push(String(scope.storeType));
  }
  if (scope.storeId) {
    conds.push("store_id = ?");
    params.push(String(scope.storeId));
  }
  if (filters.userId) {
    conds.push("user_id = ?");
    params.push(filters.userId);
  }
  if (filters.status) {
    conds.push("status = ?");
    params.push(String(filters.status));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await query(
    `SELECT ${SHIFT_COLUMNS_WITH_USERS}
       FROM shifts
       ${where}
       ORDER BY opened_at DESC, id DESC
       LIMIT 200`,
    params
  );
  return rows[0].map(rowToShift);
};

const listCashMovements = async (shiftId) => {
  if (!shiftId) return [];
  const rows = await query(
    `SELECT ${CASH_MOVE_COLUMNS} FROM shift_cash_movements
     WHERE shift_id = ? ORDER BY created_at ASC, id ASC`,
    [shiftId]
  );
  return rows[0].map(rowToCashMovement);
};

// reconciliation: compute expected cash (opening_float + cash_in - cash_out).
// Done in SQL so the answer is consistent with what's been persisted
// (no race with cash movements being added concurrently).
const reconciliation = async (shiftId) => {
  if (!shiftId) return null;
  const rows = await query(
    `SELECT
       COALESCE(s.opening_float, 0) AS opening_float,
       COALESCE(SUM(CASE WHEN m.type = 'cash_in'  THEN m.amount ELSE 0 END), 0) AS cash_in,
       COALESCE(SUM(CASE WHEN m.type = 'cash_out' THEN m.amount ELSE 0 END), 0) AS cash_out
     FROM shifts s
     LEFT JOIN shift_cash_movements m ON m.shift_id = s.id
     WHERE s.id = ?
     GROUP BY s.id, s.opening_float`,
    [shiftId]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  const r = rows[0][0];
  const openingFloat = toNumber(r.opening_float) ?? 0;
  const cashIn = toNumber(r.cash_in) ?? 0;
  const cashOut = toNumber(r.cash_out) ?? 0;
  const expected = openingFloat + cashIn - cashOut;
  return {
    openingFloat,
    cashIn,
    cashOut,
    expectedCash: expected,
  };
};

// === Invoice aggregation ====================================================
//
// The shift summary endpoint derives totals from the invoices linked to
// this shift via invoices.shift_id (added by migration 012). Payment
// method is read from invoices.payment_mode (the legacy `cash` | `upi`
// | `card` | `other` taxonomy). Returns zeros when no invoices are
// linked yet so the close-shift dialog can render before any sale.
//
// NOTE: the previous version of this query used
//   SUM(i.sub_total) OVER (PARTITION BY i.invoice_no)
// inside a CASE branch to resolve the percent-discount base. That's
// equivalent to referencing `i.sub_total` directly (it's a column on the
// same row being aggregated), but the window-function-in-aggregate
// pattern trips TiDB Cloud's planner into a degenerate path that hangs
// for the full query timeout (Sep 2026, observed against production
// Render backend). Same root cause as the `LEFT JOIN users` hang
// removed from findById earlier. Replaced with a plain column ref.
const invoiceTotals = async (shiftId) => {
  if (!shiftId) {
    return {
      bills: 0,
      sales: 0,
      discount: 0,
      gst: 0,
      collections: { cash: 0, upi: 0, card: 0, other: 0 },
    };
  }
  const rows = await query(
    `SELECT
       COUNT(*) AS bills,
       COALESCE(SUM(grand_total), 0) AS sales,
       COALESCE(SUM(gst_total), 0) AS gst,
       COALESCE(SUM(
         CASE
           WHEN discount IS NULL THEN 0
           WHEN JSON_TYPE(discount) = 'OBJECT' AND JSON_EXTRACT(discount, '$.value') IS NOT NULL THEN
             CASE JSON_EXTRACT(discount, '$.type')
               WHEN 'flat'    THEN CAST(JSON_EXTRACT(discount, '$.value') AS DECIMAL(12,2))
               WHEN 'percent' THEN CAST(COALESCE(i.sub_total, 0) * JSON_EXTRACT(discount, '$.value') / 100 AS DECIMAL(12,2))
               ELSE 0
             END
           ELSE 0
         END
       ), 0) AS discount,
       COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'cash' THEN grand_total ELSE 0 END), 0) AS cash,
       COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'upi'  THEN grand_total ELSE 0 END), 0) AS upi,
       COALESCE(SUM(CASE WHEN LOWER(payment_mode) = 'card' THEN grand_total ELSE 0 END), 0) AS card,
       COALESCE(SUM(CASE WHEN LOWER(payment_mode) NOT IN ('cash','upi','card') OR payment_mode IS NULL THEN grand_total ELSE 0 END), 0) AS other
     FROM invoices i
     WHERE shift_id = ?`,
    [shiftId]
  );
  const r = rows[0][0];
  return {
    bills: Number(r.bills || 0),
    sales: Number(r.sales || 0),
    gst: Number(r.gst || 0),
    discount: Number(r.discount || 0),
    collections: {
      cash: Number(r.cash || 0),
      upi: Number(r.upi || 0),
      card: Number(r.card || 0),
      other: Number(r.other || 0),
    },
  };
};

// summary: shift + movements + reconciliation + invoice totals + duration.
// The frontend renders this object verbatim on the close-shift dialog
// (CloseShiftDialog.jsx reads totals.bills / totals.sales / sales.cash /
// outflows.refund etc.), so the shape is part of the public contract.
//
// Shape (stable; do not remove keys without coordinating with the
// frontend's CloseShiftDialog + ShiftsPage):
//   {
//     ...shift,                  // shift row fields (id, status, opening_float, etc.)
//     movements: [...],          // shift_cash_movements rows
//     reconciliation: { openingFloat, cashIn, cashOut, expectedCash },
//     totals: { bills, sales, gst, discount },
//     sales: { cash, upi, card, other },  // derived from invoices.payment_mode
//     outflows: { refund, drop, paidOut }, // derived from movements
//     collections: { paidIn, pickup },     // derived from movements
//     opening: { float },
//     closing: { expected, counted? },
//     durationMs,
//   }
const summary = async (shiftId) => {
  const shift = await findById(shiftId);
  if (!shift) return null;
  const [movements, recon, totals] = await Promise.all([
    listCashMovements(shiftId),
    reconciliation(shiftId),
    invoiceTotals(shiftId),
  ]);

  // Bucket the cash_movements ledger rows into the buckets the close
  // dialog renders. Today the schema's `type` column is ENUM
  // ('cash_in'|'cash_out') and the frontend treats every 'cash_out'
  // row as a refund / drop / paidOut equally. We split by the `reason`
  // text prefix so existing rows still bucket correctly:
  //   "refund:" → outflows.refund
  //   "drop:"   → outflows.drop
  //   "paid_out:" → outflows.paidOut
  //   anything else with type='cash_out' → outflows.paidOut (fallback)
  // Future rows can use richer types via the addCashMovement route once
  // the schema is widened.
  let refund = 0;
  let drop = 0;
  let paidOut = 0;
  let paidIn = 0;
  let pickup = 0;
  for (const m of movements) {
    const reason = String(m.reason || "").toLowerCase();
    const isOut = m.type === "cash_out";
    if (isOut) {
      if (reason.startsWith("refund")) refund += Math.abs(m.amount);
      else if (reason.startsWith("drop")) drop += Math.abs(m.amount);
      else paidOut += Math.abs(m.amount);
    } else {
      if (reason.startsWith("pickup")) pickup += Math.abs(m.amount);
      else paidIn += Math.abs(m.amount);
    }
  }

  const opened = shift.openedAt ? new Date(shift.openedAt).getTime() : Date.now();
  const closed = shift.closedAt ? new Date(shift.closedAt).getTime() : Date.now();
  const durationMs = Math.max(0, closed - opened);
  const expected = recon ? recon.expectedCash : shift.openingFloat;
  return {
    ...shift,
    movements,
    reconciliation: recon,
    totals,
    sales: totals.collections,
    outflows: { refund, drop, paidOut },
    collections: { paidIn, pickup },
    opening: { float: shift.openingFloat },
    closing: { expected },
    durationMs,
  };
};

// recalculateTotals: refresh shifts.total_sales from the invoices linked
// to this shift. Called from the invoice-save path (so totals stay in
// sync as sales land) and from the close path (final cache before flip
// to status='closed').
const recalculateTotals = async (shiftId, conn) => {
  if (!shiftId) return null;
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  const [rows] = await exec(
    `SELECT COALESCE(SUM(grand_total), 0) AS total_sales
       FROM invoices WHERE shift_id = ?`,
    [shiftId]
  );
  const totalSales = Number((rows && rows[0] && rows[0].total_sales) || 0);
  await exec(
    `UPDATE shifts SET total_sales = ? WHERE id = ?`,
    [totalSales, shiftId]
  );
  return totalSales;
};

// === Write paths ============================================================

// open: insert a new 'open' shift. Errors if the same user already has an
// open shift in the same store (use getActiveForUser to check first).
const open = async ({
  userId,
  storeType,
  storeId,
  branchName = null,
  customerEmail = null,
  openingFloat = 0,
  notes = null,
}) => {
  if (!userId) return null;
  const result = await query(
    `INSERT INTO shifts
       (user_id, store_type, store_id, branch_name, customer_email,
        opened_by_user_id, status, opening_float, notes, opened_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, NOW(3))`,
    [
      userId,
      storeType || null,
      storeId || null,
      branchName || null,
      customerEmail || null,
      userId,
      Number(openingFloat) || 0,
      notes,
    ]
  );
  return findById(result[0].insertId);
};

// addCashMovement: append a cash_in/cash_out to a shift. Refuses if the
// shift is already closed (no point logging movements on a closed shift).
const addCashMovement = async (
  shiftId,
  { type, amount, reason = null, refType = null, refId = null }
) => {
  if (!shiftId || !type) return null;
  if (type !== "cash_in" && type !== "cash_out") return null;
  const shift = await findById(shiftId);
  if (!shift) return null;
  if (shift.status !== "open") return null;
  await query(
    `INSERT INTO shift_cash_movements
       (shift_id, type, amount, reason, created_at)
     VALUES (?, ?, ?, ?, NOW(3))`,
    [shiftId, type, Number(amount) || 0, reason]
  );
  return reconciliation(shiftId);
};

// close: stamp closing_cash + expected_cash + total_sales + variance +
// closed_at + closed_by_user_id, flip status. Idempotent — closing
// twice is a no-op (returns the shift as-is).
//
// enforceZeroVariance (default true): when true, refuse the close with a
// structured error { code: "CASH_VARIANCE_NOT_ZERO", variance, expected,
// closingCash } if the counted cash doesn't match the expected physical
// cash to the cent. This is the server-authoritative side of the
// "difference must be ₹0" rule. The route layer turns the thrown error
// into a 409 response. Admin-script callers (rare, e.g. fixing a stuck
// shift during reconciliation) can pass enforceZeroVariance=false to
// bypass the check explicitly. Without this check, a cashier could
// POST closingCash=100 when expected=10000 and the row would silently
// land with variance=-9900, hiding a real reconciliation gap.
const close = async (
  shiftId,
  {
    closingCash,
    closeNotes = null,
    closedByUserId = null,
    enforceZeroVariance = true,
  }
) => {
  if (!shiftId) return null;
  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT ${SHIFT_COLUMNS} FROM shifts WHERE id = ? LIMIT 1`,
      [shiftId]
    );
    if (!rows || rows.length === 0) return null;
    const shift = rowToShift(rows[0]);
    if (shift.status === "closed") return shift;

    // Refresh totals from invoices in the same transaction so a sale
    // that landed milliseconds before close isn't lost.
    const [totalsRows] = await conn.query(
      `SELECT COALESCE(SUM(grand_total), 0) AS total_sales
         FROM invoices WHERE shift_id = ?`,
      [shiftId]
    );
    const totalSales = Number((totalsRows && totalsRows[0] && totalsRows[0].total_sales) || 0);

    const recon = await reconciliation(shiftId);
    const expected = recon ? recon.expectedCash : shift.openingFloat;
    const counted = Number(closingCash || 0);
    const variance = +(counted - Number(expected || 0)).toFixed(2);

    // Server-side zero-difference rule.
    if (enforceZeroVariance && Math.abs(variance) > 0.005) {
      const err = new Error(
        `Shift cannot be closed — cash difference must be ₹0.00 ` +
          `(counted ${counted.toFixed(2)} vs expected ${Number(expected || 0).toFixed(
            2
          )}, variance ${variance.toFixed(2)}).`
      );
      err.code = "CASH_VARIANCE_NOT_ZERO";
      err.variance = variance;
      err.expected = Number(expected || 0);
      err.closingCash = counted;
      err.status = 409;
      throw err;
    }

    await conn.query(
      `UPDATE shifts
         SET status = 'closed',
             closing_cash = ?,
             total_sales = ?,
             variance = ?,
             expected_cash = ?,
             close_notes = ?,
             closed_by_user_id = COALESCE(?, user_id),
             closed_at = NOW(3)
       WHERE id = ?`,
      [
        Number(closingCash) || 0,
        totalSales,
        variance,
        expected,
        closeNotes,
        closedByUserId,
        shiftId,
      ]
    );
    return findById(shiftId);
  });
};

module.exports = {
  // read
  getActiveForUser,
  findById,
  list,
  listCashMovements,
  reconciliation,
  summary,
  invoiceTotals,
  // write
  open,
  addCashMovement,
  recalculateTotals,
  close,
};
