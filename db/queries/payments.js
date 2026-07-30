// server/db/queries/payments.js
//
// `payment_intents` table: id (VARCHAR PK — client-generated), invoice_no,
// amount, method ('cash'|'upi'|'card'|'other'), status
// ('pending'|'paid'|'failed'|'cancelled'), note, created_by (user id),
// _store_type, _store_id, created_at, updated_at.
//
// Lifecycle:
//   1. createPaymentIntent        -> INSERT (status='pending')
//   2. (optional) webhook flips   -> UPDATE (status='paid'|'failed')  — server-side, not exposed here
//   3. mark-paid / mark-failed    -> UPDATE (status=...) — frontend-facing manual confirm
//   4. simulate-payment           -> dev-only flip to 'paid' for testing without a real gateway
//
// Payment "methods" is a static list — no DB table needed; the route
// returns the supported methods from a constant.

const { query } = require("../pool");

const VALID_METHODS = new Set(["cash", "upi", "card", "other"]);
const VALID_STATUSES = new Set(["pending", "paid", "failed", "cancelled"]);

const COLUMNS =
  "id, invoice_no, amount, method, status, note, created_by, _store_type, _store_id, created_at, updated_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToIntent = (row) => {
  if (!row) return null;
  return {
    id: row.id || null,
    invoiceNo: row.invoice_no || null,
    amount: toNumber(row.amount),
    method: row.method || null,
    status: row.status || "pending",
    note: row.note || null,
    createdBy: row.created_by != null ? Number(row.created_by) : row.created_by,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

// === Payment methods (static; no DB) =======================================

const PAYMENT_METHODS = [
  { id: "cash", label: "Cash", enabled: true },
  { id: "upi", label: "UPI / QR", enabled: true },
  { id: "card", label: "Card", enabled: true },
  { id: "other", label: "Other", enabled: true },
];

const listMethods = async () => PAYMENT_METHODS;

// === Payment intents =======================================================

const create = async ({
  id,           // client-generated string (uuid-like)
  amount,
  method = "upi",
  invoiceNo = null,
  note = null,
  createdBy = null,
  storeType = null,
  storeId = null,
}) => {
  if (!id || !amount) return null;
  if (!VALID_METHODS.has(String(method))) return null;
  try {
    await query(
      `INSERT INTO payment_intents
         (id, invoice_no, amount, method, status, note, created_by, _store_type, _store_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, NOW(3), NOW(3))`,
      [id, invoiceNo, Number(amount) || 0, method, note, createdBy, storeType, storeId]
    );
  } catch (err) {
    // Duplicate id (client retry) — return existing instead of erroring.
    if (err && err.code === "ER_DUP_ENTRY") return findById(id);
    throw err;
  }
  return findById(id);
};

const findById = async (id) => {
  if (!id) return null;
  const rows = await query(
    `SELECT ${COLUMNS} FROM payment_intents WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToIntent(rows[0][0]);
};

const setStatus = async (id, status, note = null) => {
  if (!id || !status) return null;
  if (!VALID_STATUSES.has(String(status))) return null;
  await query(
    `UPDATE payment_intents
       SET status = ?, note = COALESCE(?, note), updated_at = NOW(3)
     WHERE id = ?`,
    [status, note, id]
  );
  return findById(id);
};

module.exports = {
  listMethods,
  create,
  findById,
  setStatus,
  // exported for tests
  PAYMENT_METHODS,
};