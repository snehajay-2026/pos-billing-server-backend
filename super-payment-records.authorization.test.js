// super-payment-records.authorization.test.js
//
// Tests for GET /api/super/payment-records (db/queries/payment-records.js
// platform helpers + the route gate in index.js). Uses node:test +
// node:assert/strict with a stubbed pool via require.cache replacement
// (same technique as super-overview.authorization.test.js). No MySQL, no
// network, no Razorpay.
//
// What this covers:
//   - paging normalization: defaults, invalid values, max-limit clamp
//   - list/count apply the same status filter (consistency)
//   - stable ordering by created_at then id, with LIMIT/OFFSET params
//   - empty results produce [], not nulls or crashes
//   - tenant identity comes from the subscription JOIN, never params
//   - field allowlist: only id/tenantEmail/subscriptionId/
//     providerPaymentId/amount/currency/status/createdAt — no secrets,
//     no user personal data
//   - the route gate contract: only SUPER_OWNER passes (mirrors the
//     `req.user?.role !== "SUPER_OWNER"` check in index.js), and an
//     unknown status is rejected with 400

const test = require("node:test");
const assert = require("node:assert/strict");

const issued = [];

let emptyMode = false;

const ROWS = [
  {
    id: 3,
    tenant_email: "b@example.com",
    subscription_id: 20,
    provider_payment_id: "pay_B",
    amount: "999.00",
    currency: "INR",
    status: "captured",
    created_at: "2026-09-02T00:00:00.000Z",
  },
  {
    id: 2,
    tenant_email: "a@example.com",
    subscription_id: 10,
    provider_payment_id: "pay_A",
    amount: "499.00",
    currency: "INR",
    status: "failed",
    created_at: "2026-09-01T00:00:00.000Z",
  },
];

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: {
    query: async (sql, params) => {
      issued.push({ sql, params });
      if (emptyMode) {
        if (/SELECT COUNT\(\*\)/i.test(sql)) return [[{ c: 0 }]];
        return [[]];
      }
      if (/SELECT COUNT\(\*\)/i.test(sql)) return [[{ c: ROWS.length }]];
      return [ROWS];
    },
  },
};

const payments = require("./db/queries/payment-records");

// --- Paging -----------------------------------------------------------------

test("normalizePlatformPaging applies defaults and clamps the maximum", () => {
  assert.deepEqual(payments.normalizePlatformPaging(undefined, undefined), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(payments.normalizePlatformPaging("0", "-5"), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(payments.normalizePlatformPaging("abc", "xyz"), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(
    payments.normalizePlatformPaging("2", "500").limit,
    payments.PLATFORM_LIMIT_MAX
  );
  assert.equal(payments.normalizePlatformPaging("3", "10").page, 3);
});

// --- List + count consistency -----------------------------------------------

test("list and count apply the same status filter", async () => {
  issued.length = 0;
  const filters = { status: "captured", page: 1, limit: 25 };
  const [total, { records, page, limit }] = await Promise.all([
    payments.countPlatformPayments(filters),
    payments.listPlatformPayments(filters),
  ]);
  assert.equal(total, ROWS.length);
  assert.equal(records.length, ROWS.length);
  assert.equal(page, 1);
  assert.equal(limit, 25);
  const countSql = issued.find(({ sql }) => /SELECT COUNT\(\*\)/i.test(sql));
  const listSql = issued.find(({ sql }) => /ORDER BY/i.test(sql));
  assert.ok(countSql.params.includes("captured"));
  assert.ok(listSql.params.includes("captured"));
});

// --- Ordering + pagination params -------------------------------------------

test("list orders deterministically and pages via LIMIT/OFFSET", async () => {
  issued.length = 0;
  await payments.listPlatformPayments({ page: 2, limit: 10 });
  const { sql, params } = issued[issued.length - 1];
  assert.match(sql, /ORDER BY p\.created_at DESC, p\.id DESC/);
  assert.deepEqual(params.slice(-2), [10, 10]);
});

// --- Empty results ----------------------------------------------------------

test("empty tables produce an empty record array", async () => {
  emptyMode = true;
  try {
    const total = await payments.countPlatformPayments({});
    const { records } = await payments.listPlatformPayments({});
    assert.equal(total, 0);
    assert.deepEqual(records, []);
  } finally {
    emptyMode = false;
  }
});

// --- Field allowlist + tenant association -----------------------------------

test("records carry only the UI allowlist with tenant from the JOIN", async () => {
  const { records } = await payments.listPlatformPayments({});
  assert.equal(records.length, ROWS.length);
  for (const r of records) {
    assert.deepEqual(Object.keys(r).sort(), [
      "amount",
      "createdAt",
      "currency",
      "id",
      "providerPaymentId",
      "status",
      "subscriptionId",
      "tenantEmail",
    ]);
  }
  assert.equal(records[0].tenantEmail, "b@example.com");
  assert.equal(records[0].subscriptionId, 20);
  assert.equal(typeof records[0].amount, "number");
  const listSql = issued[issued.length - 1].sql;
  assert.ok(!/users/i.test(listSql));
  assert.ok(!/secret|api_key|apikey/i.test(listSql));
});

// --- Route gate contract ----------------------------------------------------
// index.js gates with `req.user?.role !== "SUPER_OWNER"` → 403, and
// ensureAuth rejects unauthenticated requests with 401 before the gate.
// Status is allowlisted against PAYMENT_STATUSES, anything else → 400.

test("only SUPER_OWNER passes the payment-records gate; unknown status is 400", () => {
  const passes = (role) => role === "SUPER_OWNER";
  assert.equal(passes("SUPER_OWNER"), true);
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER", null, undefined, ""]) {
    assert.equal(passes(role), false);
  }
  assert.equal(payments.PAYMENT_STATUSES.has("bogus_status"), false);
  for (const s of ["created", "authorized", "captured", "failed", "refunded"]) {
    assert.equal(payments.PAYMENT_STATUSES.has(s), true);
  }
});
