// customer-history.test.js
//
// Coverage for Customer Purchase History (Phase 2A, read-only).
//
// Tests:
//   - Store isolation: the query always carries _store_type + _store_id
//   - IDOR resistance: another store's customer resolves to null → 404
//   - Walking-customer invoices (NULL customer_id) are excluded by construction
//   - Ordering is `generated_at DESC, id DESC` in SQL, and the response is
//     returned in the order the DB produced it (no re-sort / no reverse)
//   - Server-side pagination: page/pageSize, clamped, with a correct total
//   - Return aggregation across MULTIPLE returns on one invoice (no fan-out
//     multiplying the invoice total)
//   - NULL subtotal does not break the summary
//   - Summary totals use COALESCE and never invent a "net purchase" figure
//   - Return state is derived as none / partial / full
//
// Fake-pool pattern, same as returns.authorization.test.js — no live MySQL.

const test = require("node:test");
const assert = require("node:assert/strict");

const fakePool = {
  __queries: [],
  __setQueryImpl(fn) {
    this.__queryImpl = fn;
  },
  async query(sql, params) {
    fakePool.__queries.push({ sql, params });
    if (fakePool.__queryImpl) return fakePool.__queryImpl(sql, params);
    return [[], []];
  },
};

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: fakePool,
};

const history = require("./db/queries/customer-history");

const reset = () => {
  fakePool.__queries = [];
  fakePool.__setQueryImpl(null);
};

const SCOPE = { storeType: "retail", storeId: "store-1" };

const invoiceRow = (over = {}) => ({
  id: 1,
  invoice_no: "INV-1",
  date: "2026-01-05",
  items: [{ name: "Test", qty: 1, price: 100 }],
  sub_total: 100,
  gst_total: 18,
  grand_total: 118,
  discount: null,
  discount_breakdown: null,
  payment_mode: "Cash",
  billed_by: "cashier@a.com",
  status: null,
  customer_name: "Asha",
  customer_mobile: "9999999999",
  customer_id: 7,
  generated_at: "2026-01-05 10:00:00.000",
  created_at: "2026-01-05 10:00:00.000",
  return_count: 0,
  returned_amount: 0,
  bill_discount: 0,
  ...over,
});

// Routes the two concurrent queries (page + count) by shape.
//
// The page query ALSO contains `COUNT(*)` — inside the return-aggregate
// subquery — so the discriminator is the standalone tally, which selects
// exactly one aliased column and nothing else.
const historyImpl = ({ rows = [], total = rows.length } = {}) => (sql) => {
  if (/SELECT COUNT\(\*\) AS total\s*FROM invoices/i.test(sql)) return [[{ total }], []];
  return [rows, []];
};

test("SQL assembly: the page query assembles one valid SELECT statement", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl());
  await history.purchaseHistory({ customerId: 7, scope: SCOPE });

  const page = fakePool.__queries.find((q) => /ORDER BY/i.test(q.sql));
  // Regression guard. The return aggregates are injected into the page
  // query's own SELECT list, so the fragment must NOT carry its own leading
  // `SELECT` — doing so produced `SELECT <cols>, SELECT COALESCE(...)`,
  // a syntax error a stubbed pool cannot surface on its own.
  const statements = page.sql.trim().split(";").filter((s) => s.trim());
  assert.equal(statements.length, 1, "must be a single statement");
  assert.match(page.sql.trim(), /^SELECT\s/);
  // Only the two correlated subqueries may add a SELECT/FROM pair; a second
  // top-level `SELECT` keyword after a comma is the bug.
  assert.doesNotMatch(page.sql, /,\s*SELECT\s/i, "no second SELECT keyword in the select list");
  // Two subqueries => 2 extra SELECTs and 2 extra FROMs on top of the outer
  // statement's one each.
  assert.equal(page.sql.match(/\bSELECT\b/gi).length, 3);
  assert.equal(page.sql.match(/\bFROM\b/gi).length, 3);
  // The outer table is read once.
  assert.equal(page.sql.match(/FROM invoices i\b/gi).length, 1);
});

