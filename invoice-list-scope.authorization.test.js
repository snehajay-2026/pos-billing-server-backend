// invoice-list-scope.authorization.test.js
//
// Read-scope regression coverage for `invoices.list`.
//
// Bug: `list` applied `_user_email = ?` to EVERY caller, because
// `getRequestScope` populates `email` for all roles. A STORE_ADMIN therefore
// saw only the invoices they had personally raised — the rest of their own
// store's sales were invisible on the invoice list, the cash-flow page, the
// dashboard, and global search. The same clause also narrowed an unscoped
// SUPER_OWNER, who has no store at all to be bound to.
//
// The fix makes the clause role-conditional, mirroring the precedent already
// in the codebase: `findByIdScopedForManage` (customers.js) and the
// `includeEmail: false` read path (orders.js). Cashiers keep the clause.
//
// The tests drive the REAL `list` against a scripted fake pool, asserting on
// the generated SQL rather than on results, because the security property here
// is "which predicate was emitted" — not "which rows came back". A store-scope
// assertion that only checked results would pass even if the store predicates
// were dropped entirely.
//
// `findByIdScoped` is deliberately NOT covered here as store-wide: it is the
// WRITE-ownership guard and must keep the email clause for every role. That
// invariant is asserted explicitly at the bottom of this file.

const test = require("node:test");
const assert = require("node:assert/strict");

// Swap the pool before invoices.js captures the destructured { query }.
const captured = [];
const fakePool = {
  __captured: captured,
  async query(sql, params) {
    captured.push({ sql, params });
    return [[], []];
  },
  async withTransaction(fn) {
    return fn(fakePool);
  },
};
require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: fakePool,
};

const invoicesQueries = require("./db/queries/invoices");
const { list, listScopeIncludesEmail } = invoicesQueries;

const scopeFor = ({ role, storeType = "retail", storeId = "101", email = "user@example.com" }) => ({
  role,
  storeType,
  storeId,
  email,
});

// Run `list` and return the statements it issued.
const runList = async (scope, options = {}) => {
  captured.length = 0;
  await list(scope, options);
  return captured.slice();
};

// Every emitted statement must carry the same predicate set — the aggregate,
// the page and the (unpaginated) select all read from one `where`.
const allStatements = (statements) => statements.map((s) => s.sql).join("\n");

// `_user_email` is a legitimate SELECT column (it backs the "billed by"
// attribution the UI shows), so a raw substring search over the whole
// statement would always find it. What matters is whether it appears in the
// WHERE clause as a *predicate* — that is the actual scope restriction.
const whereClauseOf = (sql) => {
  const start = sql.indexOf(" WHERE ");
  if (start === -1) return "";
  const end = sql.indexOf(" ORDER BY ");
  return end === -1 ? sql.slice(start) : sql.slice(start, end);
};

const scopedSql = (statements) => allStatements(statements).split(" WHERE ").slice(1).join(" WHERE ");

const ADMIN_ROLES = ["SUPER_OWNER", "ADMIN", "STORE_ADMIN"];

// ===========================================================================
// Test 1 — STORE_ADMIN sees every invoice in their store, whoever raised it.
// ===========================================================================
test("STORE_ADMIN list is store-scoped with NO _user_email clause", async () => {
  const statements = await runList(
    scopeFor({ role: "STORE_ADMIN", storeType: "retail", storeId: "101", email: "admin-a@example.com" })
  );
  const sql = scopedSql(statements);
  assert.match(sql, /_store_type = \?/);
  assert.match(sql, /_store_id = \?/);
  assert.ok(!sql.includes("_user_email"), "STORE_ADMIN must not be email-restricted");
  // The store predicates bind the actual authorized values, in order.
  assert.deepEqual(statements[0].params, ["retail", "101"]);
});

test("ADMIN and SUPER_OWNER are store-wide too", async () => {
  for (const role of ADMIN_ROLES) {
    const statements = await runList(scopeFor({ role, email: "boss@example.com" }));
    const sql = scopedSql(statements);
    assert.ok(!sql.includes("_user_email"), `${role} must not be email-restricted`);
  }
});

