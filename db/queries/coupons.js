// server/db/queries/coupons.js
//
// All SQL touching the `hotel_coupons` table lives here. Powers the
// Hotel Store discount feature (see migration `010_hotel_coupons.sql`
// for the schema and `server/lib/publicInvoice.js` for the public-side
// sanitization).
//
// Three call-sites:
//   - GET /api/hotel/coupons/:code  → `findActiveByCode(code, scope)`
//     Cashier-facing coupon validation. Resolves the most-specific
//     active coupon in scope (store-scoped rows win over global ones).
//
//   - GET /api/hotel/coupons         → `listScoped(scope)`
//     Settings UI list — all coupons in scope, active first.
//
//   - POST /api/hotel/coupons        → `create(data)`
//     Settings UI create — owner-only (gated in routes).
//
//   - PATCH /api/hotel/coupons/:id   → `update(id, patch, scope)`
//     Settings UI update (incl. soft-delete via `active = 0`).
//
// Scope shape: `{ storeType, storeId, userEmail }`. A NULL scope
// column on a row is treated as a wildcard match (the
// `(_store_type IS NULL OR _store_type = ?)` shape) so a single row
// can be visible to multiple scopes.

const { query } = require("../pool");

// Resolve a coupon by its exact code, filtered by scope. Returns the
// most-specific active row in scope (i.e. a row with all three
// storeType/storeId/userEmail columns set is preferred over a row
// with NULL wildcards, so owners can override a wildcard with a
// scoped rule without collisions).
//
// Date window: `valid_from <= NOW() <= valid_until` is applied when
// those columns are non-NULL. NULL on either side means "no bound".
//
// `LIMIT 1` + the `ORDER BY (_store_type IS NOT NULL) DESC` gives us
// the most-specific row. The OR-with-NULL comparison lets rows with
// NULL scope columns act as fall-throughs.
exports.findActiveByCode = async (code, scope) => {
  if (!code) return null;
  const s = scope || {};
  // COALESCE(?, '') = '' handles the cashier-side unauthenticated route:
  // when no user email is known, the filter is skipped entirely so any
  // active coupon in the store can match. `_user_email = NULL` would be
  // the obvious fix but it's always false in SQL — COALESCE is the
  // portable workaround. The userEmail param is passed twice: once for
  // the empty-check and once for the equality fallback.
  const [rows] = await query(
    `SELECT *
       FROM hotel_coupons
       WHERE code = ?
         AND active = 1
         AND (_store_type IS NULL OR _store_type = ?)
         AND (_store_id   IS NULL OR _store_id   = ?)
         AND (COALESCE(?, '') = '' OR _user_email IS NULL OR _user_email = ?)
         AND (valid_from  IS NULL OR valid_from  <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
       ORDER BY (_store_type IS NOT NULL) DESC,
                (_store_id   IS NOT NULL) DESC,
                (_user_email IS NOT NULL) DESC
       LIMIT 1`,
    [
      String(code).trim(),
      s.storeType || null,
      s.storeId || null,
      s.userEmail || null,
      s.userEmail || null,
    ]
  );
  return (rows && rows[0]) || null;
};

// List every coupon in scope (active first, then by code). Powers the
// Settings UI.
exports.listScoped = async (scope) => {
  const s = scope || {};
  const [rows] = await query(
    `SELECT *
       FROM hotel_coupons
       WHERE (_store_type IS NULL OR _store_type = ?)
         AND (_store_id   IS NULL OR _store_id   = ?)
         AND (_user_email IS NULL OR _user_email = ?)
       ORDER BY active DESC, code ASC`,
    [s.storeType || null, s.storeId || null, s.userEmail || null]
  );
  return rows || [];
};

