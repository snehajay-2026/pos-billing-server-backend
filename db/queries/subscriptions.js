// db/queries/subscriptions.js
//
// Subscription queries — one row per tenant (root_owner_email).
//
// Three price concepts, never blurred:
//   A. plans.monthly_price / plans.yearly_price  — the catalogue price
//   B. subscriptions.subscribed_price            — the price snapshot at
//      subscription time; editing the catalogue never rewrites this
//   C. payment_records.amount                    — the actual money that moved
//
// Tenant scoping: a subscription belongs to a root_owner_email. SUPER_OWNER
// manages the catalogue and may read any tenant's subscription. ADMIN and
// below may only ever read their OWN tenant's row — there is no store-level
// subscription, so store scope is irrelevant here; the tenant email is the
// only key that matters.

const { query } = require("../pool");

const SUBSCRIPTION_STATUSES = new Set([
  "trialing",
  "active",
  "past_due",
  "cancelled",
  "expired",
]);

const BILLING_CYCLES = new Set(["monthly", "yearly"]);

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function rowToSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantEmail: row.tenant_email,
    planId: row.plan_id,
    planName: row.plan_name,
    billingCycle: row.billing_cycle,
    subscribedPrice: toNumber(row.subscribed_price),
    status: row.status,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    razorpaySubscriptionId: row.razorpay_subscription_id || null,
    pastDueSince: row.past_due_since ?? null,
    billingAnchorDay: row.billing_anchor_day ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function create({
  tenantEmail,
  planId,
  planName,
  billingCycle,
  subscribedPrice,
  status,
  startedAt,
  expiresAt,
  razorpaySubscriptionId = null,
  pastDueSince = null,
  billingAnchorDay = null,
}) {
  const [result] = await query(
    `INSERT INTO subscriptions
      (tenant_email, plan_id, plan_name, billing_cycle, subscribed_price,
       status, started_at, expires_at, razorpay_subscription_id,
       past_due_since, billing_anchor_day)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantEmail,
      planId,
      planName,
      billingCycle,
      subscribedPrice,
      status,
      startedAt,
      expiresAt,
      razorpaySubscriptionId,
      pastDueSince,
      billingAnchorDay,
    ]
  );
  return findById(result.insertId);
}

async function findById(id, conn = null) {
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  const [rows] = await exec(
    `SELECT * FROM subscriptions WHERE id = ? LIMIT 1`,
    [id]
  );
  return rowToSubscription(rows[0]);
}

async function findByTenant(tenantEmail) {
  const [rows] = await query(
    `SELECT * FROM subscriptions
     WHERE tenant_email = ?
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantEmail]
  );
  return rowToSubscription(rows[0]);
}

async function findByRazorpayId(razorpaySubscriptionId) {
  const [rows] = await query(
    `SELECT * FROM subscriptions
     WHERE razorpay_subscription_id = ?
     LIMIT 1`,
    [razorpaySubscriptionId]
  );
  return rowToSubscription(rows[0]);
}

async function listAll() {
  const [rows] = await query(
    `SELECT * FROM subscriptions ORDER BY created_at DESC`
  );
  return rows.map(rowToSubscription);
}

/**
 * Update whitelisted columns on a subscription, then re-read the row.
 *
 * @param {number} id
 * @param {object} fields - camelCase-mapped subset of `allowed` below
 * @param {object} [conn] - optional transaction connection from
 *   withTransaction(). When given, the UPDATE and the follow-up re-read
 *   run on it; otherwise they use the pool (unchanged legacy behavior).
 */
async function update(id, fields, conn = null) {
  // Accept camelCase or snake_case keys; both map to the same column.
  const normalized = { ...(fields || {}) };
  if (normalized.pastDueSince !== undefined && normalized.past_due_since === undefined) {
    normalized.past_due_since = normalized.pastDueSince;
  }
  if (normalized.billingAnchorDay !== undefined && normalized.billing_anchor_day === undefined) {
    normalized.billing_anchor_day = normalized.billingAnchorDay;
  }
  const allowed = [
    "plan_id",
    "plan_name",
    "billing_cycle",
    "subscribed_price",
    "status",
    "started_at",
    "expires_at",
    "razorpay_subscription_id",
    "past_due_since",
    "billing_anchor_day",
  ];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (normalized[key] !== undefined) {
      sets.push(`\`${key}\` = ?`);
      values.push(normalized[key]);
    }
  }
  if (sets.length === 0) return findById(id, conn);
  values.push(id);
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  await exec(
    `UPDATE subscriptions SET ${sets.join(", ")} WHERE id = ?`,
    values
  );
  return findById(id, conn);
}

module.exports = {
  SUBSCRIPTION_STATUSES,
  BILLING_CYCLES,
  create,
  findById,
  findByTenant,
  findByRazorpayId,
  listAll,
  update,
  rowToSubscription,
};
