// server/db/queries/laundry.js
//
// Two unrelated tables:
//
// 1. `laundry_token_counters` — daily-rolling bag tag counter, one row
//    per (day, storeType, storeId). Idempotent: posting the same (value,
//    day) is a no-op. Posting a higher value advances the counter.
//
// 2. `laundry_ledger` — append-only stock movements scoped to a store.
//    Used for the consumables ledger component on the laundry page.
//
// Both are scoped by storeType/storeId when present (SUPER_OWNER sees
// everything by passing nulls).

const { query } = require("../pool");

const COUNTER_COLUMNS = "day, value, _store_type, _store_id, updated_at";
const LEDGER_COLUMNS = "id, product_name, delta, reason, at, _store_type, _store_id, _user_email, created_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Format a JS Date (or "today" if omitted) as a YYYY-MM-DD string for the
// primary key.
const toDay = (d) => {
  const date = d ? new Date(d) : new Date();
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const scopeKey = (storeType, storeId) => ({
  storeType: String(storeType || ""),
  storeId: String(storeId || ""),
});

// === Token counter =========================================================

// getCounter: most-recent counter row for the given (storeType, storeId).
// If `day` is omitted, returns today's counter (creating it on first read
// with value=0 if missing).
const getCounter = async ({ storeType, storeId, day } = {}) => {
  const d = toDay(day);
  const key = scopeKey(storeType, storeId);
  const rows = await query(
    `SELECT ${COUNTER_COLUMNS}
     FROM laundry_token_counters
     WHERE day = ? AND _store_type = ? AND _store_id = ?
     LIMIT 1`,
    [d, key.storeType, key.storeId]
  );
  if (!rows[0] || rows[0].length === 0) {
    return { day: d, value: 0, _storeType: key.storeType, _storeId: key.storeId };
  }
  const r = rows[0][0];
  return {
    day: toDay(r.day),
    value: Number(r.value) || 0,
    _storeType: r._store_type,
    _storeId: r._store_id,
  };
};

// setCounter: upsert a counter row. If value > existing, advance; if
// equal, no-op; if lower, also no-op (we never move backwards — that
// would let two clients hand out the same token).
const setCounter = async ({ storeType, storeId, day, value }) => {
  const d = toDay(day);
  const num = Math.max(0, Math.floor(Number(value) || 0));
  const key = scopeKey(storeType, storeId);

  // Read current (if any) to gate the upsert.
  const existing = await query(
    `SELECT value FROM laundry_token_counters
     WHERE day = ? AND _store_type = ? AND _store_id = ? LIMIT 1`,
    [d, key.storeType, key.storeId]
  );
  const current = existing[0] && existing[0][0] ? Number(existing[0][0].value) || 0 : 0;
  const finalValue = Math.max(current, num);

  await query(
    `INSERT INTO laundry_token_counters (day, value, _store_type, _store_id, updated_at)
     VALUES (?, ?, ?, ?, NOW(3))
     ON DUPLICATE KEY UPDATE value = GREATEST(value, VALUES(value)), updated_at = NOW(3)`,
    [d, finalValue, key.storeType, key.storeId]
  );

  return getCounter({ storeType, storeId, day: d });
};

// === Ledger =================================================================

const listLedger = async ({ storeType, storeId, limit = 200 } = {}) => {
  const key = scopeKey(storeType, storeId);
  const conds = ["1=1"];
  const params = [];
  if (key.storeType) {
    conds.push("_store_type = ?");
    params.push(key.storeType);
  }
  if (key.storeId) {
    conds.push("_store_id = ?");
    params.push(key.storeId);
  }
  const rows = await query(
    `SELECT ${LEDGER_COLUMNS} FROM laundry_ledger
     WHERE ${conds.join(" AND ")}
     ORDER BY COALESCE(at, created_at) DESC, id DESC
     LIMIT ?`,
    [...params, Math.max(1, Math.min(Number(limit) || 200, 1000))]
  );
  return rows[0].map((r) => ({
    id: r.id != null ? Number(r.id) : r.id,
    productName: r.product_name || null,
    delta: toNumber(r.delta) ?? 0,
    reason: r.reason || null,
    at: r.at || r.created_at || null,
    _storeType: r._store_type || null,
    _storeId: r._store_id || null,
    _userEmail: r._user_email || null,
    createdAt: r.created_at || null,
  }));
};

const addLedgerEntry = async ({
  productName,
  delta,
  reason = null,
  at = null,
  storeType,
  storeId,
  userEmail,
}) => {
  if (!productName) return null;
  const num = Number(delta);
  if (!Number.isFinite(num)) return null;
  const key = scopeKey(storeType, storeId);
  const result = await query(
    `INSERT INTO laundry_ledger
       (product_name, delta, reason, at, _store_type, _store_id, _user_email, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [productName, num, reason, at, key.storeType, key.storeId, userEmail || null]
  );
  return findLedgerEntryById(result[0].insertId);
};

const findLedgerEntryById = async (id) => {
  const rows = await query(
    `SELECT ${LEDGER_COLUMNS} FROM laundry_ledger WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  const r = rows[0][0];
  return {
    id: Number(r.id),
    productName: r.product_name || null,
    delta: toNumber(r.delta) ?? 0,
    reason: r.reason || null,
    at: r.at || r.created_at || null,
    _storeType: r._store_type || null,
    _storeId: r._store_id || null,
    _userEmail: r._user_email || null,
    createdAt: r.created_at || null,
  };
};

const clearLedger = async ({ storeType, storeId } = {}) => {
  const key = scopeKey(storeType, storeId);
  const conds = [];
  const params = [];
  if (key.storeType) {
    conds.push("_store_type = ?");
    params.push(key.storeType);
  }
  if (key.storeId) {
    conds.push("_store_id = ?");
    params.push(key.storeId);
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const result = await query(`DELETE FROM laundry_ledger ${where}`, params);
  return result[0].affectedRows;
};

module.exports = {
  getCounter,
  setCounter,
  listLedger,
  addLedgerEntry,
  findLedgerEntryById,
  clearLedger,
};