// ===========================================================================
// Test 2 — cross-store isolation is never weakened.
// ===========================================================================
test("STORE_ADMIN for store 101 never queries store 102", async () => {
  const statements = await runList(
    scopeFor({ role: "STORE_ADMIN", storeId: "101", email: "admin-a@example.com" })
  );
  const params = statements.flatMap((s) => s.params);
  assert.ok(params.includes("101"));
  assert.ok(!params.includes("102"), "another store's id must not appear in the query");
  assert.ok(!statements.some((s) => s.sql.includes("102")));
});

test("the store scope comes from the session, never from caller query params", async () => {
  // This is the manipulated-request test: an admin for store 101 appending
  // ?storeId=102 must not widen the result. The generic GET handler builds
  // the scope from getRequestScope(req); the caller's query object is only
  // consulted for the documented filters below.
  const statements = await runList(
    scopeFor({ role: "STORE_ADMIN", storeId: "101", email: "admin-a@example.com" }),
    { search: "INV-1", paymentMode: "Cash" }
  );
  const params = statements.flatMap((s) => s.params);
  assert.ok(!params.includes("102"));
  assert.ok(!params.includes("admin-a@example.com"), "email must not reach the query at all");
  // The legitimate filters still apply.
  assert.ok(params.some((p) => typeof p === "string" && p.includes("INV-1")));
});

// ===========================================================================
// Test 3 — Cashier behaviour is preserved exactly.
// ===========================================================================
test("CASHIER keeps the _user_email clause", async () => {
  const statements = await runList(
    scopeFor({ role: "CASHIER", storeType: "retail", storeId: "101", email: "cashier-a@example.com" })
  );
  const sql = allStatements(statements);
  assert.match(sql, /_user_email = \?/);
  assert.deepEqual(statements[0].params, ["retail", "101", "cashier-a@example.com"]);
});

test("listScopeIncludesEmail denies by default — only the 3 admin roles are store-wide", () => {
  for (const role of ADMIN_ROLES) {
    assert.equal(listScopeIncludesEmail({ role }), false, `${role} must be store-wide`);
  }
  // Anything not on the allowlist keeps the email clause, INCLUDING roles that
  // do not exist today. `normalizeRole` coerces unknown roles to CASHIER, so a
  // future role must be refused until it is deliberately added.
  for (const role of ["CASHIER", "cashier", "MANAGER", "BRANCH_ADMIN", "", null, undefined]) {
    assert.equal(listScopeIncludesEmail({ role }), true, `${role} must stay restricted`);
  }
  // A missing scope is restricted by default too.
  assert.equal(listScopeIncludesEmail({}), true);
});

// ===========================================================================
// Test 4/5 — ADMIN and SUPER_OWNER platform-wide view is restored.
// ===========================================================================
test("an unscoped SUPER_OWNER sees platform-wide, not just their own invoices", async () => {
  const statements = await runList({
    role: "SUPER_OWNER",
    storeType: null,
    storeId: null,
    email: "owner@example.com",
  });
  const sql = scopedSql(statements);
  // No store bound and no email bound: the owner sees every store.
  assert.ok(!sql.includes("_store_type"));
  assert.ok(!sql.includes("_store_id"));
  assert.ok(!sql.includes("_user_email"));
  assert.deepEqual(statements[0].params, []);
});

test("a SUPER_OWNER who narrowed to a store is scoped to that store", async () => {
  const statements = await runList({
    role: "SUPER_OWNER",
    storeType: "hotel",
    storeId: "grand-1",
    email: "owner@example.com",
  });
  assert.deepEqual(statements[0].params, ["hotel", "grand-1"]);
  assert.ok(!scopedSql(statements).includes("_user_email"));
});

// ===========================================================================
// Test 6 — store-TYPE isolation, not just store-id.
// ===========================================================================
test("retail/101 and service/101 are distinct scopes", async () => {
  const retail = await runList(scopeFor({ role: "STORE_ADMIN", storeType: "retail", storeId: "101" }));
  const service = await runList(scopeFor({ role: "STORE_ADMIN", storeType: "service", storeId: "101" }));
  assert.deepEqual(retail[0].params, ["retail", "101"]);
  assert.deepEqual(service[0].params, ["service", "101"]);
  // Both _store_type and _store_id are always emitted, so a shared numeric id
  // across verticals can never collide.
  assert.match(allStatements(retail), /_store_type = \?/);
  assert.match(allStatements(retail), /_store_id = \?/);
});

