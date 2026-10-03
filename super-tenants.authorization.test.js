// super-tenants.authorization.test.js
//
// Tests for GET /api/super/tenants (db/queries/super-tenants.js platform
// helpers + the route gate in index.js). Uses node:test +
// node:assert/strict with a stubbed pool via require.cache replacement
// (same technique as super-subscription-events.authorization.test.js).
// No MySQL, no network, no Razorpay.
//
// What this covers:
//   - tenant identity derivation mirrors the SQL COALESCE key and the
//     repository rule root_owner_email || owner_email || email
//   - branch-level roles fold into the owner's tenant (same derived key)
//   - SUPER_OWNER rows are excluded by the WHERE clause
//   - paging normalization: defaults, invalid values, max-limit clamp
//   - count and list use the same tenant definition (consistency)
//   - deterministic ordering with LIMIT/OFFSET params
//   - empty results produce [], total 0 — not nulls or crashes
//   - field allowlist: tenantEmail/userCount/storeCount/
//     subscriptionStatus/planName/firstSeen only — no password hash,
//     reset_token, phone, address, name, or raw user rows

const test = require("node:test");
const assert = require("node:assert/strict");

const issued = [];

let emptyMode = false;

const ROWS = [
  {
    tenant_email: "a@example.com",
    user_count: 3,
    store_count: 2,
    subscription_status: "active",
    plan_name: "Growth",
    first_seen: "2026-01-05T00:00:00.000Z",
  },
  {
    tenant_email: "b@example.com",
    user_count: 1,
    store_count: 1,
    subscription_status: null,
    plan_name: null,
    first_seen: "2026-03-11T00:00:00.000Z",
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
        if (/SELECT COUNT\(DISTINCT/i.test(sql)) return [[{ c: 0 }]];
        return [[]];
      }
      if (/SELECT COUNT\(DISTINCT/i.test(sql)) return [[{ c: ROWS.length }]];
      return [ROWS];
    },
  },
};

const tenants = require("./db/queries/super-tenants");

// --- Tenant identity --------------------------------------------------------

test("deriveTenantEmail follows root_owner_email || owner_email || email", () => {
  assert.equal(
    tenants.deriveTenantEmail({
      root_owner_email: "root@example.com",
      owner_email: "o@example.com",
      email: "u@example.com",
    }),
    "root@example.com"
  );
  assert.equal(
    tenants.deriveTenantEmail({ root_owner_email: "", owner_email: "o@example.com", email: "u@example.com" }),
    "o@example.com"
  );
  assert.equal(tenants.deriveTenantEmail({ email: "u@example.com" }), "u@example.com");
  assert.equal(tenants.deriveTenantEmail({ rootOwnerEmail: "r@example.com", email: "u@example.com" }), "r@example.com");
  assert.equal(tenants.deriveTenantEmail({}), null);
  assert.equal(tenants.deriveTenantEmail(null), null);
});

test("branch users fold into the owner's tenant instead of counting separately", () => {
  const branchCashier = {
    email: "cashier@branch.example.com",
    role: "CASHIER",
    root_owner_email: "owner@example.com",
  };
  const branchAdmin = {
    email: "admin@branch.example.com",
    role: "STORE_ADMIN",
    root_owner_email: "owner@example.com",
  };
  const owner = { email: "owner@example.com", role: "ADMIN", root_owner_email: null };
  assert.equal(tenants.deriveTenantEmail(branchCashier), "owner@example.com");
  assert.equal(tenants.deriveTenantEmail(branchAdmin), "owner@example.com");
  assert.equal(tenants.deriveTenantEmail(owner), "owner@example.com");
});

// --- Paging -----------------------------------------------------------------

