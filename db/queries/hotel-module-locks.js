// server/db/queries/hotel-module-locks.js
//
// `hotel_module_locks` table: customer_email, module ('lodging'|'dining'|
// 'liveBill'), locked, locked_by, locked_at, updated_at.
//
// One row per (customer, module). Super Owner reads/writes every row;
// every other role reads their own (matched on customer_email = their own).
//
// The frontend's useHotelModuleLock hook treats any error as "unlocked" —
// the server is the source of truth, so silent fail-open is acceptable.
// Likewise getMyHotelLocks returns `{lodging:false, dining:false, liveBill:false}`
// when no row exists for the user.

const { query } = require("../pool");

const VALID_MODULES = new Set(["lodging", "dining", "liveBill"]);

const rowToLock = (row) => {
  if (!row) return null;
  return {
    customerEmail: row.customer_email || null,
    module: row.module || null,
    locked: !!row.locked,
    lockedBy: row.locked_by || null,
    lockedAt: row.locked_at || null,
    updatedAt: row.updated_at || null,
  };
};

// listAll: every (customer, module) pair. Super Owner only.
// Returns flat rows; the frontend groups them by customerEmail client-side.
const listAll = async () => {
  const rows = await query(
    `SELECT customer_email, module, locked, locked_by, locked_at, updated_at
     FROM hotel_module_locks
     ORDER BY customer_email ASC, module ASC`
  );
  return rows[0].map(rowToLock);
};

// getMyLocks: collapsed to one row per module for the given customer.
// Always returns {lodging, dining, liveBill} — false when no row exists.
const getMyLocks = async (customerEmail) => {
  if (!customerEmail) {
    return { lodging: false, dining: false, liveBill: false, customerEmail: null };
  }
  const normalized = String(customerEmail).trim().toLowerCase();
  const rows = await query(
    `SELECT customer_email, module, locked FROM hotel_module_locks
     WHERE customer_email = ?`,
    [normalized]
  );
  const out = { lodging: false, dining: false, liveBill: false, customerEmail: normalized };
  for (const r of rows[0]) {
    if (r.module === "lodging") out.lodging = !!r.locked;
    if (r.module === "dining") out.dining = !!r.locked;
    if (r.module === "liveBill") out.liveBill = !!r.locked;
  }
  return out;
};

// setLock: upsert a (customer, module) row. locked=true stamps
// locked_by + locked_at; locked=false clears them.
// Returns the post-write row.
const setLock = async (customerEmail, module, locked, lockedBy) => {
  if (!customerEmail || !module) return null;
  if (!VALID_MODULES.has(String(module))) return null;
  const normalized = String(customerEmail).trim().toLowerCase();
  const lockedFlag = locked ? 1 : 0;
  const stampedBy = locked ? String(lockedBy || "").trim().toLowerCase() || null : null;
  const stampedAt = locked ? "NOW(3)" : "NULL";

  await query(
    `INSERT INTO hotel_module_locks
       (customer_email, module, locked, locked_by, locked_at, updated_at)
     VALUES (?, ?, ?, ?, ${stampedAt}, NOW(3))
     ON DUPLICATE KEY UPDATE
       locked = VALUES(locked),
       locked_by = VALUES(locked_by),
       locked_at = ${stampedAt},
       updated_at = NOW(3)`,
    [normalized, module, lockedFlag, stampedBy]
  );

  const rows = await query(
    `SELECT customer_email, module, locked, locked_by, locked_at, updated_at
     FROM hotel_module_locks
     WHERE customer_email = ? AND module = ? LIMIT 1`,
    [normalized, module]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToLock(rows[0][0]);
};

module.exports = {
  listAll,
  getMyLocks,
  setLock,
};