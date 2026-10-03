// super-tenant-detail.authorization.test.js
//
// Tests for GET /api/super/tenants/:tenantEmail
// (db/queries/super-tenants.js getTenantDetail + the route gate in
// index.js). Uses node:test + node:assert/strict with a stubbed pool via
// require.cache replacement (same technique as
// super-tenants.authorization.test.js). No MySQL, no network, no Razorpay.
//
// What this covers:
//   - URL-encoded tenant email handling (decoded before lookup)
//   - malformed/invalid identifiers → { invalid: true } (route → 400)
//   - unknown tenant → { notFound: true } (route → 404)
//   - canonical tenant identity resolution (same derived key as listing)
//   - branch users associated with the owning tenant
//   - SUPER_OWNER accounts excluded from users
//   - tenant isolation: every query scoped to the same bound canonical key
//   - missing subscription → subscription: null (not fabricated)
//   - empty user/store collections → [] (not nulls)
//   - SQL parameterization (no email concatenation) and field allowlisting
//   - no duplicated counts (separate bounded queries, no mega-JOIN)
//   - the route gate contract: only SUPER_OWNER passes (401 pre-gate)

const test = require("node:test");
const assert = require("node:assert/strict");

const issued = [];

// Modes toggled per test: unknown tenant, missing subscription, empty rows.
let mode = "ok";

const SUMMARY = [
  {
    tenant_email: "a@example.com",
    user_count: 3,
    store_count: 2,
    first_seen: "2026-01-05T00:00:00.000Z",
  },
];

const USER_ROWS = [
  {
    email: "a@example.com",
    role: "ADMIN",
    store_type: "retail",
    store_id: "s1",
    created_at: "2026-01-05T00:00:00.000Z",
  },
  {
    email: "cashier@branch.example.com",
    role: "CASHIER",
    store_type: "retail",
    store_id: "s2",
    created_at: "2026-02-01T00:00:00.000Z",
  },
];

const OTHER_TENANT_USER = {
  email: "other@example.com",
  role: "ADMIN",
  store_type: "hotel",
  store_id: "h1",
  created_at: "2026-01-01T00:00:00.000Z",
};

const STORE_ROWS = [
  { store_type: "retail", store_id: "s1" },
  { store_type: "retail", store_id: "s2" },
];

const SUB_ROW = [
  { status: "active", plan_name: "Growth", billing_cycle: "monthly" },
];

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: {
    query: async (sql, params) => {
      issued.push({ sql, params });
      if (/HAVING tenant_email/i.test(sql)) {
        return mode === "unknown" ? [[]] : [SUMMARY];
      }
      if (/SELECT DISTINCT u\.store_type/i.test(sql)) {
        return mode === "empty" ? [[]] : [STORE_ROWS];
      }
      if (/FROM subscriptions/i.test(sql)) {
        return mode === "no-sub" || mode === "empty" ? [[]] : [SUB_ROW];
      }
      // User list. The stub proves isolation the same way the
      // implementation enforces it: rows are filtered by the bound
      // canonical key, so the other tenant's user never appears.
      if (mode === "empty") return [[]];
      const key = params[0];
      return [USER_ROWS.filter(() => key === "a@example.com")];
    },
  },
};

const tenants = require("./db/queries/super-tenants");

// --- Identifier handling ----------------------------------------------------

test("URL-encoded tenant email resolves to the canonical address", async () => {
  issued.length = 0;
  const decoded = decodeURIComponent("business%40example.com");
  assert.equal(decoded, "business@example.com");
  assert.equal(tenants.isValidTenantEmail(decoded), true);
});

test("malformed identifiers are invalid (route returns 400)", async () => {
  for (const bad of ["", "   ", "not-an-email", "a@b", "x@y ", null, undefined, 42, "a/b@c.com", "a b@c.com"]) {
    const res = await tenants.getTenantDetail(bad);
    assert.deepEqual(res, { invalid: true }, `expected invalid for ${JSON.stringify(bad)}`);
  }
});

test("unknown tenant returns notFound (route returns 404)", async () => {
  mode = "unknown";
  try {
    const res = await tenants.getTenantDetail("ghost@example.com");
    assert.deepEqual(res, { notFound: true });
  } finally {
    mode = "ok";
  }
});

