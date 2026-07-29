// server/db/queries/store-settings.js
// `store_settings` table: id, scope_key (unique), scope_type
// ('global' | 'store'), store_type, store_id, payload (JSON), created_at,
// updated_at.
//
// Migration shape: the JSON file used three layouts (flat, {global:{}},
// {scope-key:{}}) that the legacy code normalized at read time. The MySQL
// schema forces one row per scope_key — read is a single SELECT, write is
// a single INSERT ... ON DUPLICATE KEY UPDATE. No normalization needed.

const { query } = require("../pool");

const rowToSetting = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    scopeKey: row.scope_key,
    scopeType: row.scope_type,
    storeType: row.store_type || null,
    storeId: row.store_id || null,
    payload: row.payload || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const getByScopeKey = async (scopeKey) => {
  const rows = await query(
    `SELECT id, scope_key, scope_type, store_type, store_id, payload, created_at, updated_at
     FROM store_settings WHERE scope_key = ? LIMIT 1`,
    [scopeKey]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToSetting(rows[0][0]);
};

const getPayloadByScopeKey = async (scopeKey) => {
  const row = await getByScopeKey(scopeKey);
  return row ? row.payload : null;
};

// upsert: write the payload under scope_key, creating the row if absent
// or updating it if present. Same semantics as the JSON POST handler.
const upsert = async ({ scopeKey, scopeType, storeType, storeId, payload }) => {
  const json = JSON.stringify(payload || {});
  await query(
    `INSERT INTO store_settings
       (scope_key, scope_type, store_type, store_id, payload, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE
       scope_type = VALUES(scope_type),
       store_type = VALUES(store_type),
       store_id = VALUES(store_id),
       payload = VALUES(payload),
       updated_at = NOW(3)`,
    [scopeKey, scopeType, storeType || null, storeId || null, json]
  );
  return getPayloadByScopeKey(scopeKey);
};

// listAll: every scope, for /api/store-settings/admin-style endpoints
// if/when we add them.
const listAll = async () => {
  const rows = await query(
    `SELECT id, scope_key, scope_type, store_type, store_id, payload, created_at, updated_at
     FROM store_settings ORDER BY scope_key`
  );
  return rows[0].map(rowToSetting);
};

module.exports = { getByScopeKey, getPayloadByScopeKey, upsert, listAll };