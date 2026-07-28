// server/db/queries/expenses.js
// `expenses` table: id, amount, category, description, date, _store_type,
// _store_id, _user_email, created_at, updated_at.

const { query } = require("../pool");

const COLUMNS =
  "id, amount, category, description, date, _store_type, _store_id, _user_email, created_at, updated_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToExpense = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    amount: toNumber(row.amount),
    category: row.category || null,
    description: row.description || null,
    date: row.date, // YYYY-MM-DD or null
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const buildWhere = (scope, query_) => {
  const conds = [];
  const params = [];
  if (scope.storeType) { conds.push("_store_type = ?"); params.push(scope.storeType); }
  if (scope.storeId)   { conds.push("_store_id = ?");   params.push(scope.storeId); }
  if (scope.email)     { conds.push("_user_email = ?"); params.push(scope.email); }
  for (const [k, v] of Object.entries(query_ || {})) {
    if (v === undefined || v === "") continue;
    if (k === "storeType" || k === "storeId" || k === "email") continue;
    conds.push(`\`${k}\` = ?`);
    params.push(v);
  }
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
};

const list = async (scope, query_ = {}) => {
  const where = buildWhere(scope, query_);
  const rows = await query(
    `SELECT ${COLUMNS} FROM expenses ${where.sql} ORDER BY date DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToExpense);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM expenses WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToExpense(rows[0][0]);
};

const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {});
  const rows = await query(
    `SELECT ${COLUMNS} FROM expenses WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToExpense(rows[0][0]);
};

const create = async (item, scope) => {
  const id = Date.now();
  await query(
    `INSERT INTO expenses
       (id, amount, category, description, date,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      toNumber(item.amount) ?? 0,
      item.category || null,
      item.description || null,
      item.date || null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

const update = async (id, patch) => {
  const allowed = ["amount", "category", "description", "date"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (k === "amount") v = toNumber(v);
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE expenses SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM expenses WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = { list, findById, findByIdScoped, create, update, deleteById };