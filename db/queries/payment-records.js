// db/queries/payment-records.js
//
// Every actual payment attempt for a subscription. This is price concept C —
// the real money that moved — and is deliberately separate from:
//   A. plans.monthly_price / yearly_price  (the catalogue price)
//   B. subscriptions.subscribed_price      (the snapshot at subscribe time)
//
// Idempotency: provider_payment_id carries a UNIQUE constraint. The webhook
// handler relies on this — a replayed provider event hits the duplicate key
// and is treated as a no-op rather than a second capture.

const { query } = require("../pool");

const TABLE = "payment_records";

const PAYMENT_STATUSES = new Set([
  "created",
  "authorized",
  "captured",
  "failed",
  "refunded",
]);

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rowToPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    providerPaymentId: row.provider_payment_id,
    amount: toNumber(row.amount),
    currency: row.currency || "INR",
    status: row.status,
    method: row.method || null,
    createdAt: row.created_at,
  };
}

/**
 * Record a payment attempt. Callers must treat a duplicate-key error on
 * provider_payment_id as "already recorded", not as a failure.
 *
 * @param {object} params - the row to insert
 * @param {object} [conn] - optional transaction connection from
 *   withTransaction(). When given, the INSERT and the follow-up re-read
 *   run on it; otherwise they use the pool (unchanged legacy behavior).
 */
async function create(
  {
    subscriptionId,
    providerPaymentId,
    amount,
    currency = "INR",
    status = "created",
    method = null,
  },
  conn = null
) {
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  const [result] = await exec(
    `INSERT INTO ${TABLE}
       (subscription_id, provider_payment_id, amount, currency, status, method)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [subscriptionId, providerPaymentId, amount, currency, status, method]
  );
  return findById(result.insertId, conn);
}

async function findById(id, conn = null) {
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  const [rows] = await exec(
    `SELECT * FROM ${TABLE} WHERE id = ? LIMIT 1`,
    [id]
  );
  return rowToPayment(rows[0]);
}

/**
 * Look up by the provider's payment id. This is the idempotency check the
 * webhook performs before applying any state change.
 */
async function findByProviderPaymentId(providerPaymentId) {
  const [rows] = await query(
    `SELECT * FROM ${TABLE} WHERE provider_payment_id = ? LIMIT 1`,
    [providerPaymentId]
  );
  return rowToPayment(rows[0]);
}

async function listBySubscription(subscriptionId, { limit = 50 } = {}) {
  const [rows] = await query(
    `SELECT * FROM ${TABLE}
     WHERE subscription_id = ?
     ORDER BY id DESC
     LIMIT ?`,
    [subscriptionId, limit]
  );
  return rows.map(rowToPayment);
}

/**
 * List every payment belonging to a tenant, newest first.
 */
async function listByTenant(tenantEmail, { limit = 100 } = {}) {
  const [rows] = await query(
    `SELECT p.*
     FROM ${TABLE} p
     INNER JOIN subscriptions s ON s.id = p.subscription_id
     WHERE s.tenant_email = ?
     ORDER BY p.id DESC
     LIMIT ?`,
    [tenantEmail, limit]
  );
  return rows.map(rowToPayment);
}

// ---------------------------------------------------------------------------
// Platform scope (SUPER_OWNER only, via GET /api/super/payment-records).
//
// A payment row carries no tenant column of its own — tenant identity comes
// from the parent subscription (subscriptions.tenant_email), exactly the
// same JOIN listByTenant already uses. Tenant ownership is therefore read
// from the database, never from request parameters.
//
// The field allowlist below is the contract for the platform Payments UI:
// id, tenantEmail (from the subscription join), subscriptionId,
// providerPaymentId (an opaque provider reference, safe to display),
// amount (rupees, as stored), currency, status, and createdAt. No API keys,
// webhook/signing secrets, or user personal data are selected.
// ---------------------------------------------------------------------------

const PLATFORM_PAGE_DEFAULT = 1;
const PLATFORM_LIMIT_DEFAULT = 25;
const PLATFORM_LIMIT_MAX = 100;

const toPlatformPayment = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    tenantEmail: row.tenant_email || null,
    subscriptionId: row.subscription_id,
    providerPaymentId: row.provider_payment_id,
    amount: toNumber(row.amount),
    currency: row.currency || "INR",
    status: row.status,
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

const PLATFORM_SELECT = `p.id, s.tenant_email, p.subscription_id,
    p.provider_payment_id, p.amount, p.currency, p.status, p.created_at`;

async function countPlatformPayments({ status } = {}) {
  const where = [];
  const params = [];
  if (status !== undefined) {
    where.push(`p.status = ?`);
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const [rows] = await query(
    `SELECT COUNT(*) AS c FROM ${TABLE} p
     INNER JOIN subscriptions s ON s.id = p.subscription_id
     ${whereSql}`,
    params
  );
  return toNumber(rows[0]?.c);
}

async function listPlatformPayments({ status, page, limit } = {}) {
  const { page: p, limit: l } = normalizePlatformPaging(page, limit);
  const where = [];
  const params = [];
  if (status !== undefined) {
    where.push(`p.status = ?`);
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const offset = (p - 1) * l;
  const [rows] = await query(
    `SELECT ${PLATFORM_SELECT} FROM ${TABLE} p
     INNER JOIN subscriptions s ON s.id = p.subscription_id
     ${whereSql}
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT ? OFFSET ?`,
    [...params, l, offset]
  );
  return { records: rows.map(toPlatformPayment), page: p, limit: l };
}

/**
 * Update status/method on an existing record. Used by the webhook when the
 * provider notifies a transition (authorized -> captured, or -> failed).
 */
async function update(id, fields, conn = null) {
  const allowed = ["status", "method", "amount", "currency"];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`\`${key}\` = ?`);
      values.push(fields[key]);
    }
  }
  if (sets.length === 0) return findById(id, conn);
  values.push(id);
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  await exec(`UPDATE ${TABLE} SET ${sets.join(", ")} WHERE id = ?`, values);
  return findById(id, conn);
}

module.exports = {
  TABLE,
  PAYMENT_STATUSES,
  PLATFORM_LIMIT_MAX,
  create,
  findById,
  findByProviderPaymentId,
  listBySubscription,
  listByTenant,
  update,
  rowToPayment,
  normalizePlatformPaging,
  countPlatformPayments,
  listPlatformPayments,
};
