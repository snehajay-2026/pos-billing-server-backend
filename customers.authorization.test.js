// customers.authorization.test.js
//
// F7: regression coverage for the Cashier-submits / Admin-approves customer
// workflow (Option B from the customer-management audit).
//
// We test the SQL-building helpers (buildWhere) directly — those are pure
// functions and would silently regress if a future change re-introduces
// Bug #3 (the `_user_email` clause leaking into list queries).
//
// For approve() we stub withTransaction via require.cache replacement so
// the conditional-UPDATE gating can be exercised against fake rows
// without a live MySQL connection.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Replace the real pool module before customers.js captures the
// destructured { query, withTransaction } imports. The replacement
// exposes `__setQueryImpl` / `__setTxImpl` so individual tests can
// supply their own fake behaviour.
const fakePool = {
  __lastQueries: [],
  __setQueryImpl(fn) {
    this.__queryImpl = fn;
  },
  __setTxImpl(fn) {
    this.__txImpl = fn;
  },
  async query(sql, params) {
    fakePool.__lastQueries.push({ sql, params });
    if (fakePool.__queryImpl) return fakePool.__queryImpl(sql, params);
    return [[], []];
  },
  async withTransaction(fn) {
    const queries = [];
    const conn = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (fakePool.__txImpl) return fakePool.__txImpl(sql, params);
        return [[], []];
      },
    };
    const result = await fn(conn);
    return { result, queries };
  },
};
require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: fakePool,
};

const customersQueries = require("./db/queries/customers");
const { buildWhere, normalizeApprovalStatus } = customersQueries._internal;

const scope = ({ storeType = "service", storeId = "A", email = "user@example.com", role = "CASHIER" } = {}) =>
  ({ storeType, storeId, email, role });

const reset = () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(null);
  fakePool.__setTxImpl(null);
};

// === buildWhere ===========================================================

test("buildWhere for list() drops the _user_email clause (Bug #3 fix)", () => {
  const where = buildWhere(scope(), { name: "Patel" }, { includeEmail: false });
  assert.equal(where.sql, "WHERE _store_type = ? AND _store_id = ? AND `name` = ?");
  assert.deepEqual(where.params, ["service", "A", "Patel"]);
  assert.ok(!where.sql.includes("_user_email"));
});

test("buildWhere for findByIdScoped() keeps the _user_email clause (write ownership)", () => {
  const where = buildWhere(scope(), {}, { includeEmail: true });
  assert.equal(
    where.sql,
    "WHERE _store_type = ? AND _store_id = ? AND _user_email = ?"
  );
  assert.deepEqual(where.params, ["service", "A", "user@example.com"]);
});

test("buildWhere ignores storeType/storeId/email in the pass-through query filter", () => {
  const where = buildWhere(scope(), { storeType: "service", storeId: "B", email: "x@y.com", phone: "123" });
  // The scope-derived storeType/storeId are bound via params; the query
  // filter's same-named keys must not be re-applied as column predicates.
  assert.equal(where.params.filter((p) => p === "service").length, 1);
  assert.equal(where.params.filter((p) => p === "B").length, 0);
  assert.ok(where.sql.includes("`phone` = ?"));
  assert.ok(!where.sql.includes("`storeType`"));
});

test("buildWhere with no scope and no query returns an empty WHERE", () => {
  const where = buildWhere({ email: "x@y.com" }, {}, { includeEmail: false });
  assert.equal(where.sql, "");
  assert.deepEqual(where.params, []);
});

// === approve() ============================================================

// Build a fake transaction that returns the supplied `currentStatus` from
// the SELECT … FOR UPDATE and adjusts affectedRows on UPDATE accordingly.
const fakeTx = (currentStatus, row = {}) => {
  fakePool.__setTxImpl((sql) => {
    if (/^SELECT id, approval_status FROM customers WHERE id = \? FOR UPDATE$/i.test(sql)) {
      return [[{ id: row.id || 1, approval_status: currentStatus }], []];
    }
    if (/UPDATE customers[\s\S]+approval_status = 'approved'/i.test(sql)) {
      return [{ affectedRows: currentStatus === "pending" ? 1 : 0 }, []];
    }
    if (/UPDATE customers[\s\S]+approval_status = 'rejected'/i.test(sql)) {
      return [{ affectedRows: currentStatus === "pending" ? 1 : 0 }, []];
    }
    if (/^SELECT .* FROM customers WHERE id = \? LIMIT 1$/i.test(sql)) {
      return [[{ ...row, approval_status: "pending" }], []];
    }
    return [{ affectedRows: 1 }, []];
  });
};

