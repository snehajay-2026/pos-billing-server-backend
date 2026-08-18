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
  const [rows] = await query(
    `SELECT *
       FROM hotel_coupons
       WHERE code = ?
         AND active = 1
         AND (_store_type IS NULL OR _store_type = ?)
         AND (_store_id   IS NULL OR _store_id   = ?)
         AND (_user_email IS NULL OR _user_email = ?)
         AND (valid_from  IS NULL OR valid_from  <= NOW())
         AND (valid_until IS NULL OR valid_until >= NOW())
       ORDER BY (_store_type IS NOT NULL) DESC,
                (_store_id   IS NOT NULL) DESC,
                (_user_email IS NOT NULL) DESC
       LIMIT 1`,
    [String(code).trim(), s.storeType || null, s.storeId || null, s.userEmail || null]
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
  const [r] = await query(
    `INSERT INTO hotel_coupons
       (code, type, value, min_subtotal, valid_from, valid_until, active,
        _store_type, _store_id, _user_email)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
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
  const allow = ["value", "minSubtotal", "validFrom", "validUntil", "active"];
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
