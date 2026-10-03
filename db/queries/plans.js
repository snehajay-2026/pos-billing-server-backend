// db/queries/plans.js
//
// Plan catalogue queries. SUPER_OWNER manages the catalogue; every other role
// reads it to render the plan-selection UI. Prices are database-driven —
// nothing here hard-codes a price.
//
// Three price concepts must never blur:
//   A. plans.monthly_price / yearly_price  — the catalogue price
//   B. subscriptions.subscribed_price      — the snapshot at subscribe time
//   C. payment_records.amount              — the actual money that moved
//
// This module only touches concept A.

const { query } = require("../pool");

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// Provider plan IDs are selected by the backend, never accepted from the
// frontend. The monthly and yearly cycles bill against two distinct
// Razorpay plans, so both columns must reach the subscription service.
// A NULL means that cycle is not purchasable and must fail with
// PROVIDER_PLAN_MISSING before any provider call is made.
const rowToPlan = (row) => {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    monthlyPrice: toNumber(row.monthly_price),
    yearlyPrice: toNumber(row.yearly_price),
    providerPlanId: row.provider_plan_id || null,
    providerPlanIdYearly: row.provider_plan_id_yearly || null,
    trialDays: row.trial_days === null || row.trial_days === undefined
      ? 0
      : Number(row.trial_days),
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

// Column list shared by every read in this module. `SELECT *` would also
// work, but naming the columns keeps the provider plan IDs explicit and
// makes a dropped column fail here rather than silently downstream.
const PLAN_COLUMNS = [
  "id",
  "name",
  "monthly_price",
  "yearly_price",
  "provider_plan_id",
  "provider_plan_id_yearly",
  "trial_days",
  "active",
  "created_at",
  "updated_at",
].join(", ");

// List all plans, optionally filtered to active-only.
const list = async ({ activeOnly = false } = {}) => {
  const sql = activeOnly
    ? `SELECT ${PLAN_COLUMNS} FROM plans WHERE active = 1 ORDER BY monthly_price ASC`
    : `SELECT ${PLAN_COLUMNS} FROM plans ORDER BY monthly_price ASC`;
  const [rows] = await query(sql);
  return (rows || []).map(rowToPlan);
};

const findById = async (id) => {
  const [rows] = await query(
    `SELECT ${PLAN_COLUMNS} FROM plans WHERE id = ?`,
    [id]
  );
  return rowToPlan(rows && rows[0]);
};

// Create a plan. SUPER_OWNER only — enforced by the route.
// providerPlanId / providerPlanIdYearly are nullable: a NULL cycle is simply
// not purchasable, and the subscription service reports it as
// PROVIDER_PLAN_MISSING rather than calling the provider.
const create = async ({
  name,
  monthlyPrice,
  yearlyPrice,
  trialDays,
  active,
  providerPlanId = null,
  providerPlanIdYearly = null,
}) => {
  const [result] = await query(
    `INSERT INTO plans
       (name, monthly_price, yearly_price, trial_days, active,
        provider_plan_id, provider_plan_id_yearly)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      name,
      monthlyPrice,
      yearlyPrice,
      trialDays,
      active ? 1 : 0,
      providerPlanId,
      providerPlanIdYearly,
    ]
  );
  return findById(result.insertId);
};

// SUPER_OWNER can edit: plan name, monthly price, yearly price, trial days,
// active/inactive status, and the two provider plan IDs. Nothing else is
// mutable. Passing null for a provider plan ID clears it.
const update = async (id, fields) => {
  const allowed = [
    "name",
    "monthly_price",
    "yearly_price",
    "trial_days",
    "active",
    "provider_plan_id",
    "provider_plan_id_yearly",
  ];
  const sets = [];
  const values = [];
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`\`${key}\` = ?`);
    values.push(fields[key]);
  }
  if (sets.length === 0) return findById(id);
  values.push(id);
  await query(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`, values);
  return findById(id);
};

module.exports = {
  list,
  findById,
  create,
  update,
  rowToPlan,
};
