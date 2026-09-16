const test = require("node:test");
const assert = require("node:assert/strict");

const { getRequestScope } = require("./lib/request-scope");
const { buildInvoiceNoScope } = require("./lib/invoice-scope");
const {
  findAuthorizedInvoiceByNo,
  getAuthorizedInvoiceScope,
} = require("./lib/invoice-authorization");

const invoice = (invoiceNo, storeId, storeType = "service", email = "owner@example.com") => ({
  id: `${storeType}-${storeId}-${invoiceNo}`,
  invoiceNo,
  storeType,
  storeId,
  _storeType: storeType,
  _storeId: storeId,
  _userEmail: email,
  items: [{ name: "Service", qty: 1, price: 100 }],
  grandTotal: 118,
});

const fixture = [
  invoice("SVC-A-001", "A", "service", "admin-a@example.com"),
  invoice("SVC-B-001", "B", "service", "admin-b@example.com"),
  invoice("SVC-A-CASHIER", "A", "service", "cashier-a@example.com"),
  invoice("H-OWNER-001", "H1", "hotel", "owner@example.com"),
];

const findByInvoiceNoScoped = (invoiceNo, scope) =>
  fixture.find((row) =>
    row.invoiceNo === String(invoiceNo) &&
    (!scope.storeType || row._storeType === scope.storeType) &&
    (!scope.storeId || row._storeId === scope.storeId) &&
    (!scope.email || row._userEmail === scope.email)
  ) || null;

const findByInvoiceNo = (invoiceNo) =>
  fixture.find((row) => row.invoiceNo === String(invoiceNo)) || null;

const lookup = (user, invoiceNo, query = {}) =>
  findAuthorizedInvoiceByNo(
    { user, query },
    invoiceNo,
    findByInvoiceNoScoped
  );

test("scoped invoice predicate binds invoice number and authenticated scope", () => {
  assert.deepEqual(buildInvoiceNoScope("SVC-A-001", {
    storeType: "service",
    storeId: "A",
    email: "cashier-a@example.com",
  }), {
    where: "invoice_no = ? AND _store_type = ? AND _store_id = ? AND _user_email = ?",
    params: ["SVC-A-001", "service", "A", "cashier-a@example.com"],
  });
});

test("Store A can retrieve a same-scope invoice", () => {
  const row = lookup(
    { role: "STORE_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
    "SVC-A-001"
  );
  assert.equal(row.invoiceNo, "SVC-A-001");
});

test("Store A cannot retrieve Store B invoice", () => {
  assert.equal(
    lookup(
      { role: "STORE_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
      "SVC-B-001"
    ),
    null
  );
});

test("Store B cannot retrieve Store A invoice", () => {
  assert.equal(
    lookup(
      { role: "STORE_ADMIN", email: "admin-b@example.com", storeType: "service", storeId: "B" },
      "SVC-A-001"
    ),
    null
  );
});

test("cashier scope rejects another store even with widening query parameters", () => {
  assert.equal(
    lookup(
      { role: "CASHIER", email: "cashier-a@example.com", storeType: "service", storeId: "A" },
      "SVC-B-001",
      { storeType: "service", storeId: "B" }
    ),
    null
  );
});

test("branch admin scope-equivalent users cannot cross stores", () => {
  assert.equal(
    lookup(
      { role: "BRANCH_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
      "SVC-B-001"
    ),
    null
  );
});

test("SUPER_OWNER preserves unscoped and explicit scoped behavior", () => {
  const owner = { role: "SUPER_OWNER", email: "owner@example.com", storeType: "system", storeId: "" };
  assert.equal(lookup(owner, "H-OWNER-001").invoiceNo, "H-OWNER-001");
  assert.equal(lookup(owner, "SVC-A-001").invoiceNo, "SVC-A-001");
  assert.equal(
    lookup(owner, "SVC-B-001", { storeType: "service", storeId: "B" }).invoiceNo,
    "SVC-B-001"
  );
  assert.equal(
    lookup(owner, "H-OWNER-001", { storeType: "hotel", storeId: "H1" }).invoiceNo,
    "H-OWNER-001"
  );
  assert.equal(
    lookup(owner, "SVC-A-001", { storeType: "hotel", storeId: "H1" }),
    null
  );
});

test("ordinary users without a concrete store scope are rejected", () => {
  assert.throws(
    () => getAuthorizedInvoiceScope({ user: { role: "STORE_ADMIN", email: "admin-a@example.com" } }),
    (error) => error.status === 403
  );
});

test("unknown invoice remains a not-found result", () => {
  assert.equal(
    lookup(
      { role: "STORE_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
      "does-not-exist"
    ),
    null
  );
});

test("service invoice lookup preserves the direct invoice object contract", () => {
  const row = lookup(
    { role: "STORE_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
    "SVC-A-001"
  );
  assert.equal(row.storeType, "service");
  assert.ok(Array.isArray(row.items));
  assert.equal(row.grandTotal, 118);
  assert.equal(Object.prototype.hasOwnProperty.call(row, "invoice"), false);
});

test("PUT-style scoped lookup allows same store and rejects cross-store", () => {
  const sameScope = lookup(
    { role: "STORE_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
    "SVC-A-001"
  );
  assert.equal(sameScope.id, "service-A-SVC-A-001");
  assert.equal(
    lookup(
      { role: "STORE_ADMIN", email: "admin-a@example.com", storeType: "service", storeId: "A" },
      "SVC-B-001"
    ),
    null
  );
});

test("public lookup remains unscoped in its separate contract", () => {
  const row = findByInvoiceNo("SVC-B-001");
  assert.equal(row._storeId, "B");
  assert.equal(row.invoiceNo, "SVC-B-001");
});
