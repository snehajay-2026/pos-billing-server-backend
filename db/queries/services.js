// server/db/queries/services.js
//
// Same shape as products.js but for the `services` table. Columns per
// schema.sql: id, name, description, rate, hours, gst, category,
// _store_type, _store_id, _user_email, created_at, updated_at.
//
// Conventions (matching db/queries/products.js):
//   - Returns plain JS objects, id cast to Number (Date.now() shape).
//   - All scope columns read from MySQL as snake_case; the rowToService
//     mapper exposes them as camelCase so the existing JSON contract is
//     preserved for the frontend.
//   - DECIMAL columns come back as strings under decimalNumbers:false —
//     we parse to Number for rate/hours/gst.
//
// Bug fix (mirrors products.js Bug #3): the previous buildWhere appended
// `_user_email = ?` unconditionally. That made a cashier's GET /api/services
// return [] whenever the catalog had been seeded by an admin in the same
// store. Reads now ignore email via includeEmail:false; ownership of writes
// is still gated on email through findByIdScoped (includeEmail:true).

const { query } = require("../pool");

const COLUMNS =
  "id, name, description, rate, hours, gst, category, _store_type, _store_id, _user_email, created_at, updated_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToService = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    name: row.name || null,
    description: row.description || null,
    rate: toNumber(row.rate),
    hours: toNumber(row.hours),
    gst: toNumber(row.gst),
    category: row.category || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const buildWhere = (scope, query_, { includeEmail = false } = {}) => {
  const conds = [];
  const params = [];
  if (scope.storeType) { conds.push("_store_type = ?"); params.push(scope.storeType); }
  if (scope.storeId)   { conds.push("_store_id = ?");   params.push(scope.storeId); }
  if (includeEmail && scope.email) { conds.push("_user_email = ?"); params.push(scope.email); }
  for (const [k, v] of Object.entries(query_ || {})) {
    if (v === undefined || v === "") continue;
    if (k === "storeType" || k === "storeId" || k === "email") continue;
    conds.push(`\`${k}\` = ?`);
    params.push(v);
  }
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
};

const list = async (scope, query_ = {}) => {
  // Bug fix: do NOT include `_user_email` in the WHERE clause. The store
  // catalog is shared across all staff in the same store, so a cashier
  // must see services seeded by an admin.
  const where = buildWhere(scope, query_, { includeEmail: false });
  const rows = await query(
    `SELECT ${COLUMNS} FROM services ${where.sql} ORDER BY created_at DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToService);
};

// findByIdScoped: keeps the email filter (includeEmail:true) so a cashier
// can't mutate the admin's catalog by guessing an id. Reads via list()
// stay scope-wide.
const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {}, { includeEmail: true });
  const rows = await query(
    `SELECT ${COLUMNS} FROM services WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToService(rows[0][0]);
};

// findById: ignores scope (returns the row by id alone). Used by
// create()/update() to re-read after writing, where we don't yet have a
// scope-filtered context. Routes that need scope enforcement should call
// findByIdScoped directly.
const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM services WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToService(rows[0][0]);
};

// findByName: looks up a service row by its (store-scoped) name. Used by
// the service-order → invoice conversion flow (F1): the orders.service
// column stores a free-text name, not a numeric FK, so the route has to
// resolve the rate/GST by name. Includes the email filter (includeEmail
// defaults to true for writes here, mirroring findByIdScoped) so a
// cashier in one store can't accidentally invoice a service from a
// different store. Returns the first match.
const findByName = async (name, scope) => {
  if (!name) return null;
  const where = buildWhere(scope, {}, { includeEmail: true });
  const rows = await query(
    `SELECT ${COLUMNS} FROM services WHERE name = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [String(name), ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToService(rows[0][0]);
};

const create = async (item, scope) => {
  const id = Date.now();
  await query(
    `INSERT INTO services
       (id, name, description, rate, hours, gst, category,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      item.name || "",
      item.description || null,
      toNumber(item.rate) ?? 0,
      toNumber(item.hours),
      toNumber(item.gst) ?? 0,
      item.category || null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

const update = async (id, patch) => {
  const allowed = ["name", "description", "rate", "hours", "gst", "category"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (["rate", "hours", "gst"].includes(k)) v = toNumber(v);
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE services SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM services WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = { list, findById, findByIdScoped, findByName, create, update, deleteById };