// Create a new coupon row. Caller is responsible for upper-casing
// the code (we store it as-is but the validator matches case-
// insensitively via the UPPER() comparison in `findActiveByCode`'s
// WHERE clause — actually we just match exact code today, so the
// upper-casing is a UX concern enforced in the Settings UI).
// All scope columns are NULL-able; pass an explicit scope to lock a
// coupon to a particular store/owner.
exports.create = async (data) => {
  if (!data || !data.code) throw new Error("coupon code is required");
  const code = String(data.code).trim();
  if (!code) throw new Error("coupon code is required");
  const value = Number(data.value);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("coupon value must be a non-negative number");
  }
  const usageLimit =
    data.usageLimit == null || data.usageLimit === ""
      ? null
      : Number(data.usageLimit);
  if (usageLimit != null && (!Number.isInteger(usageLimit) || usageLimit < 1)) {
    throw new Error("usageLimit must be a positive integer or null");
  }
  const [r] = await query(
    `INSERT INTO hotel_coupons
       (code, type, value, min_subtotal, valid_from, valid_until,
        active, usage_limit, usage_count,
        _store_type, _store_id, _user_email)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code,
      "percent",
      value,
      data.minSubtotal != null && data.minSubtotal !== ""
        ? Number(data.minSubtotal)
        : null,
      data.validFrom || null,
      data.validUntil || null,
      data.active === false ? 0 : 1,
      usageLimit,
      0,
      data._storeType || null,
      data._storeId || null,
      data._userEmail || null,
    ]
  );
  return exports.findById(r.insertId);
};

// Whitelist-update: refuse to overwrite scope columns from a client
// payload (the `_storeType` etc. on the patch would be ignored).
// `active = 0` is the soft-delete the Settings UI uses.
exports.update = async (id, patch, scope) => {
  const allow = ["value", "minSubtotal", "validFrom", "validUntil", "active", "usageLimit"];
  const sets = [];
  const args = [];
  for (const k of allow) {
    if (!Object.prototype.hasOwnProperty.call(patch || {}, k)) continue;
    let v = patch[k];
    if (k === "value") {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) continue;
    } else if (k === "minSubtotal") {
      v = v == null || v === "" ? null : Number(v);
    } else if (k === "active") {
      v = v ? 1 : 0;
    } else if (k === "usageLimit") {
      // Map camelCase input → snake_case DB column. usageLimit (single
      // cap) is owner-tunable; usageCount is server-bumped only.
      v = v == null || v === "" ? null : Number(v);
      if (v != null && (!Number.isInteger(v) || v < 1)) continue;
      sets.push("usage_limit = ?");
      args.push(v);
      continue;
    }
    sets.push(`${camelToSnake(k)} = ?`);
    args.push(v);
  }
  const s = scope || {};
  if (sets.length) {
    args.push(id, s.storeType || null, s.storeId || null, s.userEmail || null);
    await query(
      `UPDATE hotel_coupons SET ${sets.join(", ")}
         WHERE id = ?
           AND (_store_type IS NULL OR _store_type = ?)
           AND (_store_id   IS NULL OR _store_id   = ?)
           AND (_user_email IS NULL OR _user_email = ?)`,
      args
    );
  }
  return exports.findById(id);
};

// Single-row lookup by PK. No scope filtering — used internally
// after a controlled INSERT/UPDATE where the caller already knows
// the row's identity.
exports.findById = async (id) => {
  if (!id) return null;
  const [rows] = await query(`SELECT * FROM hotel_coupons WHERE id = ?`, [id]);
  return (rows && rows[0]) || null;
};

// Convert a camelCase column name to its snake_case DB column. Only
// columns used in the whitelist above are supported.
function camelToSnake(name) {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// Bump usage_count on a coupon atomically. Caller passes a connection
// from withTransaction() so the increment is part of the same DB
// transaction as the invoice INSERT — there is no window where the
// invoice persists but the count doesn't bump (or where two parallel
// redemptions both pass a check then double-decrement).
//
// Returns the new usage_count, or null if the coupon is already at its
// limit (caller should treat that as a validation failure and abort the
// surrounding transaction).
exports.incrementRedemption = async (conn, id) => {
  const exec = conn || (await require("../pool").query.getPool());
  // The closure above lets call-sites pass either a transaction
  // connection or fall back to the shared pool. In practice every
  // production caller passes a conn; the fallback is just to make
  // unit-testing easier.
  const runner = conn
    ? (sql, args) => conn.query(sql, args)
    : (sql, args) => require("../pool").query(sql, args);
  // Single statement: SELECT then UPDATE under the same lock. MySQL
  // takes a row lock on the SELECT FOR UPDATE so concurrent cashiers
  // can't both read usage_count=N-1 and both increment.
  const [checkRows] = await runner(
    `SELECT usage_limit, usage_count FROM hotel_coupons WHERE id = ? FOR UPDATE`,
    [id]
  );
  if (!checkRows || checkRows.length === 0) return null;
  const { usage_limit, usage_count } = checkRows[0];
  if (usage_limit != null && usage_count >= usage_limit) {
    return null; // at the cap — caller should 400 and abort
  }
  await runner(
    `UPDATE hotel_coupons SET usage_count = usage_count + 1 WHERE id = ?`,
    [id]
  );
  return usage_count + 1;
};