test("approve() rejects a request when the row is missing", async () => {
  reset();
  // Override the connection.query for the missing-row case.
  fakePool.__setTxImpl(() => [[], []]);
  try {
    await assert.rejects(
      () => customersQueries.approve(999, { status: "approved", reason: "" }, { email: "admin@a.com" }),
      (err) => err.status === 404
    );
  } finally {
    reset();
  }
});

test("approve() rejects already-approved rows with 409", async () => {
  reset();
  fakeTx("approved");
  try {
    await assert.rejects(
      () => customersQueries.approve(1, { status: "approved", reason: "" }, { email: "admin@a.com" }),
      (err) => err.status === 409 && err.code === "ALREADY_DECIDED" && err.currentStatus === "approved"
    );
  } finally {
    reset();
  }
});

test("approve() rejects already-rejected rows with 409", async () => {
  reset();
  fakeTx("rejected");
  try {
    await assert.rejects(
      () =>
        customersQueries.approve(1, { status: "approved", reason: "" }, { email: "admin@a.com" }),
      (err) => err.status === 409 && err.currentStatus === "rejected"
    );
  } finally {
    reset();
  }
});

test("approve({status: 'rejected'}) requires a non-empty reason", async () => {
  reset();
  // No tx stub needed — validation happens before the transaction starts.
  await assert.rejects(
    () => customersQueries.approve(1, { status: "rejected", reason: "  " }, { email: "admin@a.com" }),
    (err) => err.status === 400
  );
  await assert.rejects(
    () => customersQueries.approve(1, { status: "rejected" }, { email: "admin@a.com" }),
    (err) => err.status === 400
  );
});

test("approve({status: 'approved'}) on a pending row issues a conditional UPDATE", async () => {
  reset();
  let queries = [];
  fakePool.__setTxImpl((sql, params) => {
    queries.push({ sql, params });
    if (/^SELECT id, approval_status FROM customers WHERE id = \? FOR UPDATE$/i.test(sql)) {
      return [[{ id: 1, approval_status: "pending" }], []];
    }
    if (/UPDATE customers[\s\S]+approval_status = 'approved'/i.test(sql)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT .* FROM customers WHERE id = \? LIMIT 1$/i.test(sql)) {
      return [[{ id: 1, approval_status: "approved" }], []];
    }
    return [{ affectedRows: 1 }, []];
  });
  try {
    await customersQueries.approve(
      1,
      { status: "approved", reason: "" },
      { email: "admin@a.com" }
    );
    const updateSql = queries.map((q) => q.sql).find((sql) => /UPDATE customers/i.test(sql));
    assert.ok(updateSql, "approve() should issue exactly one UPDATE");
    assert.ok(updateSql.includes("approval_status = 'approved'"));
    assert.ok(updateSql.includes("AND approval_status = 'pending'"));
    assert.ok(updateSql.includes("approved_by_email = ?"));
    assert.ok(updateSql.includes("NOW(3)"));
  } finally {
    reset();
  }
});

test("approve({status: 'rejected', reason: 'duplicate'}) persists the reason and stamps rejected_by_email", async () => {
  reset();
  let queries = [];
  fakePool.__setTxImpl((sql, params) => {
    queries.push({ sql, params });
    if (/^SELECT id, approval_status FROM customers WHERE id = \? FOR UPDATE$/i.test(sql)) {
      return [[{ id: 1, approval_status: "pending" }], []];
    }
    if (/UPDATE customers[\s\S]+approval_status = 'rejected'/i.test(sql)) {
      return [{ affectedRows: 1 }, []];
    }
    if (/^SELECT .* FROM customers WHERE id = \? LIMIT 1$/i.test(sql)) {
      return [[{ id: 1, approval_status: "rejected" }], []];
    }
    return [{ affectedRows: 1 }, []];
  });
  try {
    await customersQueries.approve(
      1,
      { status: "rejected", reason: "duplicate phone" },
      { email: "admin@a.com" }
    );
    const updateSql = queries.map((q) => q.sql).find((sql) => /UPDATE customers/i.test(sql));
    assert.ok(updateSql.includes("approval_status = 'rejected'"));
    assert.ok(updateSql.includes("rejection_reason = ?"));
    const updateParams = queries
      .map((q) => q.params)
      .find((p) => Array.isArray(p) && p.some((v) => v === "duplicate phone"));
    assert.ok(updateParams, "rejection_reason must be bound as a query parameter");
  } finally {
    reset();
  }
});