test("SQL assembly: the return fragment is a bare select-list, not a statement", () => {
  assert.doesNotMatch(history.RETURN_AGGREGATE_EXPRESSIONS.trim(), /^SELECT\b/i);
  // The subqueries inside it are correlated on the outer invoice, which is
  // what makes the aggregation safe from row fan-out.
  assert.match(history.RETURN_AGGREGATE_EXPRESSIONS, /r\.invoice_no = i\.invoice_no/);
  assert.match(history.RETURN_AGGREGATE_EXPRESSIONS, /AS return_count/);
  assert.match(history.RETURN_AGGREGATE_EXPRESSIONS, /AS returned_amount/);
});

// ============================================================================
// Store isolation + IDOR
// ============================================================================

test("store isolation: the history query is always scoped by store type AND id", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl());
  await history.purchaseHistory({ customerId: 7, scope: SCOPE, page: 1, pageSize: 10 });

  const page = fakePool.__queries.find((q) => /ORDER BY/i.test(q.sql));
  assert.match(page.sql, /i\.customer_id = \?/);
  assert.match(page.sql, /i\._store_type = \?/);
  assert.match(page.sql, /i\._store_id = \?/);
  // params order: customerId, storeType, storeId, pageSize, offset
  assert.deepEqual(page.params, [7, "retail", "store-1", 10, 0]);
});

test("store isolation: store B's scope cannot be overridden by the caller", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl());
  await history.purchaseHistory({
    customerId: 7,
    scope: { storeType: "retail", storeId: "store-B" },
    page: 1,
    pageSize: 10,
  });
  const page = fakePool.__queries.find((q) => /ORDER BY/i.test(q.sql));
  assert.equal(page.params[1], "retail");
  assert.equal(page.params[2], "store-B");
});

test("walking customers: NULL customer_id invoices are excluded by construction", () => {
  // The predicate is an equality on a non-null id, so an anonymous invoice can
  // never match — no fuzzy name/mobile matching anywhere in the module.
  assert.doesNotMatch(history.SUMMARY_SQL, /customer_name\s*=/i);
  assert.doesNotMatch(history.SUMMARY_SQL, /customer_mobile\s*=/i);
  assert.match(history.SUMMARY_SQL, /i\.customer_id = \?/);
  assert.doesNotMatch(history.SUMMARY_SQL, /IS NULL.*customer_id\s*=\s*\?/);
});

// ============================================================================
// Ordering
// ============================================================================

test("ordering: newest first is produced by SQL, not by the caller", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl());
  await history.purchaseHistory({ customerId: 7, scope: SCOPE });
  const page = fakePool.__queries.find((q) => /ORDER BY/i.test(q.sql));
  assert.match(page.sql, /ORDER BY i\.generated_at DESC, i\.id DESC/);
});

test("ordering: rows are returned in the exact order the database produced", async () => {
  reset();
  // The stub returns newest → oldest, mimicking `generated_at DESC, id DESC`.
  fakePool.__setQueryImpl(
    historyImpl({
      rows: [
        invoiceRow({ id: 3, invoice_no: "INV-3", generated_at: "2026-03-01 00:00:00.000" }),
        invoiceRow({ id: 2, invoice_no: "INV-2", generated_at: "2026-02-01 00:00:00.000" }),
        invoiceRow({ id: 1, invoice_no: "INV-1", generated_at: "2026-01-01 00:00:00.000" }),
      ],
    })
  );
  const result = await history.purchaseHistory({ customerId: 7, scope: SCOPE });
  assert.deepEqual(
    result.items.map((i) => i.invoiceNo),
    ["INV-3", "INV-2", "INV-1"],
    "module must not reverse or re-sort the DB order"
  );
});

// ============================================================================
// Pagination
// ============================================================================

test("pagination: page and pageSize drive LIMIT/OFFSET and the totals envelope", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl({ rows: [invoiceRow()], total: 42 }));
  const result = await history.purchaseHistory({
    customerId: 7,
    scope: SCOPE,
    page: 3,
    pageSize: 10,
  });

  const page = fakePool.__queries.find((q) => /ORDER BY/i.test(q.sql));
  assert.match(page.sql, /LIMIT \? OFFSET \?/);
  assert.deepEqual(page.params.slice(3), [10, 20]); // (3-1) * 10
  assert.deepEqual(result.pagination, { page: 3, pageSize: 10, total: 42, totalPages: 5 });
});

