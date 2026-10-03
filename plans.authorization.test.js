// plans.authorization.test.js
//
// Tests for the REAL db/queries/plans.js module with a stubbed pool —
// not hand-built fakes. These tests own the DB→service contract:
//
//   - TiDB rows carrying provider_plan_id / provider_plan_id_yearly arrive
//     at the subscription service as providerPlanId / providerPlanIdYearly
//   - monthly selects provider_plan_id; yearly selects
//     provider_plan_id_yearly (real row → real selectProviderPlanId)
//   - the SELECT statements actually issued by the module include both
//     provider plan columns
//   - a NULL provider plan ID for the selected cycle yields null, which the
//     service turns into PROVIDER_PLAN_MISSING before any provider call
//   - no test-only fake fields: the service selects from the real mapped
//     shape only
//
// The pool is stubbed via require.cache replacement, the same technique
// customers.authorization.test.js uses. No SQL is executed against a real
// database and no Razorpay calls are made.

const test = require("node:test");
const assert = require("node:assert/strict");

// --- Stub the pool before plans.js captures `query` --------------------------

const issued = [];

const TIDB_ROW = {
  id: 7,
  name: "Pro Plan",
  monthly_price: "999.00",
  yearly_price: "9990.00",
  provider_plan_id: "plan_monthly_ABC",
  provider_plan_id_yearly: "plan_yearly_XYZ",
  trial_days: 7,
  active: 1,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: {
    query: async (sql, params) => {
      issued.push({ sql, params });
      if (/INSERT INTO plans/i.test(sql)) {
        return [{ insertId: 7 }];
      }
      if (/UPDATE plans/i.test(sql)) {
        return [{ affectedRows: 1 }];
      }
      return [[{ ...TIDB_ROW }]];
    },
    withTransaction: async (fn) => fn({}),
  },
};

const plansQueries = require("./db/queries/plans");
const { selectProviderPlanId } = require("./lib/subscription-service");

// ===========================================================================
// 1. Real row → real mapped shape
// ===========================================================================

test("findById exposes providerPlanId and providerPlanIdYearly from TiDB columns", async () => {
  const plan = await plansQueries.findById(7);
  assert.equal(plan.providerPlanId, "plan_monthly_ABC");
  assert.equal(plan.providerPlanIdYearly, "plan_yearly_XYZ");
  // Prices and the rest of the shape are intact alongside the new fields.
  assert.equal(plan.monthlyPrice, 999);
  assert.equal(plan.yearlyPrice, 9990);
  assert.equal(plan.name, "Pro Plan");
});

test("rowToPlan maps snake_case provider columns to camelCase fields", () => {
  const plan = plansQueries.rowToPlan({
    ...TIDB_ROW,
    provider_plan_id: "plan_m",
    provider_plan_id_yearly: "plan_y",
  });
  assert.equal(plan.providerPlanId, "plan_m");
  assert.equal(plan.providerPlanIdYearly, "plan_y");
});

test("rowToPlan normalises NULL provider columns to null", () => {
  const plan = plansQueries.rowToPlan({
    ...TIDB_ROW,
    provider_plan_id: null,
    provider_plan_id_yearly: null,
  });
  assert.equal(plan.providerPlanId, null);
  assert.equal(plan.providerPlanIdYearly, null);
});

// ===========================================================================
// 2. The issued SQL includes both provider columns
// ===========================================================================

test("findById SELECT includes provider_plan_id and provider_plan_id_yearly", async () => {
  issued.length = 0;
  await plansQueries.findById(7);
  const { sql } = issued[issued.length - 1];
  assert.match(sql, /provider_plan_id\b/);
  assert.match(sql, /provider_plan_id_yearly/);
});

test("list SELECT includes provider_plan_id and provider_plan_id_yearly", async () => {
  issued.length = 0;
  await plansQueries.list({ activeOnly: true });
  const { sql } = issued[issued.length - 1];
  assert.match(sql, /provider_plan_id\b/);
  assert.match(sql, /provider_plan_id_yearly/);
});

// ===========================================================================
// 3. Real mapped shape drives the real service selector
// ===========================================================================

test("monthly cycle selects provider_plan_id from the real mapped plan", async () => {
  const plan = await plansQueries.findById(7);
  assert.equal(selectProviderPlanId(plan, "monthly"), "plan_monthly_ABC");
});

test("yearly cycle selects provider_plan_id_yearly from the real mapped plan", async () => {
  const plan = await plansQueries.findById(7);
  assert.equal(selectProviderPlanId(plan, "yearly"), "plan_yearly_XYZ");
});

test("NULL provider column for the selected cycle selects null (service reports PROVIDER_PLAN_MISSING)", async () => {
  const plan = plansQueries.rowToPlan({ ...TIDB_ROW, provider_plan_id: null });
  assert.equal(selectProviderPlanId(plan, "monthly"), null);
  const yearlyMissing = plansQueries.rowToPlan({ ...TIDB_ROW, provider_plan_id_yearly: null });
  assert.equal(selectProviderPlanId(yearlyMissing, "yearly"), null);
});
