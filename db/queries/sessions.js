// server/db/queries/sessions.js
// `sessions` table: session_id (varchar PK), user_id (bigint), expires_at
// (bigint — ms epoch), created_at (datetime3).
//
// Replaces both the in-memory Map and server/data/sessions.json. Every
// get/set/delete goes to MySQL. Expired sessions are filtered out at read
// time (cheap query) instead of being reaped in a background job.

// Use globalThis to keep this constant aligned with the pool's session
// shape. The TTL lives here so the JWT-equivalent expiry is in one place.
const { query } = require("../pool");

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const put = async (sessionId, userId, ttlMs = SESSION_TTL_MS) => {
  const expiresAt = Date.now() + ttlMs;
  await query(
    `INSERT INTO sessions (session_id, user_id, expires_at)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), expires_at = VALUES(expires_at)`,
    [sessionId, userId, expiresAt]
  );
  return expiresAt;
};

const get = async (sessionId) => {
  const rows = await query(
    "SELECT user_id, expires_at FROM sessions WHERE session_id = ? LIMIT 1",
    [sessionId]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  const r = rows[0][0];
  if (r.expires_at && r.expires_at < Date.now()) return null;
  return r.user_id != null ? Number(r.user_id) : null;
};

const remove = async (sessionId) => {
  await query("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
};

// pruneExpired: optional, for housekeeping. NOT called automatically —
// call from a scheduled job if/when one is added. The schema doesn't
// have ON DELETE triggers for expired sessions so this is the cleanup
// path.
const pruneExpired = async () => {
  const result = await query("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]);
  return result[0].affectedRows;
};

module.exports = { put, get, remove, pruneExpired, SESSION_TTL_MS };