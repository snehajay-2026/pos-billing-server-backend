// server/db/queries/products.js
//
// All SQL touching the `products` table lives here. Routes in index.js call
// these functions; they never run raw queries against `products`.
//
// Conventions (matching db/queries/users.js):
//   - Returns plain JS objects, id cast to Number (Date.now() shape).
//   - All scope columns read from MySQL as snake_case (_store_type); the
//     rowToProduct mapper exposes them as camelCase (_storeType) so the
//     existing JSON contract is preserved for the frontend.
//   - DECIMAL columns come back as strings under decimalNumbers:false —
//     we parse to Number for stock/price/gst (the JSON files had them as
//     numbers and the frontend expects numbers).
//   - `createdAt` / `updatedAt` come back as MySQL DATETIME strings;
//     preserved as strings (frontend treats as ISO-compatible).

const { query } = require("../pool");

// Columns selected in every read. Kept as a single source of truth so
// rowToProduct() and the SELECT list never drift.
const COLUMNS =
  "id, name, price, gst, stock, barcode, category, unit, _store_type, _store_id, _user_email, created_at, updated_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToProduct = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    name: row.name || null,
    price: toNumber(row.price),
    gst: toNumber(row.gst),
    stock: toNumber(row.stock),
    barcode: row.barcode || null,
    category: row.category || null,
    unit: row.unit || "unit",
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

// Build a WHERE clause + params from a scope + query filter object.
// scope = { storeType, storeId, email } from getRequestScope(req).
// The behavior matches filterByQuery() in index.js for the JSON path:
//   - storeType, storeId, email are scope filters
//   - other keys (e.g. ?barcode=...) match against the row's column
const buildWhere = (scope, query_) => {
  const conds = [];
  const params = [];
  if (scope.storeType) {
    conds.push("_store_type = ?");
    params.push(scope.storeType);
  }
  if (scope.storeId) {
    conds.push("_store_id = ?");
    params.push(scope.storeId);
  }
  if (scope.email) {
    conds.push("_user_email = ?");
    params.push(scope.email);
  }
  // Pass-through filters for any other ?key=value (e.g. ?barcode=, ?category=)
  for (const [k, v] of Object.entries(query_ || {})) {
    if (v === undefined || v === "") continue;
    if (k === "storeType" || k === "storeId" || k === "email") continue;
    conds.push(`\`${k}\` = ?`);
    params.push(v);
  }
  return {
    sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "",
    params,
  };
};

const list = async (scope, query_ = {}) => {
  const where = buildWhere(scope, query_);
  const rows = await query(
    `SELECT ${COLUMNS} FROM products ${where.sql} ORDER BY created_at DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToProduct);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM products WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToProduct(rows[0][0]);
};

// findByIdScoped: same as findById but enforces store-scope. Used by
// PUT/DELETE to make sure a user can't update a product outside their
// store by guessing an id.
const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {});
  const rows = await query(
    `SELECT ${COLUMNS} FROM products WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToProduct(rows[0][0]);
};

const create = async (item, scope) => {
  const id = Date.now();
  await query(
    `INSERT INTO products
       (id, name, price, gst, stock, barcode, category, unit,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      item.name || "",
      toNumber(item.price) ?? 0,
      toNumber(item.gst) ?? 0,
      toNumber(item.stock) ?? 0,
      item.barcode || null,
      item.category || null,
      item.unit === "kg" ? "kg" : "unit",
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

// update: applies only the columns present in `patch`. We don't pass
// `null` for missing keys because that would NULL out fields the caller
// didn't intend to clear. Same shape as the JSON path which does
// `{ ...existing, ...patch }`.
const update = async (id, patch) => {
  const allowed = ["name", "price", "gst", "stock", "barcode", "category", "unit"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (["price", "gst", "stock"].includes(k)) v = toNumber(v);
    if (k === "unit" && v !== "kg") v = "unit";
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    // Nothing to update; just bump updated_at and return the current row.
    await query("UPDATE products SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM products WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = {
  list,
  findById,
  findByIdScoped,
  create,
  update,
  deleteById,
};