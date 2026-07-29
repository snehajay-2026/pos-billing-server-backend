// server/db/queries/orders.js
// `orders` table: id, customer, phone, service, items (JSON), qty,
// qty_kg, status, type, token, invoice_no, subtotal, gst_total,
// express_surcharge, total, express, expected_return, notes, _store_type,
// _store_id, _user_email, created_at, updated_at.

const { query } = require("../pool");

const COLUMNS =
  "id, customer, phone, service, items, qty, qty_kg, status, type, token, invoice_no, subtotal, gst_total, express_surcharge, total, express, expected_return, notes, _store_type, _store_id, _user_email, created_at, updated_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToOrder = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    customer: row.customer || null,
    phone: row.phone || null,
    service: row.service || null,
    items: row.items || [],
    qty: toNumber(row.qty),
    qtyKg: toNumber(row.qty_kg),
    status: row.status || "pending",
    type: row.type || null,
    token: row.token || null,
    invoiceNo: row.invoice_no || null,
    subtotal: toNumber(row.subtotal),
    gstTotal: toNumber(row.gst_total),
    expressSurcharge: toNumber(row.express_surcharge),
    total: toNumber(row.total),
    express: !!row.express,
    expectedReturn: row.expected_return || null,
    notes: row.notes || null,
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
    `SELECT ${COLUMNS} FROM orders ${where.sql} ORDER BY created_at DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToOrder);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM orders WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToOrder(rows[0][0]);
};

const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {});
  const rows = await query(
    `SELECT ${COLUMNS} FROM orders WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToOrder(rows[0][0]);
};

const create = async (item, scope) => {
  const id = Date.now();
  await query(
    `INSERT INTO orders
       (id, customer, phone, service, items, qty, qty_kg, status, type, token, invoice_no,
        subtotal, gst_total, express_surcharge, total, express, expected_return, notes,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      item.customer || null,
      item.phone || null,
      item.service || null,
      item.items ? JSON.stringify(item.items) : null,
      toNumber(item.qty),
      toNumber(item.qtyKg ?? item.qty_kg),
      item.status || "pending",
      item.type || null,
      item.token || null,
      item.invoiceNo || item.invoice_no || null,
      toNumber(item.subtotal) ?? 0,
      toNumber(item.gstTotal ?? item.gst_total) ?? 0,
      toNumber(item.expressSurcharge ?? item.express_surcharge),
      toNumber(item.total) ?? 0,
      item.express ? 1 : 0,
      item.expectedReturn || item.expected_return || null,
      item.notes || null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

const update = async (id, patch) => {
  const allowed = [
    "customer", "phone", "service", "items", "qty", "qty_kg",
    "status", "type", "token", "invoice_no", "subtotal", "gst_total",
    "express_surcharge", "total", "express", "expected_return", "notes",
  ];
  // Map camelCase from request body → snake_case for the SET clause.
  const camelToSnake = { qtyKg: "qty_kg", invoiceNo: "invoice_no",
                         gstTotal: "gst_total", expressSurcharge: "express_surcharge",
                         expectedReturn: "expected_return" };
  const sets = [];
  const params = [];
  for (const k of allowed) {
    const camel = Object.keys(camelToSnake).find((c) => camelToSnake[c] === k) || k;
    if (!Object.prototype.hasOwnProperty.call(patch, camel)) continue;
    let v = patch[camel];
    if (["qty", "qty_kg", "subtotal", "gst_total", "express_surcharge", "total"].includes(k)) v = toNumber(v);
    if (k === "items") v = v ? JSON.stringify(v) : null;
    if (k === "express") v = v ? 1 : 0;
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE orders SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM orders WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = { list, findById, findByIdScoped, create, update, deleteById };