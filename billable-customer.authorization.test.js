// billable-customer.authorization.test.js
//
// F8: regression coverage for the invoice-customer business-integrity
// gate. The security review surfaced that any cashier could POST an
// arbitrary `customerId` and have it silently dropped (no column on
// invoices) — so a Cashier could submit a pending or rejected id and
// the invoice still went through. After the fix:
//
//   1. invoices.customer_id column exists (runtime migration, idempotent).
//   2. POST /api/invoices and POST /api/invoices/checkout call
//      resolveBillableCustomer(customerId, scope) which:
//        - returns null for missing/empty input (walking customer preserved),
//        - throws 400 for non-numeric / non-positive input,
//        - throws 404 for missing OR cross-store rows (same lookup helper
//          the cashier's POS search uses, so cross-store is uniformly
//          treated as not-found),
//        - throws 422 for pending OR rejected rows,
//        - returns { id } for approved same-store rows.
//
//   3. invoicesQueries.create() and createWithStockDecrement() write
//      customer_id only when the helper returned a non-null id.
//
// We test (2) here using an injected fake `customersQueries` so the
// tests run without a live MySQL connection. (3) is exercised in the
// existing invoices query module by the runtime migration + dynamic
// INSERT shape; we assert the function-arity contract here as a
// compile-time check.

const test = require("node:test");
const assert = require("node:assert/strict");

// === resolveBillableCustomer ===============================================

const baseScope = ({
  storeType = "service",
  storeId = "A",
  email = "cashier-a@example.com",
  role = "CASHIER",
} = {}) => ({ storeType, storeId, email, role });

const fakeCustomer = (overrides = {}) => ({
  id: 1001,
  name: "Acme",
  phone: "9999999999",
  approvalStatus: "approved",
  storeType: "service",
  storeId: "A",
  ...overrides,
});

// Tiny in-memory stand-in for customersQueries.findByIdScoped. The real
// helper filters on (_store_type, _store_id, _user_email), so we mirror
// that here. Note: the email-bypass used by findByIdScopedForManage is
// NOT exposed here — that's intentional, because invoice linkage must
// always be same-store even for admins.
const fakeCustomersQueries = {
  rows: {},
  setRow(id, row) { this.rows[String(id)] = row; },
  async findByIdScoped(id, scope) {
    const row = this.rows[String(id)];
    if (!row) return null;
    if (
      row.storeType !== (scope.storeType || "") ||
      row.storeId !== (scope.storeId || "") ||
      row._userEmail !== (scope.email || "")
    ) {
      return null;
    }
    return fakeCustomer(row);
  },
};

const { resolveBillableCustomer } = require("./lib/billable-customer");

// Always pass the fake customersQueries via the third argument so the
// helper never falls back to the real (DB-bound) implementation.
const deps = { customersQueries: fakeCustomersQueries };

test("resolveBillableCustomer returns null for missing input (walking customer)", async () => {
  for (const blank of [undefined, null, ""]) {
    const out = await resolveBillableCustomer(blank, baseScope(), deps);
    assert.equal(out, null);
  }
});

test("resolveBillableCustomer rejects non-numeric input with 400", async () => {
  for (const bad of ["abc", "12abc"]) {
    await assert.rejects(
      resolveBillableCustomer(bad, baseScope(), deps),
      (err) => err.status === 400 && /positive number/i.test(err.message)
    );
  }
});

test("resolveBillableCustomer rejects object / array input with 400", async () => {
  for (const bad of [{}, [], { id: 1 }]) {
    await assert.rejects(
      resolveBillableCustomer(bad, baseScope(), deps),
      (err) => err.status === 400
    );
  }
});

test("resolveBillableCustomer rejects zero / negative with 400", async () => {
  for (const bad of [0, -5, "0", "-3"]) {
    await assert.rejects(
      resolveBillableCustomer(bad, baseScope(), deps),
      (err) => err.status === 400
    );
  }
});

test("resolveBillableCustomer rejects missing customer with 404", async () => {
  await assert.rejects(
    resolveBillableCustomer(99999, baseScope(), deps),
    (err) => err.status === 404 && /not found/i.test(err.message)
  );
});

test("resolveBillableCustomer rejects cross-store customer with 404", async () => {
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "OtherStore",
    approvalStatus: "approved",
    storeType: "service",
    storeId: "B", // different store
    _userEmail: "cashier-a@example.com",
  });
  await assert.rejects(
    resolveBillableCustomer(1001, baseScope(), deps),
    (err) => err.status === 404
  );
});

test("resolveBillableCustomer rejects another cashier's customer with 404", async () => {
  // Same store, but a different `_user_email`. The cashier should not be
  // able to link an admin-created customer (which carries a different
  // _user_email) by guessing its id.
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "AdminCustomer",
    approvalStatus: "approved",
    storeType: "service",
    storeId: "A",
    _userEmail: "admin@example.com",
  });
  await assert.rejects(
    resolveBillableCustomer(1001, baseScope(), deps),
    (err) => err.status === 404
  );
});

