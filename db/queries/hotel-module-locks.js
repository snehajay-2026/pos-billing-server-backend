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

// listAllEnriched: Super Owner dashboard — every hotel tenant admin
// joined with their lock state. Includes tenants that have NEVER had a
// lock set (LEFT JOIN on hotel_module_locks) so the dashboard has an
// entry point for the very first Lock click.
//
// Returns one row per (customer, module) with user identity attached —
// the frontend's HotelModuleAccessPage groups these by customerEmail and
// renders them as one row per tenant with three module columns.
//
// Restricted to ADMIN role + store_type='hotel' so the Super Owner only
// sees real hotel tenants, not their cashiers/store-admins or any
// Retail/Laundry/Service user.
const listAllEnriched = async () => {
  const rows = await query(
    `SELECT u.email       AS customer_email,
            u.name        AS name,
            u.store_type  AS store_type,
            u.store_id    AS store_id,
            l.module      AS module,
            l.locked      AS locked,
            l.locked_by   AS locked_by,
            l.locked_at   AS locked_at,
            l.updated_at  AS updated_at
       FROM users u
       LEFT JOIN hotel_module_locks l
              ON l.customer_email = u.email
      WHERE u.store_type = 'hotel' AND u.role = 'ADMIN'
      ORDER BY u.email ASC, l.module ASC`
  );
  return rows[0].map((r) => ({
    customerEmail: r.customer_email,
    name: r.name || null,
    storeType: r.store_type || null,
    storeId: r.store_id || null,
    module: r.module || null, // null when no lock row exists yet
    locked: r.locked != null ? !!r.locked : false,
    lockedBy: r.locked_by || null,
    lockedAt: r.locked_at || null,
    updatedAt: r.updated_at || null,
  }));
};

// getMyLocks: collapsed to one row per module for the given customer.
// Always returns {lodging, dining, liveBill} — false when no row exists.
//
// `ownerEmail` is the tenant's top-level admin email (resolved from
// req.user.owner_email || req.user.root_owner_email || req.user.email
// in the route). It is matched alongside the user's own email so a child
// user (cashier, branch-admin) inherits the lock set against their admin.
// For the admin themselves ownerEmail === customerEmail and the IN-list
// collapses to a single match.
const getMyLocks = async (customerEmail, ownerEmail) => {
  if (!customerEmail) {
    return { lodging: false, dining: false, liveBill: false, customerEmail: null };
  }
  const normalized = String(customerEmail).trim().toLowerCase();
  const normalizedOwner = ownerEmail
    ? String(ownerEmail).trim().toLowerCase()
    : normalized;
  // When the user IS the tenant admin (no separate owner), the IN clause
  // collapses to a single value — passing the same email twice is
  // harmless to MySQL and keeps the prepared-statement param list sane.
  const params =
    normalizedOwner === normalized ? [normalized] : [normalized, normalizedOwner];
  const placeholders = params.map(() => "?").join(", ");
  const rows = await query(
    `SELECT customer_email, module, locked FROM hotel_module_locks
     WHERE customer_email IN (${placeholders})`,
    params
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
  listAllEnriched,
  getMyLocks,
  setLock,
};