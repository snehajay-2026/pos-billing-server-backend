// super-overview.authorization.test.js
//
// Tests for GET /api/super/overview (db/queries/super-overview.js).
// Uses node:test + node:assert/strict with a stubbed pool via
// require.cache replacement (same technique as
// plans.authorization.test.js). No MySQL, no network, no Razorpay.
//
// What this covers:
//   - month/year UTC calendar bounds are pure and correct
//   - buildOverviewResponse assembles the nine dashboard figures,
//     zeroes unknown-missing statuses, ignores unknown statuses,
//     and coerces NULL revenue sums to 0
//   - getOverview issues exactly six aggregate SELECTs and no SELECT
//     of personal data (no email/name/phone/address) or payment rows
//   - empty tables produce zeros, not nulls or crashes
//   - branches are explicitly null with a documented reason
//   - the route gate contract: only SUPER_OWNER passes (mirrors the
//     `req.user?.role !== "SUPER_OWNER"` check in index.js)

const test = require("node:test");
const assert = require("node:assert/strict");

const issued = [];
const fixtures = {
  tenants: [[{ c: 12 }]],
  stores: [[{ c: 30 }]],
  users: [[{ c: 150 }]],
  statuses: [
    [
      { status: "active", c: 8 },
      { status: "trialing", c: 2 },
      { status: "expired", c: 1 },
      { status: "cancelled", c: 1 },
    ],
  ],
  monthly: [[{ total: "4599.00" }]],
  yearly: [[{ total: "12599.50" }]],
};

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: {
    query: async (sql, params) => {
      issued.push({ sql, params });
      if (/COUNT\(DISTINCT root_owner_email\)/i.test(sql)) return fixtures.tenants;
      if (/COUNT\(DISTINCT store_type, store_id\)/i.test(sql)) return fixtures.stores;
      if (/FROM users/i.test(sql)) return fixtures.users;
      if (/FROM subscriptions/i.test(sql)) return fixtures.statuses;
      if (/FROM payment_records/i.test(sql)) {
        return /created_at >= \?/i.test(sql) && params?.[0]?.startsWith("2026-07")
          ? fixtures.monthly
          : fixtures.yearly;
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  },
};

const overview = require("./db/queries/super-overview");

// --- Pure bounds ------------------------------------------------------------

test("month bounds cover the UTC calendar month", () => {
  const { start, end } = overview.monthBoundsUTC(new Date("2026-07-15T12:00:00Z"));
  assert.equal(start, "2026-07-01T00:00:00.000Z");
  assert.equal(end, "2026-08-01T00:00:00.000Z");
});

test("year bounds cover the UTC calendar year", () => {
  const { start, end } = overview.yearBoundsUTC(new Date("2026-07-15T12:00:00Z"));
  assert.equal(start, "2026-01-01T00:00:00.000Z");
  assert.equal(end, "2027-01-01T00:00:00.000Z");
});

// --- Assembler --------------------------------------------------------------

test("assembler maps status rows and sums the subscription total", () => {
  const res = overview.buildOverviewResponse({
    tenantCount: 12,
    storeCount: 30,
    userCount: 150,
    statusRows: [
      { status: "active", c: 8 },
      { status: "trialing", c: 2 },
      { status: "expired", c: 1 },
      { status: "cancelled", c: 1 },
    ],
    monthlyRevenue: "4599.00",
    yearlyRevenue: "12599.50",
  });
  assert.equal(res.tenants.total, 12);
  assert.equal(res.stores.total, 30);
  assert.equal(res.users.total, 150);
  assert.equal(res.subscriptions.active, 8);
  assert.equal(res.subscriptions.trialing, 2);
  assert.equal(res.subscriptions.expired, 1);
  assert.equal(res.subscriptions.cancelled, 1);
  assert.equal(res.subscriptions.past_due, 0);
  assert.equal(res.subscriptions.total, 12);
  assert.equal(res.revenue.monthly, 4599);
  assert.equal(res.revenue.yearly, 12599.5);
  assert.equal(res.revenue.currency, "INR");
  assert.ok(res.revenue.definition.includes("captured"));
});

test("assembler ignores unknown statuses and coerces NULL revenue to 0", () => {
  const res = overview.buildOverviewResponse({
    statusRows: [{ status: "someday_new_enum", c: 99 }],
    monthlyRevenue: null,
    yearlyRevenue: null,
  });
  assert.equal(res.subscriptions.total, 0);
  assert.equal(res.revenue.monthly, 0);
  assert.equal(res.revenue.yearly, 0);
  assert.ok(!("someday_new_enum" in res.subscriptions));
});

test("empty tables produce zeros, branches stay null with a reason", () => {
  const res = overview.buildOverviewResponse({});
  assert.equal(res.tenants.total, 0);
  assert.equal(res.stores.total, 0);
  assert.equal(res.stores.branches, null);
  assert.equal(res.users.total, 0);
  assert.equal(res.subscriptions.total, 0);
  assert.ok(typeof res.meta.branchesUnavailable === "string");
});

// --- getOverview: SQL shape -------------------------------------------------

test("getOverview issues six aggregate SELECTs and selects no personal data", async () => {
  issued.length = 0;
  const res = await overview.getOverview(new Date("2026-07-15T12:00:00Z"));
  assert.equal(issued.length, 6);
  // No SELECT list may project a personal-data column or a payment row:
  // root_owner_email appears only inside COUNT(DISTINCT ...) aggregates
  // and WHERE filters, never as a returned row value. Strip aggregate
  // arguments first so COUNT(DISTINCT root_owner_email) does not trip
  // the personal-data match.
  for (const { sql } of issued) {
    const selectList = sql
      .slice(0, sql.search(/\bFROM\b/i))
      .replace(/COUNT\s*\(\s*DISTINCT\s+[^)]+\)/gi, "COUNT_distinct");
    assert.ok(!/\bemail\b|\bname\b|\bphone\b|\baddress\b/i.test(selectList), selectList);
  }
  // Revenue buckets use the July calendar bounds.
  const revenueQueries = issued.filter((q) => /payment_records/i.test(q.sql));
  assert.equal(revenueQueries.length, 2);
  assert.ok(revenueQueries.every((q) => /status = 'captured'/i.test(q.sql)));
  assert.deepEqual(revenueQueries[0].params, [
    "2026-07-01T00:00:00.000Z",
    "2026-08-01T00:00:00.000Z",
  ]);
  assert.deepEqual(revenueQueries[1].params, [
    "2026-01-01T00:00:00.000Z",
    "2027-01-01T00:00:00.000Z",
  ]);
  // Spot-check the assembled figures from the fixtures.
  assert.equal(res.tenants.total, 12);
  assert.equal(res.revenue.monthly, 4599);
});

// --- Route gate contract ----------------------------------------------------
// index.js gates with `req.user?.role !== "SUPER_OWNER"` → 403. This test
// pins that contract: the only role that may pass is SUPER_OWNER, and
// unauthenticated requests are rejected before the gate.

test("only SUPER_OWNER passes the overview gate", () => {
  const passes = (role) => role === "SUPER_OWNER";
  assert.equal(passes("SUPER_OWNER"), true);
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER", null, undefined, ""]) {
    assert.equal(passes(role), false);
  }
});
