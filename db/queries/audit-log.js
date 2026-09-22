// server/db/queries/audit-log.js
//
// `audit_log` table: id, user_id, action, entity_type, entity_id, payload
// (JSON), ip, created_at.
//
// Read-only from the API surface (append-only on the server). Filters
// supported: action, entityType, entityId, userId, storeType, storeId,
// outcome, since, until, order (asc|desc), limit, offset.
//
// The frontend's auditLogService expects an AuditEntry shape that
// includes method/path/statusCode/ok/errorMessage — those fields are
// derived from the payload JSON when present, otherwise null. The base
// columns (user_id, action, entity_*, created_at) are returned as-is.
//
// Scope: SUPER_OWNER sees everything. Other roles see only their own
// (user_id = req.user.id) entries by default. The storeType/storeId
// scoping is also enforced — callers cannot widen scope by tampering
// with query parameters; the route layer passes only the caller's
// authorized (storeType, storeId) to this module. SUPER_OWNER may pass
// storeType/storeId explicitly to narrow by store.

const { query } = require("../pool");

const COLUMNS =
  "id, user_id, action, entity_type, entity_id, payload, ip, created_at";

const rowToEntry = (row) => {
  if (!row) return null;
  // payload is a JSON object or null. mysql2 may return it as parsed or as
  // a string depending on driver settings — handle both.
  let payload = row.payload;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { payload = null; }
  }
  const p = (payload && typeof payload === "object") ? payload : {};
  return {
    id: row.id != null ? String(row.id) : row.id,
    at: row.created_at || null,
    userId: row.user_id != null ? Number(row.user_id) : row.user_id,
    userEmail: p.userEmail || null,
    userRole: p.userRole || null,
    storeType: p.storeType || null,
    storeId: p.storeId || null,
    method: p.method || null,
    path: p.path || null,
    resource: row.entity_type || null,
    resourceId: row.entity_id || null,
    action: row.action || null,
    ip: row.ip || null,
    userAgent: p.userAgent || null,
    statusCode: p.statusCode != null ? Number(p.statusCode) : null,
    ok: typeof p.ok === "boolean" ? p.ok : null,
    body: p.body || null,
    errorMessage: p.errorMessage || null,
  };
};

// === Read ==================================================================

// Allowed sort orders. Anything else falls back to "desc" so a stray query
// param can't trigger a destructive query shape. Newest-first is the
// default — RecentActivity's day-grouping relies on it.
const normalizeOrder = (raw) => {
  const v = String(raw || "").toLowerCase();
  return v === "asc" ? "asc" : "desc";
};

const list = async ({
  userId = null,
  action = null,
  entityType = null,
  entityId = null,
  storeType = null,
  storeId = null,
  outcome = null,
  since = null,
  until = null,
  order = "desc",
  limit = 100,
  offset = 0,
} = {}) => {
  const conds = [];
  const params = [];
  if (userId) {
    conds.push("user_id = ?");
    params.push(userId);
  }
  if (action) {
    conds.push("action = ?");
    params.push(String(action));
  }
  if (entityType) {
    conds.push("entity_type = ?");
    params.push(String(entityType));
  }
  if (entityId) {
    conds.push("entity_id = ?");
    params.push(String(entityId));
  }
  // storeType / storeId: the caller's scope is enforced at the route
  // layer, so these narrow the result. payload is JSON; JSON_UNQUOTE
  // normalises "system" / null / string-coerced values so we can compare
  // cleanly with `= ?`.
  if (storeType) {
    conds.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.storeType')) = ?");
    params.push(String(storeType));
  }
  if (storeId) {
    conds.push("JSON_UNQUOTE(JSON_EXTRACT(payload, '$.storeId')) = ?");
    params.push(String(storeId));
  }
  if (outcome === "success") {
    conds.push("JSON_EXTRACT(payload, '$.ok') = true");
  } else if (outcome === "failed") {
    conds.push("JSON_EXTRACT(payload, '$.ok') = false");
  }
  if (since) {
    conds.push("created_at >= ?");
    params.push(String(since));
  }
  if (until) {
    conds.push("created_at <= ?");
    params.push(String(until));
  }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 5000));
  const safeOffset = Math.max(0, Number(offset) || 0);
  const safeOrder = normalizeOrder(order);
  // Note: secondary id sort keeps the result stable when many rows share a
  // millisecond — without it the "Load more" pagination can re-emit the
  // same row at the boundary and skip one beyond it.
  const directionClause = safeOrder === "asc" ? "ASC" : "DESC";

  const rows = await query(
    `SELECT ${COLUMNS} FROM audit_log ${where}
     ORDER BY created_at ${directionClause}, id ${directionClause}
     LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );

  const totalRows = await query(
    `SELECT COUNT(*) AS c FROM audit_log ${where}`,
    params
  );
  const total = Number(totalRows[0][0].c) || 0;

  return {
    rows: rows[0].map(rowToEntry),
    total,
    limit: safeLimit,
    offset: safeOffset,
    order: safeOrder,
  };
};

// === Write (used by other modules to log events) ===========================

// append: insert a single audit row. Used by other server-side code paths
// (e.g. checkout, payment mark-paid) — not exposed via HTTP because the
// frontend never POSTs audit events directly. created_at is server-stamped
// via NOW(3) so a clock-skewed client cannot forge a timestamp.
const append = async ({ userId = null, action, entityType = null, entityId = null, payload = null, ip = null }) => {
  if (!action) return null;
  const json = payload ? JSON.stringify(payload) : null;
  const result = await query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, payload, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
    [userId, action, entityType, entityId, json, ip]
  );
  return result[0].insertId;
};

module.exports = {
  list,
  append,
  // Exposed for tests that need to assert the SQL shape (storeType/
  // outcome/order branches). Not part of the public surface.
  _internal: { normalizeOrder, rowToEntry },
};
