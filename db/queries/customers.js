// server/db/queries/customers.js
// `customers` table: id, name, phone, email, address, notes, gstin,
// approval_status, approved_by_email, approved_at, rejected_by_email,
// rejected_at, rejection_reason, created_by_email,
// _store_type, _store_id, _user_email, created_at, updated_at.
//
// Conventions (matching db/queries/products.js):
//   - Returns plain JS objects, id cast to Number (Date.now() shape).
//   - All scope columns read from MySQL as snake_case (_store_type); the
//     rowToCustomer mapper exposes them as camelCase so the existing JSON
//     contract is preserved for the frontend.
//   - `createdAt` / `updatedAt` come back as MySQL DATETIME strings;
//     preserved as strings.
//
// Bug fix (mirrors products.js Bug #3): the previous buildWhere appended
// `_user_email = ?` unconditionally. That made a cashier's GET /api/customers
// return [] whenever the store's customer book had been seeded by an admin.
// Reads now ignore email via includeEmail:false; ownership of writes by
// the original creator is preserved through findByIdScoped (email:true).
//
// Approval workflow (Option B):
//   - Cashier-created rows have approval_status='pending'. Admin/Branch
//     Admin-created rows are 'approved' (legacy behavior preserved).
//   - Cashiers cannot edit/delete admin-created rows: the cashier PUT/DELETE
//     path keeps the email-restricted findByIdScoped.
//   - Admin/Branch Admin can edit/delete any same-branch row via
//     findByIdScopedForManage (email omitted when caller is admin).
//   - Status transitions go through approve() which performs a conditional
//     UPDATE on the row's current status to be safe against concurrent
//     approve/reject clicks.

const { query, withTransaction } = require("../pool");

const COLUMNS =
  "id, name, phone, email, address, notes, gstin, " +
  "approval_status, approved_by_email, approved_at, rejected_by_email, " +
  "rejected_at, rejection_reason, created_by_email, " +
  "_store_type, _store_id, _user_email, created_at, updated_at";

const APPROVAL_VALUES = new Set(["pending", "approved", "rejected"]);

const normalizeApprovalStatus = (v) => {
  const s = String(v || "").trim().toLowerCase();
  return APPROVAL_VALUES.has(s) ? s : null;
};

const rowToCustomer = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    name: row.name || null,
    phone: row.phone || null,
    email: row.email || null,
    address: row.address || null,
    notes: row.notes || null,
    gstin: row.gstin || null,
    approvalStatus: normalizeApprovalStatus(row.approval_status) || "approved",
    approvedByEmail: row.approved_by_email || null,
    approvedAt: row.approved_at || null,
    rejectedByEmail: row.rejected_by_email || null,
    rejectedAt: row.rejected_at || null,
    rejectionReason: row.rejection_reason || null,
    createdByEmail: row.created_by_email || row._user_email || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