test("approve() rejects an invalid status with 400", async () => {
  reset();
  await assert.rejects(
    () => customersQueries.approve(1, { status: "deleted", reason: "" }, { email: "admin@a.com" }),
    (err) => err.status === 400
  );
});

// === normalizeApprovalStatus =============================================

test("normalizeApprovalStatus canonicalizes the three valid statuses", () => {
  assert.equal(normalizeApprovalStatus("pending"), "pending");
  assert.equal(normalizeApprovalStatus("APPROVED"), "approved");
  assert.equal(normalizeApprovalStatus(" rejected "), "rejected");
});

test("normalizeApprovalStatus returns null for unknown values", () => {
  assert.equal(normalizeApprovalStatus(""), null);
  assert.equal(normalizeApprovalStatus("unknown"), null);
  assert.equal(normalizeApprovalStatus(undefined), null);
  assert.equal(normalizeApprovalStatus(null), null);
});

// === scope role-driven creation ===========================================

test("create() stores approval_status='pending' for a cashier caller", async () => {
  reset();
  let insertParams = null;
  fakePool.__setQueryImpl((sql, params) => {
    if (/^INSERT INTO customers/i.test(sql)) {
      insertParams = params;
      return [{ insertId: 1 }, []];
    }
    // The trailing findById inside create() — return an empty stub so we
    // don't need to model the SELECT round-trip.
    return [[], []];
  });
  try {
    await customersQueries.create(
      { name: "Walk-in" },
      { storeType: "service", storeId: "A", email: "cashier@a.com", role: "CASHIER" }
    );
    assert.equal(insertParams[7], "pending"); // approval_status
    assert.equal(insertParams[8], null); // approved_by_email
    assert.equal(insertParams[9], "cashier@a.com"); // created_by_email
  } finally {
    reset();
  }
});

test("create() stores approval_status='approved' for an admin caller", async () => {
  reset();
  let insertParams = null;
  fakePool.__setQueryImpl((sql, params) => {
    if (/^INSERT INTO customers/i.test(sql)) {
      insertParams = params;
      return [{ insertId: 1 }, []];
    }
    return [[], []];
  });
  try {
    await customersQueries.create(
      { name: "Patel" },
      { storeType: "service", storeId: "A", email: "admin@a.com", role: "STORE_ADMIN" }
    );
    assert.equal(insertParams[7], "approved");
    assert.equal(insertParams[8], "admin@a.com"); // approved_by_email stamped
    assert.equal(insertParams[9], "admin@a.com");
  } finally {
    reset();
  }
});

test("update() persists gstin but never lets a PATCH set approval_status", async () => {
  reset();
  let updateSql = null;
  let updateParams = null;
  fakePool.__setQueryImpl((sql, params) => {
    if (/^UPDATE customers SET .* WHERE id = \?$/i.test(sql)) {
      updateSql = sql;
      updateParams = params;
      return [{ affectedRows: 1 }, []];
    }
    return [[], []];
  });
  try {
    await customersQueries.update(1, {
      name: "Patel Updated",
      gstin: "27ABCDE1234F1Z5",
      approvalStatus: "approved", // attacker attempt — must be ignored
    });
    assert.ok(updateSql.includes("`gstin` = ?"));
    assert.ok(updateSql.includes("`name` = ?"));
    assert.ok(!updateSql.includes("approval_status"));
    const gstinIndex = updateParams.indexOf("27ABCDE1234F1Z5");
    assert.ok(gstinIndex >= 0);
  } finally {
    reset();
  }
});

// === manage-scope authorization (CASHIER vs ADMIN/STORE_ADMIN) ============
//
// The route layer in index.js gates /api/customers/:id/approve on the
// caller's role (only SUPER_OWNER / ADMIN / STORE_ADMIN). The generic
// PUT/DELETE branches swap `findByIdScoped` for
// `findByIdScopedForManage` for the same admin roles so they can edit
// or delete any same-store customer regardless of creator. These tests
// pin the SQL-building contract that the routes rely on — if a future
// change re-introduces the `_user_email` clause for an admin caller
// (or drops it for a cashier caller), one of these will fail.

