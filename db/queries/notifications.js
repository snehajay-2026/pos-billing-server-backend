// server/db/queries/notifications.js
// `notifications` table: id, read_flag, email, type, message, payload (JSON),
// _store_type, _store_id, _user_email, created_at, updated_at.
//
// `read_flag` is the column name (READ is a reserved word in MySQL — using
// `read` as a column name would require backtick-quoting everywhere). The
// row mapper exposes it as `read` to match the existing JSON contract.

const { query } = require("../pool");

const COLUMNS =
  "id, read_flag, email, type, message, payload, _store_type, _store_id, _user_email, created_at, updated_at";

const rowToNotification = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    read: !!row.read_flag,
    email: row.email || null,
    type: row.type || null,
    message: row.message || null,
    payload: row.payload || null,
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
    `SELECT ${COLUMNS} FROM notifications ${where.sql} ORDER BY created_at DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToNotification);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM notifications WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToNotification(rows[0][0]);
};

const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {});
  const rows = await query(
    `SELECT ${COLUMNS} FROM notifications WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToNotification(rows[0][0]);
};

const create = async (item, scope) => {
  const id = Date.now();
  await query(
    `INSERT INTO notifications
       (id, read_flag, email, type, message, payload,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      item.read ? 1 : 0,
      item.email || null,
      item.type || null,
      item.message || null,
      item.payload ? JSON.stringify(item.payload) : null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

const update = async (id, patch) => {
  const allowed = ["read_flag", "email", "type", "message", "payload"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    const camel = k === "read_flag" ? "read" : k;
    if (!Object.prototype.hasOwnProperty.call(patch, camel)) continue;
    let v = patch[camel];
    if (k === "read_flag") v = v ? 1 : 0;
    if (k === "payload") v = v ? JSON.stringify(v) : null;
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE notifications SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE notifications SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM notifications WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = { list, findById, findByIdScoped, create, update, deleteById };