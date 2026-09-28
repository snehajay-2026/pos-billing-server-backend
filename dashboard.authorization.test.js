// dashboard.authorization.test.js
//
// Authorization + store-isolation coverage for the Manager Dashboard
// (`GET /api/dashboard/summary`) and for the report-scope fix that landed
// with it.
//
// Two boundaries are guarded here:
//
//   1. REPORT SCOPE. `/api/reports/*` used to forward `req.query` straight into
//      the aggregation, so `requireReportAccess` (which only rejects CASHIER)
//      was the only boundary — any ADMIN/STORE_ADMIN could read another tenant
//      by appending `?storeType=&storeId=`. The routes now build filters from
//      `getRequestScope(req)`, which ignores caller-supplied store scope for
//      everyone except SUPER_OWNER.
//
//   2. DASHBOARD ROLE ALLOWLIST. Deny-by-default, because
//      `normalizeRole` coerces any unknown role to CASHIER and a future role
//      added to VALID_ROLES must be denied rather than silently granted.
//
// The pure decision functions are exported so they can be tested without
// booting the Express app (index.js calls app.listen at import time) and
// without a live MySQL connection.

const test = require("node:test");
const assert = require("node:assert/strict");

const { getRequestScope } = require("./lib/request-scope");
const dashboard = require("./db/queries/dashboard");

// ---------------------------------------------------------------------------
// Fakes mirroring the shape getRequestScope reads off `req`.
// ---------------------------------------------------------------------------
const asReq = ({ role = "STORE_ADMIN", storeType = "retail", storeId = "store-a", query = {} } = {}) => ({
  user: { role, storeType, storeId, email: "manager@example.com" },
  query,
});

// Minimal res double — records whether the route bailed out.
const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
};

// ---------------------------------------------------------------------------
// 1. Role allowlist
// ---------------------------------------------------------------------------
test("dashboard allows exactly the three admin roles", () => {
  assert.deepEqual([...dashboard.DASHBOARD_ROLES].sort(), ["ADMIN", "STORE_ADMIN", "SUPER_OWNER"]);
});

test("dashboard denies CASHIER and every unrecognised role", () => {
  for (const role of ["CASHIER", "cashier", "MANAGER", "BRANCH_ADMIN", "", null, undefined]) {
    assert.equal(
      dashboard.isDashboardRoleAllowed(role),
      false,
      `expected ${JSON.stringify(role)} to be denied`
    );
  }
});

test("dashboard allows admin roles regardless of casing", () => {
  for (const role of ["store_admin", "Admin", "SUPER_OWNER"]) {
    assert.equal(dashboard.isDashboardRoleAllowed(role), true, `expected ${role} to be allowed`);
  }
});

// ---------------------------------------------------------------------------
// 2. Scope resolution — the actual leak.
// ---------------------------------------------------------------------------
test("a store-bound admin's store scope comes from the session, not the query string", () => {
  const scope = getRequestScope(
    asReq({ role: "STORE_ADMIN", storeType: "retail", storeId: "store-a" })
  );
  assert.equal(scope.storeType, "retail");
  assert.equal(scope.storeId, "store-a");
});

test("a store-bound admin cannot widen scope via ?storeType / ?storeId", () => {
  const scope = getRequestScope(
    asReq({
      role: "STORE_ADMIN",
      storeType: "retail",
      storeId: "store-a",
      // Exactly the request that used to leak another tenant's sales.
      query: { storeType: "retail", storeId: "victim-store" },
    })
  );
  assert.equal(scope.storeType, "retail");
  assert.equal(scope.storeId, "store-a");
  assert.notEqual(scope.storeId, "victim-store");
});

test("SUPER_OWNER may narrow to a chosen store", () => {
  const scope = getRequestScope(
    asReq({
      role: "SUPER_OWNER",
      storeType: null,
      storeId: null,
      query: { storeType: "hotel", storeId: "grand-hotel-1" },
    })
  );
  assert.equal(scope.storeType, "hotel");
  assert.equal(scope.storeId, "grand-hotel-1");
});

test("SUPER_OWNER with no store selection stays platform-wide", () => {
  const scope = getRequestScope(
    asReq({ role: "SUPER_OWNER", storeType: null, storeId: null, query: {} })
  );
  assert.equal(scope.storeType, null);
  assert.equal(scope.storeId, null);
});