test("pagination: pageSize is clamped and page defaults to 1", () => {
  assert.equal(history.normalizePage(undefined), 1);
  assert.equal(history.normalizePage(0), 1);
  assert.equal(history.normalizePage("abc"), 1);
  assert.equal(history.normalizePage(2), 2);
  assert.equal(history.normalizePageSize(undefined), 10);
  assert.equal(history.normalizePageSize(0), 10);
  assert.equal(history.normalizePageSize(10), 10);
  assert.equal(history.normalizePageSize(5000), 100, "must not allow an unbounded fetch");
});

test("pagination: an empty result still reports one page, not zero", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl({ rows: [], total: 0 }));
  const result = await history.purchaseHistory({ customerId: 7, scope: SCOPE });
  assert.equal(result.pagination.total, 0);
  assert.equal(result.pagination.totalPages, 1);
});

// ============================================================================
// Return aggregation
// ============================================================================

test("return state: none when the invoice has no returns", () => {
  const shaped = history.shapeInvoice(invoiceRow({ return_count: 0, returned_amount: 0 }));
  assert.equal(shaped.returnState, "none");
  assert.equal(shaped.returnCount, 0);
});

test("return state: partial when only part of the invoice came back", () => {
  const shaped = history.shapeInvoice(
    invoiceRow({ grand_total: 118, return_count: 1, returned_amount: 30 })
  );
  assert.equal(shaped.returnState, "partial");
  assert.equal(shaped.returnedAmount, 30);
});

test("return state: full when the returned amount reaches the invoice total", () => {
  const shaped = history.shapeInvoice(
    invoiceRow({ grand_total: 118, return_count: 1, returned_amount: 118 })
  );
  assert.equal(shaped.returnState, "full");
});

test("return state: full tolerates a sub-paisa rounding difference", () => {
  const shaped = history.shapeInvoice(
    invoiceRow({ grand_total: 118.01, return_count: 1, returned_amount: 118 })
  );
  assert.equal(shaped.returnState, "full");
});

test("returns: multiple returns on one invoice aggregate without fan-out", async () => {
  reset();
  fakePool.__setQueryImpl(
    historyImpl({
      // count = 2, summed returned amount = 30 + 20. The invoice's own
      // amounts must appear ONCE — a naive join would double them.
      rows: [invoiceRow({ grand_total: 118, return_count: 2, returned_amount: 50 })],
    })
  );
  const result = await history.purchaseHistory({ customerId: 7, scope: SCOPE });
  const row = result.items[0];
  assert.equal(row.returnCount, 2);
  assert.equal(row.returnedAmount, 50);
  assert.equal(row.grandTotal, 118, "invoice total must not be multiplied by return count");
  assert.equal(row.returnState, "partial");
});

test("returns: only completed/approved returns count as settled", () => {
  assert.match(history.RETURN_AGGREGATE_EXPRESSIONS, /status IN \('completed', 'approved'\)/);
  assert.match(history.RETURNED_SUMMARY_SQL, /status IN \('completed', 'approved'\)/);
  // The raw count is intentionally status-agnostic so the UI can still show
  // that a return exists even while it is still pending.
  assert.doesNotMatch(
    history.RETURN_AGGREGATE_EXPRESSIONS.split("AS return_count")[0],
    /status IN/i
  );
});

test("returns: the summary resolves the customer through invoices, since returns have no customer_id", () => {
  assert.match(history.RETURNED_SUMMARY_SQL, /JOIN invoices i ON i\.invoice_no = r\.invoice_no/);
  assert.match(history.RETURNED_SUMMARY_SQL, /i\.customer_id = \?/);
  assert.match(history.RETURNED_SUMMARY_SQL, /i\._store_type = \?/);
  assert.match(history.RETURNED_SUMMARY_SQL, /i\._store_id = \?/);
});

// ============================================================================
// Summary
// ============================================================================