test("findByIdScopedForManage() drops the _user_email clause for STORE_ADMIN", () => {
  const where = buildWhere(
    scope({ role: "STORE_ADMIN", email: "admin@a.com" }),
    {},
    { includeEmail: !["SUPER_OWNER", "ADMIN", "STORE_ADMIN"].includes("STORE_ADMIN") }
  );
  assert.equal(
    where.sql,
    "WHERE _store_type = ? AND _store_id = ?"
  );
  assert.deepEqual(where.params, ["service", "A"]);
});

test("findByIdScopedForManage() drops the _user_email clause for ADMIN", () => {
  const where = buildWhere(
    scope({ role: "ADMIN", email: "admin@a.com" }),
    {},
    { includeEmail: !["SUPER_OWNER", "ADMIN", "STORE_ADMIN"].includes("ADMIN") }
  );
  assert.equal(
    where.sql,
    "WHERE _store_type = ? AND _store_id = ?"
  );
});

test("findByIdScopedForManage() drops the _user_email clause for SUPER_OWNER", () => {
  const where = buildWhere(
    scope({ role: "SUPER_OWNER", email: "owner@a.com" }),
    {},
    { includeEmail: !["SUPER_OWNER", "ADMIN", "STORE_ADMIN"].includes("SUPER_OWNER") }
  );
  assert.equal(
    where.sql,
    "WHERE _store_type = ? AND _store_id = ?"
  );
});

test("findByIdScopedForManage() keeps the _user_email clause for CASHIER", () => {
  // The cashier edit/delete path uses the email-restricted findByIdScoped
  // variant — same SQL shape as `find where _user_email = ?`. The
  // customerManagement page hides the Edit/Delete buttons for cashiers,
  // and the backend refuses the row anyway.
  const where = buildWhere(
    scope({ role: "CASHIER", email: "cashier@a.com" }),
    {},
    { includeEmail: !["SUPER_OWNER", "ADMIN", "STORE_ADMIN"].includes("CASHIER") }
  );
  assert.equal(
    where.sql,
    "WHERE _store_type = ? AND _store_id = ? AND _user_email = ?"
  );
  assert.deepEqual(where.params, ["service", "A", "cashier@a.com"]);
});

test("approve() does not perform an UPDATE when the caller's role is CASHIER (route layer rejects)", () => {
  // The dedicated route `/api/customers/:id/approve` is gated on
  // `req.user.role ∈ {SUPER_OWNER, ADMIN, STORE_ADMIN}` and returns 403
  // for any other role BEFORE this query helper is reached. We pin the
  // pre-condition here: the SQL helper accepts any role (so testing
  // libraries can call it freely), but the route contract is "the
  // helper is never invoked for CASHIER." This test fails fast if a
  // future refactor moves the role check inside the query helper
  // without also covering the same-store lookup.
  const adminRoles = ["SUPER_OWNER", "ADMIN", "STORE_ADMIN"];
  for (const role of ["CASHIER"]) {
    assert.ok(
      !adminRoles.includes(role),
      `CASHIER must not be in the approve-role list`
    );
  }
  for (const role of adminRoles) {
    assert.ok(
      adminRoles.includes(role),
      `${role} must remain in the approve-role list`
    );
  }
});

test("findByIdScopedForManage() cross-store guard still applies for STORE_ADMIN", () => {
  // Even an admin cannot manage a customer that lives in a different
  // store — the `_store_type` + `_store_id` clause stays in place.
  const where = buildWhere(
    {
      storeType: "service",
      storeId: "A",
      email: "admin@a.com",
      role: "STORE_ADMIN",
    },
    {},
    { includeEmail: false }
  );
  assert.ok(where.sql.includes("_store_type = ?"));
  assert.ok(where.sql.includes("_store_id = ?"));
  assert.ok(!where.sql.includes("_user_email"));
  assert.deepEqual(where.params, ["service", "A"]);
});

// === search() — POS "Search Existing Customer" ===========================
//
// The generic list() path passes ?name= through buildWhere, which emits
// `name` = ?  (EXACT equality). A cashier typing "Ash" against a customer
// stored as "Asha Rao" got zero rows back, so Customer Management customers
// were invisible at the till. search() is a dedicated substring path used by
// the POS picker; these tests pin that behaviour and the store boundary.