// Build a WHERE clause + params from scope + optional query filters.
// scope = { storeType, storeId, email, role? } from getRequestScope(req).
//   - storeType, storeId are scope filters (Bug #3 fix: no email on reads).
//   - email is OPTIONAL: includeEmail=true is used only by write paths
//     that need creator ownership checks (cashiers editing their own rows).
const buildWhere = (scope, query_, { includeEmail = false } = {}) => {
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
  if (includeEmail && scope.email) {
    conds.push("_user_email = ?");
    params.push(scope.email);
  }
  // Pass-through filters for any other ?key=value (e.g. ?name=, ?phone=)
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
  // Bug #3 fix: do NOT include `_user_email` in the WHERE clause. The
  // customer book is shared across all staff in the same store.
  const where = buildWhere(scope, query_, { includeEmail: false });
  const rows = await query(
    `SELECT ${COLUMNS} FROM customers ${where.sql} ORDER BY created_at DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToCustomer);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM customers WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToCustomer(rows[0][0]);
};

// findByIdScoped: keeps the email filter (includeEmail:true) so a cashier
// can't mutate an admin's customer by guessing an id. Reads via list()
// stay scope-wide.
const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {}, { includeEmail: true });
  const rows = await query(
    `SELECT ${COLUMNS} FROM customers WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToCustomer(rows[0][0]);
};

// findByIdScopedForManage: same-store lookup for admin roles. Drops the
// `_user_email` filter when the caller is SUPER_OWNER/ADMIN/STORE_ADMIN so
// they can edit/delete any same-branch customer (e.g. the cashier's
// pending submission). Cashiers still go through findByIdScoped.
const findByIdScopedForManage = async (id, scope) => {
  const role = String(scope.role || "").toUpperCase();
  const isAdminCaller = ["SUPER_OWNER", "ADMIN", "STORE_ADMIN"].includes(role);
  const where = buildWhere(scope, {}, { includeEmail: !isAdminCaller });
  const rows = await query(
    `SELECT ${COLUMNS} FROM customers WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToCustomer(rows[0][0]);
};

// create: scope.email drives _user_email + created_by_email. scope.role
// drives the initial approval_status:
//   - ADMIN / STORE_ADMIN / SUPER_OWNER → 'approved' (matches the legacy
//     "admin-created rows are immediately active" business rule).
//   - Anything else (CASHIER) → 'pending'. The admin must approve before
//     the row appears in POS search.
const create = async (item, scope) => {
  const id = Date.now();
  const role = String(scope.role || "").toUpperCase();
  const isAdminCaller = ["SUPER_OWNER", "ADMIN", "STORE_ADMIN"].includes(role);
  const approvalStatus = isAdminCaller ? "approved" : "pending";
  const approvedByEmail = isAdminCaller ? scope.email || null : null;
  await query(
    `INSERT INTO customers
       (id, name, phone, email, address, notes, gstin,
        approval_status, approved_by_email, approved_at, created_by_email,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      item.name || null,
      item.phone || null,
      item.email || null,
      item.address || null,
      item.notes || null,
      item.gstin || null,
      approvalStatus,
      approvedByEmail,
      scope.email || null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

// update: only the editable, non-status columns. Approval transitions go
// through approve() so we never let a caller blindly toggle approval_status
// via a generic PATCH.
const update = async (id, patch) => {
  const allowed = ["name", "phone", "email", "address", "notes", "gstin"];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (v === "") v = null;
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE customers SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE customers SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

// approve: atomic status transition. Only allowed from 'pending'. The
// caller is responsible for the role check (CASHIER cannot approve — the
// route enforces this) and for the same-store scope check via
// findByIdScopedForManage() before invoking this.
//
// Concurrent-safety: the UPDATE is gated on the row's current status
// being 'pending'. Two admin tabs clicking Approve at the same time
// produces exactly one writer; the other sees affectedRows=0 and gets a
// 409 with the current row in the message.
const approve = async (id, { status, reason }, actor) => {
  const next = normalizeApprovalStatus(status);
  if (!next || (next !== "approved" && next !== "rejected")) {
    const err = new Error("Invalid approval status");
    err.status = 400;
    throw err;
  }
  const trimmedReason = next === "rejected" ? String(reason || "").trim() : "";
  if (next === "rejected" && !trimmedReason) {
    const err = new Error("A rejection reason is required");
    err.status = 400;
    throw err;
  }

  return withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT id, approval_status FROM customers WHERE id = ? FOR UPDATE`,
      [id]
    );
    if (!rows || rows.length === 0) {
      const err = new Error("Customer not found");
      err.status = 404;
      throw err;
    }
    const current = normalizeApprovalStatus(rows[0].approval_status) || "approved";
    if (current !== "pending") {
      const err = new Error(
        `Customer has already been ${current === "approved" ? "approved" : "rejected"}`
      );
      err.status = 409;
      err.code = "ALREADY_DECIDED";
      err.currentStatus = current;
      throw err;
    }

    if (next === "approved") {
      await conn.query(
        `UPDATE customers
            SET approval_status = 'approved',
                approved_by_email = ?,
                approved_at = NOW(3),
                rejected_by_email = NULL,
                rejected_at = NULL,
                rejection_reason = NULL,
                updated_at = NOW(3)
          WHERE id = ? AND approval_status = 'pending'`,
        [actor?.email || null, id]
      );
    } else {
      await conn.query(
        `UPDATE customers
            SET approval_status = 'rejected',
                rejected_by_email = ?,
                rejected_at = NOW(3),
                rejection_reason = ?,
                approved_by_email = NULL,
                approved_at = NULL,
                updated_at = NOW(3)
          WHERE id = ? AND approval_status = 'pending'`,
        [actor?.email || null, trimmedReason.slice(0, 500), id]
      );
    }

    const [recheck] = await conn.query(
      `SELECT ${COLUMNS} FROM customers WHERE id = ? LIMIT 1`,
      [id]
    );
    if (!recheck || recheck.length === 0) {
      const err = new Error("Customer not found after update");
      err.status = 404;
      throw err;
    }
    return rowToCustomer(recheck[0]);
  });
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM customers WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = {
  list,
  findById,
  findByIdScoped,
  findByIdScopedForManage,
  create,
  update,
  approve,
  deleteById,
  // Exported for unit tests.
  _internal: { buildWhere, normalizeApprovalStatus },
};
