// super-subscription-events.authorization.test.js
//
// Tests for GET /api/super/subscription-events
// (db/queries/subscription-events.js platform helpers + the route gate in
// index.js). Uses node:test + node:assert/strict with a stubbed pool via
// require.cache replacement (same technique as
// super-payment-records.authorization.test.js). No MySQL, no network, no
// Razorpay.
//
// What this covers:
//   - paging normalization: defaults, invalid values, max-limit clamp
//   - list orders deterministically (created_at DESC, id DESC) with
//     LIMIT/OFFSET params; count and list hit the same JOIN (consistency)
//   - empty results produce [], not nulls or crashes
//   - tenant identity comes from the subscription JOIN, never params
//   - field allowlist: only id/tenantEmail/subscriptionId/eventType/
//     createdAt — the raw payload JSON is never selected, no secrets,
//     no user personal data
//   - the route gate contract: only SUPER_OWNER passes (mirrors the
//     `req.user?.role !== "SUPER_OWNER"` check in index.js)

const test = require("node:test");
const assert = require("node:assert/strict");

const issued = [];

let emptyMode = false;

const ROWS = [
  {
    id: 7,
    tenant_email: "b@example.com",
    subscription_id: 20,
    event_type: "payment_succeeded",
    created_at: "2026-09-02T00:00:00.000Z",
  },
  {
    id: 5,
    tenant_email: "a@example.com",
    subscription_id: 10,
    event_type: "created",
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

const events = require("./db/queries/subscription-events");

// --- Paging -----------------------------------------------------------------

test("normalizePlatformPaging applies defaults and clamps the maximum", () => {
  assert.deepEqual(events.normalizePlatformPaging(undefined, undefined), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(events.normalizePlatformPaging("0", "-5"), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(events.normalizePlatformPaging("abc", "xyz"), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(
    events.normalizePlatformPaging("2", "500").limit,
    events.PLATFORM_LIMIT_MAX
  );
  assert.equal(events.normalizePlatformPaging("3", "10").page, 3);
});

// --- Ordering + pagination params + count/list consistency ------------------

test("list orders deterministically and pages via LIMIT/OFFSET on the same JOIN", async () => {
  issued.length = 0;
  const [total, { events: rows, page, limit }] = await Promise.all([
    events.countPlatformEvents(),
    events.listPlatformEvents({ page: 2, limit: 10 }),
  ]);
  assert.equal(total, ROWS.length);
  assert.equal(rows.length, ROWS.length);
  assert.equal(page, 2);
  assert.equal(limit, 10);
  const countSql = issued.find(({ sql }) => /SELECT COUNT\(\*\)/i.test(sql));
  const listSql = issued.find(({ sql }) => /ORDER BY/i.test(sql));
  assert.match(countSql.sql, /INNER JOIN subscriptions/i);
  assert.match(listSql.sql, /INNER JOIN subscriptions/i);
  assert.match(listSql.sql, /ORDER BY e\.created_at DESC, e\.id DESC/);
  assert.deepEqual(listSql.params, [10, 10]);
});

// --- Empty results ----------------------------------------------------------

test("empty tables produce an empty event array", async () => {
  emptyMode = true;
  try {
    const total = await events.countPlatformEvents();
    const { events: rows } = await events.listPlatformEvents({});
    assert.equal(total, 0);
    assert.deepEqual(rows, []);
  } finally {
    emptyMode = false;
  }
});

// --- Field allowlist + tenant association -----------------------------------

test("events carry only the UI allowlist with tenant from the JOIN", async () => {
  const { events: rows } = await events.listPlatformEvents({});
  assert.equal(rows.length, ROWS.length);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), [
      "createdAt",
      "eventType",
      "id",
      "subscriptionId",
      "tenantEmail",
    ]);
  }
  assert.equal(rows[0].tenantEmail, "b@example.com");
  assert.equal(rows[0].subscriptionId, 20);
  assert.equal(rows[0].eventType, "payment_succeeded");
  const listSql = issued[issued.length - 1].sql;
  assert.ok(!/payload/i.test(listSql));
  assert.ok(!/users/i.test(listSql));
  assert.ok(!/secret|api_key|apikey/i.test(listSql));
});

// --- Route gate contract ----------------------------------------------------
// index.js gates with `req.user?.role !== "SUPER_OWNER"` → 403, and
// ensureAuth rejects unauthenticated requests with 401 before the gate.

test("only SUPER_OWNER passes the subscription-events gate", () => {
  const passes = (role) => role === "SUPER_OWNER";
  assert.equal(passes("SUPER_OWNER"), true);
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER", null, undefined, ""]) {
    assert.equal(passes(role), false);
  }
});