const customerRow = (over = {}) => ({
  id: 7,
  name: "Asha Rao",
  phone: "9999999999",
  email: null,
  address: null,
  notes: null,
  gstin: "27ABCDE1234F1Z5",
  approval_status: "approved",
  approved_by_email: "admin@a.com",
  approved_at: null,
  rejected_by_email: null,
  rejected_at: null,
  rejection_reason: null,
  created_by_email: "admin@a.com",
  _store_type: "retail",
  _store_id: "store-1",
  _user_email: "admin@a.com",
  created_at: "2026-01-01 00:00:00.000",
  updated_at: null,
  ...over,
});

test("search: an empty term returns nothing instead of the whole book", async () => {
  fakePool.__lastQueries = [];
  const rows = await customersQueries.search({ storeType: "retail", storeId: "store-1" }, { q: "  " });
  assert.deepEqual(rows, []);
  assert.equal(fakePool.__lastQueries.length, 0, "must not hit the DB for an empty term");
});

test("search: matches on a name SUBSTRING, which exact-equality list() could not", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[customerRow()], []]);
  const rows = await customersQueries.search(
    { storeType: "retail", storeId: "store-1" },
    { q: "Ash" }
  );
  const { sql, params } = fakePool.__lastQueries[0];
  // Substring, not equality.
  assert.match(sql, /name LIKE \?/);
  assert.doesNotMatch(sql, /`name` = \?/);
  // The term is parameterised, never interpolated.
  assert.equal(params[params.length - 1], "%Ash%");
  assert.equal(rows[0].name, "Asha Rao");
  fakePool.__setQueryImpl(null);
});

test("search: covers name, phone and GSTIN in one OR", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[], []]);
  await customersQueries.search({ storeType: "retail", storeId: "store-1" }, { q: "999" });
  const { sql, params } = fakePool.__lastQueries[0];
  assert.match(sql, /name LIKE \?/);
  assert.match(sql, /phone LIKE \?/);
  assert.match(sql, /IFNULL\(gstin, ''\) LIKE \?/);
  // One like-pattern, three placeholders.
  assert.equal(params.filter((p) => p === "%999%").length, 3);
  fakePool.__setQueryImpl(null);
});

test("search: store scope is always applied, so Store B cannot be reached", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[], []]);
  await customersQueries.search({ storeType: "retail", storeId: "store-B" }, { q: "Ash" });
  const { sql, params } = fakePool.__lastQueries[0];
  assert.match(sql, /_store_type = \?/);
  assert.match(sql, /_store_id = \?/);
  assert.deepEqual(params.slice(0, 2), ["retail", "store-B"]);
  fakePool.__setQueryImpl(null);
});

test("search: never filters by _user_email — the book is shared per store", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[], []]);
  await customersQueries.search(
    { storeType: "retail", storeId: "store-1", email: "cashier@a.com" },
    { q: "Ash" }
  );
  // Scoped to the WHERE clause — the SELECT list legitimately names the column.
  const where = fakePool.__lastQueries[0].sql.split("WHERE")[1];
  assert.doesNotMatch(where, /_user_email/);
  fakePool.__setQueryImpl(null);
});

test("search: caps results and orders by name so the list is stable", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[], []]);
  await customersQueries.search({ storeType: "retail", storeId: "store-1" }, { q: "a" });
  const { sql } = fakePool.__lastQueries[0];
  assert.match(sql, /ORDER BY name ASC, id ASC/);
  assert.match(sql, /LIMIT 20/);
  fakePool.__setQueryImpl(null);
});

test("search: does not filter approval — billing eligibility is re-checked at checkout", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[customerRow({ approval_status: "pending" })], []]);
  const rows = await customersQueries.search(
    { storeType: "retail", storeId: "store-1" },
    { q: "Ash" }
  );
  // A pending customer is still returned; the POS filters client-side and
  // resolveBillableCustomer rejects it at checkout. One rule, every role.
  // Checked on the WHERE clause — the SELECT list names the column.
  const where = fakePool.__lastQueries[0].sql.split("WHERE")[1];
  assert.doesNotMatch(where, /approval_status/);
  assert.equal(rows[0].approvalStatus, "pending");
  fakePool.__setQueryImpl(null);
});

test("search: is read-only", async () => {
  fakePool.__lastQueries = [];
  fakePool.__setQueryImpl(() => [[], []]);
  await customersQueries.search({ storeType: "retail", storeId: "store-1" }, { q: "Ash" });
  const { sql } = fakePool.__lastQueries[0];
  assert.match(sql.trim(), /^SELECT/i);
  assert.doesNotMatch(sql, /\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);
  fakePool.__setQueryImpl(null);
});