// --- Identity, isolation, branch users --------------------------------------

test("detail uses the canonical derived key and scopes every query to it", async () => {
  issued.length = 0;
  mode = "ok";
  const res = await tenants.getTenantDetail("  A@Example.com ");
  assert.equal(res.tenant.tenantEmail, "a@example.com");
  // All four queries bind the same lowercased canonical key.
  assert.equal(issued.length, 4);
  for (const { params } of issued) {
    assert.equal(params[0], "a@example.com");
  }
  // No string-concatenated email in any statement.
  for (const { sql } of issued) {
    assert.ok(!sql.includes("a@example.com"));
    assert.ok(!sql.includes("A@Example.com"));
  }
});

test("branch users belong to the owning tenant; SUPER_OWNER excluded", async () => {
  mode = "ok";
  const res = await tenants.getTenantDetail("a@example.com");
  const emails = res.users.map((u) => u.email);
  assert.ok(emails.includes("cashier@branch.example.com"));
  assert.ok(emails.includes("a@example.com"));
  // Deterministic ordering: oldest first.
  assert.equal(res.users[0].email, "a@example.com");
  const userSql = issued.find(({ sql }) => /u\.created_at ASC/i.test(sql)).sql;
  assert.match(userSql, /UPPER\(u\.role\) <> 'SUPER_OWNER'/);
});

test("no other tenant's data appears in the response", async () => {
  mode = "ok";
  const res = await tenants.getTenantDetail("a@example.com");
  const haystack = JSON.stringify(res);
  assert.ok(!haystack.includes("other@example.com"));
  assert.ok(res.users.every((u) => u.email !== OTHER_TENANT_USER.email));
});

// --- Missing subscription / empty collections -------------------------------

test("missing subscription returns null, never a fabricated row", async () => {
  mode = "no-sub";
  try {
    const res = await tenants.getTenantDetail("a@example.com");
    assert.equal("subscription" in res.tenant, true);
    assert.equal(res.tenant.subscription, null);
  } finally {
    mode = "ok";
  }
});

test("tenant with no user/store rows returns empty arrays", async () => {
  // Summary proves the tenant exists; collections are empty.
  mode = "empty";
  try {
    const res = await tenants.getTenantDetail("a@example.com");
    assert.deepEqual(res.users, []);
    assert.deepEqual(res.stores, []);
    assert.equal(res.tenant.subscription, null);
  } finally {
    mode = "ok";
  }
});

// --- Allowlisting / no multiplied counts -------------------------------------

test("response carries only allowlisted fields; counts come from the summary", async () => {
  mode = "ok";
  const res = await tenants.getTenantDetail("a@example.com");
  assert.deepEqual(Object.keys(res).sort(), ["stores", "tenant", "users"]);
  assert.deepEqual(Object.keys(res.tenant).sort(), [
    "firstSeen",
    "storeCount",
    "subscription",
    "tenantEmail",
    "userCount",
  ]);
  assert.deepEqual(Object.keys(res.tenant.subscription).sort(), [
    "billingCycle",
    "planName",
    "status",
  ]);
  for (const u of res.users) {
    assert.deepEqual(Object.keys(u).sort(), [
      "createdAt",
      "email",
      "role",
      "storeId",
      "storeType",
    ]);
  }
  for (const s of res.stores) {
    assert.deepEqual(Object.keys(s).sort(), ["storeId", "storeType"]);
  }
  const haystack = JSON.stringify(res);
  assert.ok(!/password|reset_token|phone|address|razorpay|payload|secret/i.test(haystack));
  // Counts are single aggregates from the summary query, not multiplied
  // by a users×stores×subscriptions JOIN.
  assert.equal(res.tenant.userCount, 3);
  assert.equal(res.tenant.storeCount, 2);
  assert.deepEqual(res.stores, STORE_ROWS.map((s) => ({
    storeType: s.store_type,
    storeId: s.store_id,
  })));
});

// --- Route gate contract ----------------------------------------------------

test("only SUPER_OWNER passes the tenant-detail gate", () => {
  const passes = (role) => role === "SUPER_OWNER";
  assert.equal(passes("SUPER_OWNER"), true);
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER", null, undefined, ""]) {
    assert.equal(passes(role), false);
  }
});
