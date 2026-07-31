// server/db/queries/hotel-bookings.js
//
// Per-booking persistence for hotel tables + rooms. Replaces the JSON-blob
// approach in `hotel_state` (which had no per-store scoping and no
// cross-device sync).
//
// Scope rules: every read/write filters by (storeType, storeId) so the
// SUPER_OWNER can switch between stores and only see that store's
// bookings. The frontend always sends storeType + storeId as query params
// on every booking API call.

const { query, withTransaction } = require("../pool");

const COLUMNS = `id, kind, table_id, table_name, zone, party_size, order_summary,
  ordered_menu_items, room_id, room_number, guest_name, customer_mobile, status,
  notes, check_in_date, check_in_time, expected_check_out, actual_check_out,
  created_by, _store_type, _store_id, created_at, updated_at`;

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToBooking = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    kind: row.kind,
    tableId: row.table_id || null,
    tableName: row.table_name || null,
    zone: row.zone || null,
    partySize: toNumber(row.party_size),
    orderSummary: row.order_summary || null,
    orderedMenuItems: row.ordered_menu_items || null,
    roomId: row.room_id || null,
    roomNumber: row.room_number || null,
    guestName: row.guest_name || null,
    customerMobile: row.customer_mobile || null,
    status: row.status || "booked",
    notes: row.notes || null,
    checkInDate: row.check_in_date || null,
    checkInTime: row.check_in_time || null,
    expectedCheckOut: row.expected_check_out || null,
    actualCheckOut: row.actual_check_out || null,
    createdBy: row.created_by || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

// === Reads ==================================================================

const listByStore = async ({ storeType, storeId, kind, status } = {}) => {
  const conds = ["1=1"];
  const params = [];
  if (storeType) {
    conds.push("_store_type = ?");
    params.push(String(storeType));
  }
  if (storeId) {
    conds.push("_store_id = ?");
    params.push(String(storeId));
  }
  if (kind) {
    conds.push("kind = ?");
    params.push(String(kind));
  }
  if (status) {
    conds.push("status = ?");
    params.push(String(status));
  }
  const rows = await query(
    `SELECT ${COLUMNS} FROM hotel_bookings
     WHERE ${conds.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT 500`,
    params
  );
  return rows[0].map(rowToBooking);
};

const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM hotel_bookings WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToBooking(rows[0][0]);
};

// findByRefId: find a booking by its external id (table_id or room_id).
// Used to enforce one-active-booking-per-table semantics.
const findByRefId = async (kind, refId, { storeType, storeId, status } = {}) => {
  const col = kind === "dining" ? "table_id" : "room_id";
  const conds = ["kind = ?", `${col} = ?`];
  const params = [String(kind), String(refId)];
  if (storeType) {
    conds.push("_store_type = ?");
    params.push(String(storeType));
  }
  if (storeId) {
    conds.push("_store_id = ?");
    params.push(String(storeId));
  }
  if (status) {
    conds.push("status = ?");
    params.push(String(status));
  }
  const rows = await query(
    `SELECT ${COLUMNS} FROM hotel_bookings
     WHERE ${conds.join(" AND ")}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    params
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToBooking(rows[0][0]);
};

// === Writes =================================================================

// upsert: insert or update a booking. Match by (kind, refId) within the
// (storeType, storeId) scope. If a row exists, merge the patch in;
// otherwise insert a fresh row.
const upsert = async (booking, scope) => {
  const existing = booking.id
    ? await findById(booking.id)
    : await findByRefId(booking.kind, booking.kind === "dining" ? booking.tableId : booking.roomId, {
        storeType: scope.storeType,
        storeId: scope.storeId,
        status: "booked",
      });

  if (existing) {
    await update(existing.id, booking);
    return findById(existing.id);
  }
  return insert(booking, scope);
};

const insert = async (booking, scope) => {
  const result = await query(
    `INSERT INTO hotel_bookings
       (kind, table_id, table_name, zone, party_size, order_summary,
        ordered_menu_items, room_id, room_number, guest_name, customer_mobile,
        status, notes, check_in_date, check_in_time, expected_check_out,
        created_by, _store_type, _store_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      booking.kind,
      booking.kind === "dining" ? booking.tableId || null : null,
      booking.kind === "dining" ? booking.tableName || null : null,
      booking.kind === "dining" ? booking.zone || null : null,
      booking.kind === "dining" ? toNumber(booking.partySize) : null,
      booking.kind === "dining"
        ? JSON.stringify(booking.orderSummary || null)
        : null,
      booking.kind === "dining"
        ? JSON.stringify(booking.orderedMenuItems || null)
        : null,
      booking.kind === "lodging" ? booking.roomId || null : null,
      booking.kind === "lodging" ? booking.roomNumber || null : null,
      booking.guestName || null,
      booking.customerMobile || null,
      booking.status || "booked",
      booking.notes || null,
      booking.checkInDate || null,
      booking.checkInTime || null,
      booking.expectedCheckOut || null,
      booking.createdBy || null,
      scope.storeType || "hotel",
      scope.storeId || "hotel",
    ]
  );
  return findById(result[0].insertId);
};

const update = async (id, patch) => {
  const allowed = [
    "kind",
    "table_id",
    "table_name",
    "zone",
    "party_size",
    "order_summary",
    "ordered_menu_items",
    "room_id",
    "room_number",
    "guest_name",
    "customer_mobile",
    "status",
    "notes",
    "check_in_date",
    "check_in_time",
    "expected_check_out",
    "actual_check_out",
  ];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (["party_size"].includes(k)) v = toNumber(v);
    if (["order_summary", "ordered_menu_items"].includes(k)) {
      v = JSON.stringify(v || null);
    }
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE hotel_bookings SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE hotel_bookings SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM hotel_bookings WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

const checkout = async (id) => {
  return update(id, { status: "checked_out", actual_check_out: new Date() });
};

const clearByRefId = async (kind, refId, { storeType, storeId } = {}) => {
  const col = kind === "dining" ? "table_id" : "room_id";
  const conds = ["kind = ?", `${col} = ?`, "status = 'booked'"];
  const params = [String(kind), String(refId)];
  if (storeType) {
    conds.push("_store_type = ?");
    params.push(String(storeType));
  }
  if (storeId) {
    conds.push("_store_id = ?");
    params.push(String(storeId));
  }
  await query(
    `UPDATE hotel_bookings
     SET status = 'checked_out', actual_check_out = NOW(3), updated_at = NOW(3)
     WHERE ${conds.join(" AND ")}`,
    params
  );
};

module.exports = {
  listByStore,
  findById,
  findByRefId,
  upsert,
  insert,
  update,
  deleteById,
  checkout,
  clearByRefId,
};
