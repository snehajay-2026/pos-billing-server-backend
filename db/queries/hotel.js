// server/db/queries/hotel.js
// `hotel_state` table: singleton row (id=1) with JSON columns for the
// six hotel sub-resources (tables, waiting, dining_waiting, lodging_waiting,
// checkout_history, dining_bills).
//
// Migration shape: the JSON code path held all six arrays in memory and
// flushed the whole hotelStore to disk. The MySQL path reads/writes each
// JSON column individually. There is no `hotelStore` in-memory cache
// anymore — every read goes to MySQL, every write persists immediately.

const { query } = require("../pool");

const COLUMNS =
  "id, tables, waiting, dining_waiting, lodging_waiting, checkout_history, dining_bills, updated_at";

const rowToHotel = (row) => {
  if (!row) return null;
  return {
    tables: row.tables || [],
    waiting: row.waiting || [],
    diningWaiting: row.dining_waiting || [],
    lodgingWaiting: row.lodging_waiting || [],
    checkoutHistory: row.checkout_history || [],
    diningBills: row.dining_bills || [],
    updatedAt: row.updated_at || null,
  };
};

// getAll: returns the entire hotel state object.
const getAll = async () => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM hotel_state WHERE id = 1 LIMIT 1`
  );
  if (!rows[0] || rows[0].length === 0) {
    // Should not happen because schema.sql INSERTs the singleton row, but
    // be defensive.
    await query("INSERT IGNORE INTO hotel_state (id) VALUES (1)");
    return { tables: [], waiting: [], diningWaiting: [], lodgingWaiting: [], checkoutHistory: [], diningBills: [] };
  }
  return rowToHotel(rows[0][0]);
};

// getSlice: returns just one sub-resource (e.g. checkoutHistory) without
// loading the rest. The route handlers that hit /api/hotel/checkout-history
// use this.
const getSlice = async (slice) => {
  const col = sliceToColumn(slice);
  if (!col) return [];
  const rows = await query(
    `SELECT ${col} FROM hotel_state WHERE id = 1 LIMIT 1`
  );
  if (!rows[0] || rows[0].length === 0) return [];
  return rows[0][0][col] || [];
};

// pushItem: append a new entry to a sub-resource (e.g. add a checkout).
const pushItem = async (slice, item) => {
  const col = sliceToColumn(slice);
  if (!col) return null;
  // Append via JSON_ARRAY_APPEND. Concurrent pushes would race here, but
  // each individual handler is short-lived and the volume is low (one
  // checkout at a time). If contention becomes a problem, switch to
  // SELECT ... FOR UPDATE inside withTransaction.
  //
  // JSON_ARRAY_APPEND(json_doc, path, value) — path is '$' for the
  // outermost array. mysql2 passes ? as a literal string, but the CAST
  // coerces it into JSON.
  await query(
    `UPDATE hotel_state
     SET ${col} = JSON_ARRAY_APPEND(COALESCE(${col}, JSON_ARRAY()), '$', CAST(? AS JSON)),
         updated_at = NOW(3)
     WHERE id = 1`,
    [JSON.stringify(item)]
  );
  return item;
};

// replaceSlice: wholesale replace a sub-resource (e.g. update a dining bill).
const replaceSlice = async (slice, value) => {
  const col = sliceToColumn(slice);
  if (!col) return null;
  await query(
    `UPDATE hotel_state SET ${col} = CAST(? AS JSON), updated_at = NOW(3) WHERE id = 1`,
    [JSON.stringify(value || [])]
  );
  return value || [];
};

// removeItem: delete an entry by id from a sub-resource. Uses JSON_SEARCH
// to find the matching element. Returns true if a row was updated.
const removeItem = async (slice, id) => {
  const col = sliceToColumn(slice);
  if (!col) return false;
  const result = await query(
    `UPDATE hotel_state
     SET ${col} = JSON_REMOVE(
       COALESCE(${col}, JSON_ARRAY()),
       JSON_UNQUOTE(JSON_SEARCH(${col}, 'one', ?))
     ), updated_at = NOW(3)
     WHERE id = 1`,
    [String(id)]
  );
  return result[0].affectedRows > 0;
};

// clearSlice: empty a sub-resource (used by /api/hotel/checkout-history DELETE).
const clearSlice = async (slice) => {
  const col = sliceToColumn(slice);
  if (!col) return false;
  await query(
    `UPDATE hotel_state SET ${col} = JSON_ARRAY(), updated_at = NOW(3) WHERE id = 1`
  );
  return true;
};

// sliceToColumn: maps the route param names to the JSON column names.
const sliceToColumn = (slice) => {
  const map = {
    tables: "tables",
    waiting: "waiting",
    "dining-waiting": "dining_waiting",
    "lodging-waiting": "lodging_waiting",
    "checkout-history": "checkout_history",
    "dining-bills": "dining_bills",
  };
  return map[slice] || null;
};

module.exports = {
  getAll,
  getSlice,
  pushItem,
  replaceSlice,
  removeItem,
  clearSlice,
  sliceToColumn,
};