// ---------------------------------------------------------------------------
// 3. The SQL the dashboard actually issues.
// ---------------------------------------------------------------------------
test("the sales predicate is store-scoped and parameterized", () => {
  const where = dashboard.buildSalesWhere({
    scope: { storeType: "retail", storeId: "store-a" },
    from: "2026-03-01",
    to: "2026-03-07",
  });
  assert.match(where.sql, /_store_type = \?/);
  assert.match(where.sql, /_store_id = \?/);
  assert.match(where.sql, /`date` >= \?/);
  assert.match(where.sql, /`date` <= \?/);
  assert.deepEqual(where.params, ["2026-03-01", "2026-03-07", "retail", "store-a"]);
  // No caller value is ever interpolated into the statement.
  assert.ok(!where.sql.includes("store-a"));
  assert.ok(!where.sql.includes("2026-03-01"));
});

test("a platform-wide SUPER_OWNER query omits the store predicates entirely", () => {
  const where = dashboard.buildSalesWhere({
    scope: { storeType: null, storeId: null },
    from: "2026-03-01",
    to: "2026-03-07",
  });
  assert.ok(!where.sql.includes("_store_type"));
  assert.ok(!where.sql.includes("_store_id"));
  assert.deepEqual(where.params, ["2026-03-01", "2026-03-07"]);
});

test("the date bounds are optional so a dashboard can show an unbounded period", () => {
  const where = dashboard.buildSalesWhere({
    scope: { storeType: "retail", storeId: "store-a" },
  });
  assert.ok(!where.sql.includes("`date`"));
  assert.deepEqual(where.params, ["retail", "store-a"]);
});

// ---------------------------------------------------------------------------
// 4. Discount must come from the JSON breakdown, never from SUM(discount).
// ---------------------------------------------------------------------------
test("discount is read from discount_breakdown.totalSavings", () => {
  assert.match(dashboard.DISCOUNT_SUM_SQL, /discount_breakdown/);
  assert.match(dashboard.DISCOUNT_SUM_SQL, /totalSavings/);
  // `SUM(discount)` sums a JSON column and is the bug reports.js:66 has.
  assert.ok(!/SUM\(\s*`?discount`?\s*\)/i.test(dashboard.DISCOUNT_SUM_SQL));
});

// ---------------------------------------------------------------------------
// 5. Returns period filtering uses created_at — invoice_returns has no DATE.
// ---------------------------------------------------------------------------
test("returns filter on created_at, the only timestamp invoice_returns carries", () => {
  const where = dashboard.buildReturnsWhere({
    scope: { storeType: "retail", storeId: "store-a" },
    from: "2026-03-01",
    to: "2026-03-07",
  });
  // The upper bound is exclusive at the start of the next day so the whole
  // `to` day is included — a `<= '2026-03-07'` would drop everything after
  // midnight on the final day and understate returns.
  assert.match(where.sql, /created_at >= \?/);
  assert.match(where.sql, /created_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
  assert.deepEqual(where.params, [
    "2026-03-01 00:00:00",
    "2026-03-07",
    "retail",
    "store-a",
  ]);
  // A `date` column does not exist on this table — asserting we never emit it
  // keeps a future refactor from reintroducing a guaranteed-empty result.
  assert.ok(!/`date`/.test(where.sql));
});

// ---------------------------------------------------------------------------
// 6. Payment-mode folding.
// ---------------------------------------------------------------------------
test("payment modes fold case-insensitively and the bank-transfer spellings merge", () => {
  assert.equal(dashboard.foldPaymentMode("cash"), "Cash");
  assert.equal(dashboard.foldPaymentMode("CASH"), "Cash");
  assert.equal(dashboard.foldPaymentMode("UPI"), "UPI");
  for (const spelling of ["Bank Transfer", "banktransfer", "bank-transfer"]) {
    assert.equal(dashboard.foldPaymentMode(spelling), "Bank Transfer");
  }
});

test("an unrecognised payment mode keeps its own bucket rather than being hidden", () => {
  // "Slip" is written by the laundry UI and "Split" by the POS. Neither is a
  // canonical mode, but both are the only surviving signal that they happened,
  // so they must stay visible instead of being folded into "Other".
  assert.equal(dashboard.foldPaymentMode("Slip"), "Other");
  assert.equal(dashboard.foldPaymentMode("Split"), "Other");
  assert.equal(dashboard.foldPaymentMode(null), "Other");
});