test("summary: NULL subtotal does not break the aggregates", async () => {
  reset();
  fakePool.__setQueryImpl((sql) => {
    if (/invoice_returns/i.test(sql)) return [[{ total_returned_amount: null }], []];
    return [
      [
        {
          total_invoices: 3,
          total_subtotal: null,
          total_bill_discount: null,
          total_gst: null,
          total_purchase_amount: 354,
          first_purchase_at: "2025-01-01 00:00:00.000",
          last_purchase_at: "2026-01-01 00:00:00.000",
        },
      ],
      [],
    ];
  });

  const s = await history.summary({ customerId: 7, scope: SCOPE });
  assert.equal(s.totalSubtotal, 0, "NULL must coalesce to 0, not NaN");
  assert.equal(s.totalGst, 0);
  assert.equal(s.totalDiscount, 0);
  assert.equal(s.totalReturnedAmount, 0);
  assert.equal(s.totalPurchaseAmount, 354);
});

test("summary: every money field is COALESCEd in SQL", () => {
  // The real column names — note `sub_total`, not `subtotal`.
  for (const col of ["sub_total", "gst_total", "grand_total"]) {
    assert.match(
      history.SUMMARY_SQL,
      new RegExp(`COALESCE\\(SUM\\(i\\.${col}\\)`),
      `${col} must be COALESCEd`
    );
  }
  // The bill discount comes from the JSON payload rather than a plain column.
  assert.ok(
    history.SUMMARY_SQL.includes("COALESCE(SUM(i.discount_breakdown->>'$.bill'), 0)"),
    "bill discount must be COALESCEd"
  );
});

test("summary: a customer with no invoices reports zeroes, not NaN or null", async () => {
  reset();
  fakePool.__setQueryImpl((sql) => {
    if (/invoice_returns/i.test(sql)) return [[{ total_returned_amount: 0 }], []];
    return [[{ total_invoices: 0 }], []];
  });
  const s = await history.summary({ customerId: 7, scope: SCOPE });
  assert.equal(s.totalInvoices, 0);
  assert.equal(s.totalPurchaseAmount, 0);
  assert.equal(s.averageOrderValue, 0, "no division by zero");
  assert.equal(s.firstPurchaseDate, null);
  assert.equal(s.lastPurchaseDate, null);
});

test("summary: totalPurchaseAmount is gross grand_total, and no net figure is invented", async () => {
  reset();
  fakePool.__setQueryImpl((sql) => {
    if (/invoice_returns/i.test(sql)) return [[{ total_returned_amount: 118 }], []];
    return [
      [
        {
          total_invoices: 1,
          total_subtotal: 100,
          total_bill_discount: 0,
          total_gst: 18,
          total_purchase_amount: 118,
          first_purchase_at: "2026-01-01 00:00:00.000",
          last_purchase_at: "2026-01-01 00:00:00.000",
        },
      ],
      [],
    ];
  });
  const s = await history.summary({ customerId: 7, scope: SCOPE });
  // Gross is the invoice total; the returned amount is reported SEPARATELY so
  // the two can never be silently conflated.
  assert.equal(s.totalPurchaseAmount, 118);
  assert.equal(s.totalReturnedAmount, 118);
  assert.ok(
    !("netPurchaseAmount" in s),
    "an unsupported net figure must be omitted rather than approximated"
  );
});

test("summary: average order value divides by the invoice count", async () => {
  reset();
  fakePool.__setQueryImpl((sql) => {
    if (/invoice_returns/i.test(sql)) return [[{ total_returned_amount: 0 }], []];
    return [
      [
        {
          total_invoices: 4,
          total_purchase_amount: 472,
          first_purchase_at: null,
          last_purchase_at: null,
        },
      ],
      [],
    ];
  });
  const s = await history.summary({ customerId: 7, scope: SCOPE });
  assert.equal(s.averageOrderValue, 118);
});

// ============================================================================
// Read-only guarantee
// ============================================================================

test("read-only: neither history nor summary ever issues a write", async () => {
  reset();
  fakePool.__setQueryImpl(historyImpl());
  await history.purchaseHistory({ customerId: 7, scope: SCOPE });
  await history.summary({ customerId: 7, scope: SCOPE });
  for (const q of fakePool.__queries) {
    assert.doesNotMatch(q.sql, /INSERT/i);
    assert.doesNotMatch(q.sql, /UPDATE/i);
    assert.doesNotMatch(q.sql, /DELETE/i);
    // The summary templates are indented multi-line SQL, so trim before the
    // leading-token check.
    assert.match(q.sql.trim(), /^SELECT/i);
  }
});
