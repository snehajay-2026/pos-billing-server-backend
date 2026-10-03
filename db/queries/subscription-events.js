// subscription-events.js
//
// Append-only lifecycle log for subscriptions. Every state transition
// (created, renewed, cancelled, payment_failed, etc.) is recorded here
// with a JSON payload for auditability. This table is never updated
// or deleted — rows are only inserted.

const { query } = require("../pool");

const TABLE = "subscription_events";

const VALID_EVENT_TYPES = new Set([
  "created",
  "renewed",
  "cancelled",
  "payment_succeeded",
  "payment_failed",
  "trial_started",
  "trial_ended",
  "plan_changed",
  "expired",
]);

/**
 * Append a lifecycle event to a subscription.
 * @param {object} params
 * @param {number} params.subscriptionId
 * @param {string} params.eventType
 * @param {object} [params.payload] - arbitrary JSON-serialisable context
 * @param {object} [conn] - optional transaction connection from
 *   withTransaction(). When given, the INSERT runs on it; otherwise it
 *   uses the pool (unchanged legacy behavior).
 * @returns {Promise<object>} the inserted row
 */
async function append({ subscriptionId, eventType, payload = null }, conn = null) {
  if (!subscriptionId) throw new Error("subscriptionId is required");
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(`Invalid event type: ${eventType}`);
  }
  const payloadJson = payload ? JSON.stringify(payload) : null;
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  const [result] = await exec(
    `INSERT INTO ${TABLE}
       (subscription_id, event_type, payload, created_at)
     VALUES (?, ?, ?, NOW(3))`,
    [subscriptionId, eventType, payloadJson]
  );
  return {
    id: result.insertId,
    subscriptionId,
    eventType,
    payload,
    createdAt: new Date().toISOString(),
  };
}

/**
 * List events for a subscription, newest first.
 * @param {number} subscriptionId
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Promise<object[]>}
 */
async function listBySubscription(subscriptionId, { limit = 50 } = {}) {
  const [rows] = await query(
    `SELECT id, subscription_id, event_type, payload, created_at
     FROM ${TABLE}
     WHERE subscription_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [subscriptionId, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    eventType: r.event_type,
    payload: r.payload ? JSON.parse(r.payload) : null,
    createdAt: r.created_at,
  }));
}

/**
 * List events across all subscriptions for a tenant, newest first.
 * @param {string} tenantEmail
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {Promise<object[]>}
 */
async function listByTenant(tenantEmail, { limit = 100 } = {}) {
  const [rows] = await query(
    `SELECT e.id, e.subscription_id, e.event_type, e.payload, e.created_at
     FROM ${TABLE} e
     INNER JOIN subscriptions s ON s.id = e.subscription_id
     WHERE s.tenant_email = ?
     ORDER BY e.id DESC
     LIMIT ?`,
    [tenantEmail, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscription_id,
    eventType: r.event_type,
    payload: r.payload ? JSON.parse(r.payload) : null,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Platform scope (SUPER_OWNER only, via GET /api/super/subscription-events).
//
// An event row carries no tenant column of its own — tenant identity comes
// from the parent subscription (subscriptions.tenant_email), exactly the
// same JOIN listByTenant already uses. Tenant ownership is therefore read
// from the database, never from request parameters.
//
// The field allowlist below is the contract for the platform event history:
// id, tenantEmail (from the subscription join), subscriptionId, eventType,
// and createdAt. The raw `payload` JSON column is deliberately NOT selected:
// webhook payloads may carry provider internals (account ids, notes, offer
// data) that the platform UI has no need to display. There is no status
// column on this table (event_type IS the lifecycle marker), so no status
// filter is offered — inventing one would be a fabricated contract.
// ---------------------------------------------------------------------------

const PLATFORM_PAGE_DEFAULT = 1;
const PLATFORM_LIMIT_DEFAULT = 25;
const PLATFORM_LIMIT_MAX = 100;

const toPlatformEvent = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenantEmail: row.tenant_email || null,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    createdAt: row.created_at,
  };
};

const normalizePlatformPaging = (page, limit) => {
  let p = Number.parseInt(page, 10);
  if (!Number.isFinite(p) || p < 1) p = PLATFORM_PAGE_DEFAULT;
  let l = Number.parseInt(limit, 10);
  if (!Number.isFinite(l) || l < 1) l = PLATFORM_LIMIT_DEFAULT;
  if (l > PLATFORM_LIMIT_MAX) l = PLATFORM_LIMIT_MAX;
  return { page: p, limit: l };
};

const PLATFORM_FROM = `FROM ${TABLE} e
     INNER JOIN subscriptions s ON s.id = e.subscription_id`;

async function countPlatformEvents() {
  const [rows] = await query(`SELECT COUNT(*) AS c ${PLATFORM_FROM}`);
  const n = Number(rows[0]?.c);
  return Number.isFinite(n) ? n : 0;
}

async function listPlatformEvents({ page, limit } = {}) {
  const { page: p, limit: l } = normalizePlatformPaging(page, limit);
  const offset = (p - 1) * l;
  const [rows] = await query(
    `SELECT e.id, s.tenant_email, e.subscription_id, e.event_type, e.created_at
     ${PLATFORM_FROM}
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT ? OFFSET ?`,
    [l, offset]
  );
  return { events: rows.map(toPlatformEvent), page: p, limit: l };
}

module.exports = {
  TABLE,
  VALID_EVENT_TYPES,
  PLATFORM_LIMIT_MAX,
  append,
  listBySubscription,
  listByTenant,
  normalizePlatformPaging,
  countPlatformEvents,
  listPlatformEvents,
};
