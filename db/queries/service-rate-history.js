// server/db/queries/service-rate-history.js
//
// Append-only audit trail for service rate / GST / hours changes. Rows
// are written from the PUT /api/services/:id handler whenever a price-
// relevant field changes. Reads power the "View rate history" panel on
// the service-management page.

const { query } = require("../pool");

const COLUMNS =
  "id, service_id, service_name, old_rate, new_rate, old_gst, new_gst, " +
  "old_hours, new_hours, changed_by_user_id, changed_by_email, changed_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToEntry = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    serviceId: row.service_id != null ? Number(row.service_id) : row.service_id,
    serviceName: row.service_name || null,
    oldRate: toNumber(row.old_rate),
    newRate: toNumber(row.new_rate),
    oldGst: toNumber(row.old_gst),
    newGst: toNumber(row.new_gst),
    oldHours: toNumber(row.old_hours),
    newHours: toNumber(row.new_hours),
    changedByUserId: row.changed_by_user_id != null ? Number(row.changed_by_user_id) : row.changed_by_user_id,
    changedByEmail: row.changed_by_email || null,
    changedAt: row.changed_at || null,
  };
};

// list: returns the most recent changes for a single service, newest first.
// `limit` defaults to 50 (UI panel default) and is hard-capped at 200 so
// a misconfigured client can't request millions of rows.
const list = async ({ serviceId, limit = 50 } = {}) => {
  if (serviceId == null) return [];
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await query(
    `SELECT ${COLUMNS} FROM service_rate_history
       WHERE service_id = ?
       ORDER BY changed_at DESC, id DESC
       LIMIT ${cap}`,
    [Number(serviceId)]
  );
  return rows[0].map(rowToEntry);
};

// listAll: returns the most recent changes across the whole catalog
// (used by the dashboard's Recent Activity feed). Scope is not applied
// here — callers must filter by store/email before reaching this layer,
// since service_rate_history doesn't carry _store_type / _store_id /
// _user_email (we capture the changing user, but the rate history is
// inherently catalog-wide).
const listAll = async ({ limit = 50 } = {}) => {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await query(
    `SELECT ${COLUMNS} FROM service_rate_history
       ORDER BY changed_at DESC, id DESC
       LIMIT ${cap}`
  );
  return rows[0].map(rowToEntry);
};

// append: writes one history row. Caller is responsible for the diff
// (i.e. only call this when at least one of rate/gst/hours actually
// changed).
const append = async ({
  serviceId,
  serviceName,
  oldRate,
  newRate,
  oldGst,
  newGst,
  oldHours,
  newHours,
  changedByUserId,
  changedByEmail,
}) => {
  if (serviceId == null) throw new Error("serviceId is required for service_rate_history append");
  const rows = await query(
    `INSERT INTO service_rate_history
       (service_id, service_name, old_rate, new_rate, old_gst, new_gst,
        old_hours, new_hours, changed_by_user_id, changed_by_email, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
    [
      Number(serviceId),
      serviceName || null,
      toNumber(oldRate),
      toNumber(newRate),
      toNumber(oldGst),
      toNumber(newGst),
      toNumber(oldHours),
      toNumber(newHours),
      changedByUserId != null ? Number(changedByUserId) : null,
      changedByEmail || null,
    ]
  );
  return rows[0].insertId;
};

module.exports = { list, listAll, append };