test("resolveBillableCustomer rejects pending customer with 422", async () => {
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "PendingCustomer",
    approvalStatus: "pending",
    storeType: "service",
    storeId: "A",
    _userEmail: "cashier-a@example.com",
  });
  await assert.rejects(
    resolveBillableCustomer(1001, baseScope(), deps),
    (err) => err.status === 422 && /pending/i.test(err.message)
  );
});

test("resolveBillableCustomer rejects rejected customer with 422", async () => {
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "RejectedCustomer",
    approvalStatus: "rejected",
    storeType: "service",
    storeId: "A",
    _userEmail: "cashier-a@example.com",
  });
  await assert.rejects(
    resolveBillableCustomer(1001, baseScope(), deps),
    (err) => err.status === 422 && /rejected/i.test(err.message)
  );
});

test("resolveBillableCustomer accepts approved same-store customer", async () => {
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "ApprovedCustomer",
    approvalStatus: "approved",
    storeType: "service",
    storeId: "A",
    _userEmail: "cashier-a@example.com",
  });
  const out = await resolveBillableCustomer(1001, baseScope(), deps);
  assert.deepEqual(out, { id: 1001 });
});

test("resolveBillableCustomer treats legacy NULL approvalStatus as approved", async () => {
  // The migration backfill sets NULL/blank to 'approved', but the helper
  // also defensively accepts rows where the column is missing/null as
  // approved — so a freshly-migrated row that hasn't been touched yet
  // doesn't break the POS billing path.
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "LegacyCustomer",
    approvalStatus: null,
    storeType: "service",
    storeId: "A",
    _userEmail: "cashier-a@example.com",
  });
  const out = await resolveBillableCustomer(1001, baseScope(), deps);
  assert.deepEqual(out, { id: 1001 });
});

test("resolveBillableCustomer normalizes string ids to numbers", async () => {
  fakeCustomersQueries.setRow(1001, {
    id: 1001,
    name: "Approved",
    approvalStatus: "approved",
    storeType: "service",
    storeId: "A",
    _userEmail: "cashier-a@example.com",
  });
  const out = await resolveBillableCustomer("1001", baseScope(), deps);
  assert.equal(out.id, 1001);
  assert.equal(typeof out.id, "number");
});

// === invoices query signature contract ====================================
//
// The route layer relies on these signatures. We can't load
// db/queries/invoices.js here without the real DB pool (it requires
// ./db/pool which throws on missing env vars), but we can read the
// function shape directly from the file via a token-level grep —
// these assertions guard against a future refactor that silently
// drops the `customerId` parameter.

const fs = require("node:fs");
const path = require("node:path");
const invoicesSrc = fs.readFileSync(
  path.join(__dirname, "db/queries/invoices.js"),
  "utf8"
);

test("invoicesQueries.create signature accepts customerId", () => {
  const match = invoicesSrc.match(/const create = async \(\s*item\s*,\s*scope\s*,\s*conn\s*,\s*customerId\s*\)/);
  assert.ok(
    match,
    "create() must be declared as (item, scope, conn, customerId)"
  );
});

test("invoicesQueries.createWithStockDecrement signature accepts customerId", () => {
  const match = invoicesSrc.match(
    /const createWithStockDecrement = async \(\s*invoice\s*,\s*resolveQty\s*,\s*scope\s*,\s*conn\s*,\s*customerId\s*\)/
  );
  assert.ok(
    match,
    "createWithStockDecrement() must be declared as (invoice, resolveQty, scope, conn, customerId)"
  );
});

test("invoicesQueries.create INSERT shape writes customer_id column when migration is present", () => {
  // The dynamic INSERT shape branches on `hasCustomerIdColumn` and
  // adds `customer_id` to the INSERT only when the runtime migration
  // added the column. The route layer relies on this — if the shape
  // is dropped, a cashier-supplied customerId would silently vanish.
  assert.ok(
    /if \(hasCustomerIdColumn\) \{[\s\S]*?insertCols \+= ", customer_id"[\s\S]*?\}/.test(invoicesSrc),
    "create() must include the customer_id branch in its INSERT shape"
  );
});

test("invoicesQueries.createWithStockDecrement INSERT shape writes customer_id column when migration is present", () => {
  // Two `if (hasCustomerIdColumn)` blocks exist in the file (one per
  // create path). Both must include the customer_id branch.
  const matches = invoicesSrc.match(/if \(hasCustomerIdColumn\) \{[\s\S]*?insertCols \+= ", customer_id"[\s\S]*?\}/g);
  assert.ok(matches && matches.length >= 2, "expected customer_id branch in both create paths");
});
