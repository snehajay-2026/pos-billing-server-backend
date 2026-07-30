// server/db/queries/shifts.js
//
// `shifts` table: id, user_id, store_type, store_id, status
// ('open'|'closed'), opening_float, closing_cash, expected_cash, notes,
// close_notes, opened_at, closed_at.
//
// `shift_cash_movements` table: id, shift_id, type ('cash_in'|'cash_out'),
// amount, reason, created_at.
//
// Lifecycle:
//   1. open  → POST /api/shifts                  → INSERT INTO shifts (status='open')
//   2. add cash movement → POST /api/shifts/:id/cash-movements → INSERT INTO shift_cash_movements
//   3. close → POST /api/shifts/:id/close       → UPDATE shifts (status='closed', closing_*, closed_at)
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
// expected_cash; client supplies closing_cash via the close endpoint
// which writes both expected_cash and closing_cash (the diff is the
// over/short).

const { query } = require("../pool");

const SHIFT_COLUMNS =
  "id, user_id, store_type, store_id, status, opening_float, closing_cash, expected_cash, notes, close_notes, opened_at, closed_at";

const CASH_MOVE_COLUMNS =
  "id, shift_id, type, amount, reason, created_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToShift = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    userId: row.user_id != null ? Number(row.user_id) : row.user_id,
    storeType: row.store_type || null,
    storeId: row.store_id || null,
    status: row.status || "open",
    openingFloat: toNumber(row.opening_float) ?? 0,
    closingCash: toNumber(row.closing_cash),
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
    `SELECT ${SHIFT_COLUMNS} FROM shifts WHERE ${conds.join(" AND ")}
     ORDER BY opened_at DESC, id DESC LIMIT 1`,
    params
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToShift(rows[0][0]);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${SHIFT_COLUMNS} FROM shifts WHERE id = ? LIMIT 1`,
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
    `SELECT ${SHIFT_COLUMNS} FROM shifts ${where}
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

// summary: shift + movements + reconciliation + duration. Single object the
// frontend can render on a "shift summary" page after close.
const summary = async (shiftId) => {
  const shift = await findById(shiftId);
  if (!shift) return null;
  const [movements, recon] = await Promise.all([
    listCashMovements(shiftId),
    reconciliation(shiftId),
  ]);
  const opened = shift.openedAt ? new Date(shift.openedAt).getTime() : Date.now();
  const closed = shift.closedAt ? new Date(shift.closedAt).getTime() : Date.now();
  const durationMs = Math.max(0, closed - opened);
  return {
    ...shift,
    movements,
    reconciliation: recon,
    durationMs,
  };
};

// === Write paths ============================================================

// open: insert a new 'open' shift. Errors if the same user already has an
// open shift in the same store (use getActiveForUser to check first).
const open = async ({ userId, storeType, storeId, openingFloat = 0, notes = null }) => {
  if (!userId) return null;
  const result = await query(
    `INSERT INTO shifts
       (user_id, store_type, store_id, status, opening_float, notes, opened_at)
     VALUES (?, ?, ?, 'open', ?, ?, NOW(3))`,
    [userId, storeType || null, storeId || null, Number(openingFloat) || 0, notes]
  );
  return findById(result[0].insertId);
};

// addCashMovement: append a cash_in/cash_out to a shift. Refuses if the
// shift is already closed (no point logging movements on a closed shift).
const addCashMovement = async (shiftId, { type, amount, reason = null }) => {
  if (!shiftId || !type) return null;
  if (type !== "cash_in" && type !== "cash_out") return null;
  const shift = await findById(shiftId);
  if (!shift) return null;
  if (shift.status !== "open") return null;
  await query(
    `INSERT INTO shift_cash_movements (shift_id, type, amount, reason, created_at)
     VALUES (?, ?, ?, ?, NOW(3))`,
    [shiftId, type, Number(amount) || 0, reason]
  );
  return reconciliation(shiftId);
};

// close: stamp closing_cash + expected_cash + closed_at, flip status.
// Idempotent — closing twice is a no-op (returns the shift as-is).
const close = async (shiftId, { closingCash, closeNotes = null }) => {
  if (!shiftId) return null;
  const shift = await findById(shiftId);
  if (!shift) return null;
  if (shift.status === "closed") return shift;
  const recon = await reconciliation(shiftId);
  const expected = recon ? recon.expectedCash : shift.openingFloat;
  await query(
    `UPDATE shifts
       SET status = 'closed',
           closing_cash = ?,
           expected_cash = ?,
           close_notes = ?,
           closed_at = NOW(3)
     WHERE id = ?`,
    [Number(closingCash) || 0, expected, closeNotes, shiftId]
  );
  return findById(shiftId);
};

module.exports = {
  // read
  getActiveForUser,
  findById,
  list,
  listCashMovements,
  reconciliation,
  summary,
  // write
  open,
  addCashMovement,
  close,
};