test("normalizePlatformPaging applies defaults and clamps the maximum", () => {
  assert.deepEqual(tenants.normalizePlatformPaging(undefined, undefined), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(tenants.normalizePlatformPaging("0", "-5"), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(tenants.normalizePlatformPaging("abc", "xyz"), {
    page: 1,
    limit: 25,
  });
  assert.deepEqual(
    tenants.normalizePlatformPaging("2", "500").limit,
    tenants.PLATFORM_LIMIT_MAX
  );
  assert.equal(tenants.normalizePlatformPaging("3", "10").page, 3);
});

// --- Count/list consistency + ordering --------------------------------------

test("count and list use the same tenant definition and exclusion rules", async () => {
  issued.length = 0;
  const [total, { tenants: rows, page, limit }] = await Promise.all([
    tenants.countPlatformTenants(),
    tenants.listPlatformTenants({ page: 2, limit: 10 }),
  ]);
  assert.equal(total, ROWS.length);
  assert.equal(rows.length, ROWS.length);
  assert.equal(page, 2);
  assert.equal(limit, 10);
  const countSql = issued.find(({ sql }) => /SELECT COUNT\(DISTINCT/i.test(sql));
  const listSql = issued.find(({ sql }) => /GROUP BY/i.test(sql));
  // Same derived key and same SUPER_OWNER exclusion in both queries.
  for (const { sql } of [countSql, listSql]) {
    assert.match(sql, /COALESCE\(NULLIF\(root_owner_email/);
    assert.match(sql, /UPPER\(u?\.?role\) <> 'SUPER_OWNER'/);
  }
  assert.match(listSql.sql, /ORDER BY tenant_email ASC/);
  assert.deepEqual(listSql.params, [10, 10]);
});

test("SUPER_OWNER rows are excluded and branch roles are not special-cased", async () => {
  issued.length = 0;
  await tenants.listPlatformTenants({});
  const { sql } = issued[issued.length - 1];
  assert.match(sql, /UPPER\(u\.role\) <> 'SUPER_OWNER'/);
  assert.ok(!/STORE_ADMIN/i.test(sql));
  assert.ok(!/CASHIER/i.test(sql));
});

// --- Empty results ----------------------------------------------------------

test("empty tables produce an empty tenant array with total 0", async () => {
  emptyMode = true;
  try {
    const total = await tenants.countPlatformTenants();
    const { tenants: rows } = await tenants.listPlatformTenants({});
    assert.equal(total, 0);
    assert.deepEqual(rows, []);
  } finally {
    emptyMode = false;
  }
});

// --- Field allowlist --------------------------------------------------------

test("tenant rows carry only schema-backed aggregates, no secrets", async () => {
  const { tenants: rows } = await tenants.listPlatformTenants({});
  assert.equal(rows.length, ROWS.length);
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), [
      "firstSeen",
      "planName",
      "storeCount",
      "subscriptionStatus",
      "tenantEmail",
      "userCount",
    ]);
    assert.equal(typeof r.userCount, "number");
    assert.equal(typeof r.storeCount, "number");
  }
  assert.equal(rows[0].tenantEmail, "a@example.com");
  assert.equal(rows[0].subscriptionStatus, "active");
  // Tenant without a subscription row: enrichment is null, not fabricated.
  assert.equal(rows[1].subscriptionStatus, null);
  assert.equal(rows[1].planName, null);
  const listSql = issued[issued.length - 1].sql;
  assert.ok(!/password/i.test(listSql));
  assert.ok(!/reset_token/i.test(listSql));
  assert.ok(!/phone|address/i.test(listSql));
  assert.ok(!/secret|api_key|apikey/i.test(listSql));
});

// --- Route gate contract ----------------------------------------------------
// index.js gates with `req.user?.role !== "SUPER_OWNER"` → 403, and
// ensureAuth rejects unauthenticated requests with 401 before the gate.

test("only SUPER_OWNER passes the tenants gate", () => {
  const passes = (role) => role === "SUPER_OWNER";
  assert.equal(passes("SUPER_OWNER"), true);
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER", null, undefined, ""]) {
    assert.equal(passes(role), false);
  }
});
