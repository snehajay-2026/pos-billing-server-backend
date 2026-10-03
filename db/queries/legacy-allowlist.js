// db/queries/legacy-allowlist.js
//
// Persistent SUPER_OWNER-approved legacy tenant allowlist (Task 10).
// Same interface as lib/legacy-allowlist.js makeMemoryAllowlist:
//   isAllowlisted(canonicalKey) → boolean (sync-shape; fails closed on error
//     at the caller — this impl is async and throws, caller catches)
//   add(canonicalKey, { approvedBy, reason }, conn?) → row
//   remove(canonicalKey, conn?) → void
//
// Table definition lives in db/runtime-migrations.js TABLE_MIGRATIONS
// (code only — DBA applies manually per the migration checklist).

const { query } = require("../pool");
const TABLE = "legacy_tenant_allowlist";

function normalize(key) {
  if (key == null) return null;
  const s = String(key).trim().toLowerCase();
  return s || null;
}

async function isAllowlisted(canonicalKey) {
  const k = normalize(canonicalKey);
  if (!k) return false;
  const [rows] = await query(
    `SELECT tenant_key FROM ${TABLE} WHERE tenant_key = ? LIMIT 1`,
    [k]
  );
  return !!(rows && rows.length);
}

async function list() {
  const [rows] = await query(
    `SELECT tenant_key, approved_by_email, reason, created_at, updated_at
     FROM ${TABLE} ORDER BY tenant_key ASC`
  );
  return rows;
}

async function add(canonicalKey, { approvedBy = null, reason = null } = {}, conn = null) {
  const k = normalize(canonicalKey);
  if (!k) throw new Error("Invalid tenant key");
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  await exec(
    `INSERT INTO ${TABLE} (tenant_key, approved_by_email, reason)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE approved_by_email = VALUES(approved_by_email),
                               reason = VALUES(reason)`,
    [k, approvedBy, reason]
  );
  return { tenantKey: k, approvedBy, reason };
}

async function remove(canonicalKey, conn = null) {
  const k = normalize(canonicalKey);
  if (!k) throw new Error("Invalid tenant key");
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  await exec(`DELETE FROM ${TABLE} WHERE tenant_key = ?`, [k]);
  return { tenantKey: k };
}

module.exports = { TABLE, normalize, isAllowlisted, list, add, remove };