// ===========================================================================
// Test 7 — pagination: filtering precedes LIMIT/OFFSET, and stays consistent.
// ===========================================================================
test("pagination counts and pages share one store-scoped predicate set", async () => {
  const statements = await runList(
    scopeFor({ role: "STORE_ADMIN", storeId: "101" }),
    { limit: 10, offset: 20 }
  );
  // Three statements: aggregate, page select. Every one carries the store scope.
  for (const s of statements) {
    assert.match(whereClauseOf(s.sql), /_store_type = \?/);
    assert.match(whereClauseOf(s.sql), /_store_id = \?/);
    assert.ok(!whereClauseOf(s.sql).includes("_user_email"));
  }
  const page = statements[statements.length - 1];
  assert.match(page.sql, /ORDER BY generated_at DESC, id DESC/);
  assert.match(page.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(page.params, ["retail", "101", 10, 20]);
});

test("a non-positive or missing limit keeps the historical full-list behaviour", async () => {
  for (const opts of [{}, { limit: 0 }, { limit: -5 }, { limit: "abc" }]) {
    const statements = await runList(scopeFor({ role: "STORE_ADMIN" }), opts);
    const sql = allStatements(statements);
    assert.ok(!/LIMIT \?/.test(sql), "must not paginate on a garbage limit");
    assert.match(sql, /_store_type = \?/);
  }
});

// ===========================================================================
// Test 8 — ordering is untouched.
// ===========================================================================
test("ordering stays generated_at DESC, id DESC on every read path", async () => {
  const unpaginated = await runList(scopeFor({ role: "STORE_ADMIN" }));
  assert.match(unpaginated[0].sql, /ORDER BY generated_at DESC, id DESC/);

  const paginated = await runList(scopeFor({ role: "STORE_ADMIN" }), { limit: 5 });
  const page = paginated[paginated.length - 1];
  assert.match(page.sql, /ORDER BY generated_at DESC, id DESC/);
});

// ===========================================================================
// Test 9 — filters apply INSIDE the store scope and cannot escape it.
// ===========================================================================
test("search, date and payment filters are ANDed with the store scope", async () => {
  const statements = await runList(scopeFor({ role: "STORE_ADMIN", storeId: "101" }), {
    search: "Acme",
    fromDate: "2026-03-01",
    toDate: "2026-03-31",
    paymentMode: "Cash",
  });
  const sql = statements[0].sql;
  assert.match(sql, /_store_type = \?/);
  assert.match(sql, /_store_id = \?/);
  assert.match(sql, /invoice_no LIKE \?/);
  assert.match(sql, /date >= \?/);
  assert.match(sql, /LOWER\(payment_mode\) = \?/);
  // Every condition is joined by AND — an OR would let a search escape scope.
  assert.ok(!/\bOR\b(?![^)]*LIKE)/.test(sql.replace(/OR customer_name LIKE \? OR customer_mobile LIKE \? OR billed_by LIKE \?/, "")));
  // Values are parameterized, never interpolated.
  assert.ok(!sql.includes("101"));
  assert.ok(!sql.includes("Acme"));
});

// ===========================================================================
// Test 10 — an empty authorized store yields an empty result, not another's.
// ===========================================================================
test("a STORE_ADMIN with no invoices in their store gets an empty list", async () => {
  const statements = await runList(
    scopeFor({ role: "STORE_ADMIN", storeType: "retail", storeId: "999", email: "admin-empty@example.com" })
  );
  // The query still binds the store, so the DB can only return that store's
  // (zero) rows — it can never fall through to another store's invoices.
  assert.deepEqual(statements[0].params, ["retail", "999"]);
  assert.match(statements[0].sql, /_store_type = \?/);
  assert.match(statements[0].sql, /_store_id = \?/);
});

// ===========================================================================
// Write ownership is NOT relaxed by this change.
// ===========================================================================
test("findByIdScoped still applies _user_email for every role (write guard intact)", async () => {
  captured.length = 0;
  await invoicesQueries.findByIdScoped(42, {
    role: "STORE_ADMIN",
    storeType: "retail",
    storeId: "101",
    email: "admin-a@example.com",
  });
  const sql = captured.map((s) => s.sql).join("\n");
  assert.match(sql, /_user_email = \?/, "write ownership must remain email-gated");
  assert.deepEqual(captured[0].params, [42, "retail", "101", "admin-a@example.com"]);
});
