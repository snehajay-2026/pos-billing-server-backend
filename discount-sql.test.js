// discount-sql.test.js
//
// Coverage for the canonical invoice-discount aggregation.
//
// The bug this pins: `invoices.discount` and `invoices.discount_breakdown`
// are JSON columns, and four different call sites tried to SUM them — all
// wrong in different ways (see lib/discount-sql.js for the full history).
//
// The shapes asserted here are NOT invented — they are copied from the
// writers in the frontend:
//
//   Retail  POSBilling.jsx:1168-1181
//   Hotel   HotelBilling.jsx:3759-3766
//   Service ServiceBilling.jsx:515-518
//   Laundry (no discount at all)
//
// This is a SQL-string test rather than a MySQL test: the project has no live
// database in CI, and the security/correctness property being protected is
// "which JSON path is extracted", which is fully determined by the generated
// statement. An end-to-end SUM against a real engine is out of reach without
// credentials, and is called out in the final report.

const test = require("node:test");
const assert = require("node:assert/strict");

const { discountAmountSql, discountSumSql } = require("./lib/discount-sql");

const sql = discountSumSql();
const rowSql = discountAmountSql();

// === The actual stored shapes, verbatim from the frontend writers ==========

const RETAIL_WITH_BILL_AND_LINE = {
  discount: { type: "percent", value: 10, source: "manual" },
  discount_breakdown: {
    line: [
      { productId: 1, productName: "A", discount: { type: "flat", value: 50, source: "manual" }, saved: 50 },
      { productId: 2, productName: "B", discount: { type: "percent", value: 5, source: "manual" }, saved: 25 },
    ],
    // NOTE: `bill` here is an OBJECT, not a number.
    bill: { type: "percent", value: 10, source: "manual" },
    totalSavings: 175, // 50 + 25 line savings + 100 bill saving
  },
};

const RETAIL_NO_DISCOUNT = {
  discount: null,
  discount_breakdown: { line: [], bill: null, totalSavings: 0 },
};

const HOTEL = {
  discount: { type: "percent", value: 15, source: "coupon", code: "SAVE15" },
  discount_breakdown: { bill: 150, totalSavings: 150, taxableAmount: 850, discountRatio: 0.85, preDiscountSubtotal: 1000 },
};

const SERVICE = {
  discount: { type: "percent", value: 12, source: "manual" },
  // NOTE: no totalSavings, and `bill` is a NUMBER.
  discount_breakdown: { bill: 120, taxableAmount: 880 },
};

const LAUNDRY = { discount: undefined, discount_breakdown: undefined };

// ===========================================================================
// 1. No SUM() over a raw JSON column anywhere.
// ===========================================================================
test("never aggregates the JSON discount column directly", () => {
  assert.ok(!/SUM\(\s*`?discount`?\s*\)/i.test(sql), "must not SUM(discount)");
  assert.ok(!/SUM\(\s*`?discount_breakdown`?\s*\)/i.test(sql), "must not SUM(discount_breakdown)");
});

test("never uses ->>'$.bill' unquoting, which is not a number for Retail", () => {
  assert.ok(!sql.includes("->>"), "the ->> operator yields the object's JSON text");
  assert.ok(!sql.includes("->'$"), "the -> operator does not coerce to a scalar");
});

// ===========================================================================
// 2. The resolution order, and the numeric-type guards.
// ===========================================================================
test("prefers totalSavings, then falls back to a numeric bill", () => {
  const ts = sql.indexOf("$.totalSavings");
  const bill = sql.indexOf("$.bill");
  assert.ok(ts > -1, "must read totalSavings");
  assert.ok(bill > -1, "must fall back to bill");
  assert.ok(ts < bill, "totalSavings must be tried first so Service's bill is only a fallback");
});

test("guards both paths on JSON_TYPE so an object never CASTs to 0", () => {
  // Retail's `bill` is an OBJECT. Without a JSON_TYPE guard the CAST would
  // silently yield 0 and — worse — a Retail invoice that somehow lost
  // totalSavings would report a half-counted figure.
  const guards = sql.match(/JSON_TYPE\(JSON_EXTRACT\([^)]*\)\)/g) || [];
  assert.equal(guards.length, 2, "both JSON paths need a type guard");
  assert.match(sql, /JSON_TYPE\(JSON_EXTRACT\([^)]*'\$\.totalSavings'\)\) IN \('INTEGER', 'DOUBLE', 'DECIMAL'\)/);
  assert.match(sql, /JSON_TYPE\(JSON_EXTRACT\([^)]*'\$\.bill'\)\) IN \('INTEGER', 'DOUBLE', 'DECIMAL'\)/);
});

test("casts through JSON_UNQUOTE so the value is numeric, not JSON text", () => {
  assert.match(sql, /CAST\(JSON_UNQUOTE\(JSON_EXTRACT\([^)]*'\$\.totalSavings'\)\) AS DECIMAL\(12,2\)\)/);
});

// ===========================================================================
// 3. NULL / missing / malformed safety — a row must contribute 0, not fail.
// ===========================================================================
test("a NULL breakdown short-circuits to 0 before any JSON function runs", () => {
  assert.match(rowSql, /WHEN (?:i\.)?discount_breakdown IS NULL THEN 0/);
  // The NULL guard must be the FIRST branch, so a NULL column never reaches
  // JSON_EXTRACT (which would return NULL and fall to ELSE anyway, but the
  // explicit guard keeps the intent obvious).
  const firstWhen = rowSql.indexOf("WHEN");
  const nullGuard = rowSql.indexOf("IS NULL THEN 0");
  assert.ok(nullGuard > firstWhen);
  assert.ok(nullGuard < rowSql.indexOf("$.totalSavings"), "NULL guard precedes JSON extraction");
});

test("a row with no matching key falls through to the ELSE 0 branch", () => {
  assert.match(rowSql, /ELSE 0/);
  // Every path either returns a CAST or 0 — no branch returns NULL, so a
  // single odd row can never make SUM() (and the whole report) NULL.
  const branches = rowSql.split("WHEN").slice(1);
  assert.ok(branches.length >= 3, "expected a NULL guard, two key branches and an ELSE");
});

test("wraps the SUM so an empty period returns 0 rather than NULL", () => {
  // `SUM()` over zero rows is NULL. A report printing a blank or NaN where a
  // zero belongs is worse than a zero.
  assert.match(sql, /^COALESCE\(SUM\(/);
  assert.match(sql, /\), 0\)$/);
});

// ===========================================================================
// 4. No double counting.
// ===========================================================================
test("reads the pre-computed total rather than re-adding line and bill", () => {
  // `line[]` is an ARRAY — summing it would need a JSON_TABLE (TiDB-only) and
  // adding it to `bill` would double count, because Retail's totalSavings
  // already contains the line savings.
  assert.ok(!sql.includes("$.line"), "must not touch the line array");
  assert.ok(!/JSON_TABLE/.test(sql), "no JSON_TABLE — that is not portable to MySQL");
  assert.ok(!/\+\s*CAST/.test(sql), "must not add line and bill together");
});

// ===========================================================================
// 5. Portability: MySQL 5.7+ / TiDB, no PostgreSQL-only syntax.
// ===========================================================================
test("uses only MySQL/TiDB-compatible JSON functions", () => {
  assert.ok(!sql.includes("->>"), "PostgreSQL / MySQL ->> operator");
  assert.ok(!/\bVALUE\s*\(/i.test(sql), "PostgreSQL jsonb #>");
  assert.ok(!/::DECIMAL/.test(sql), "PostgreSQL :: cast");
  assert.match(sql, /JSON_EXTRACT/);
  assert.match(sql, /JSON_TYPE/);
  assert.match(sql, /JSON_UNQUOTE/);
  assert.match(sql, /DECIMAL\(12,2\)/);
});

// ===========================================================================
// 6. Column qualification is caller-controlled, and defaults are safe.
// ===========================================================================
test("defaults to an unqualified column and honours an explicit alias", () => {
  // reports.js selects `FROM invoices` with no alias, so the default must not
  // emit `i.` or the statement would not run.
  const dflt = discountSumSql();
  assert.ok(!dflt.includes("i.discount"), "default must be unqualified");
  assert.match(dflt, /WHEN discount_breakdown IS NULL THEN 0/);
  // Aliased callers get the qualified form.
  assert.match(discountSumSql("i.discount", "i.discount_breakdown"), /i\.discount_breakdown IS NULL/);
});

// ===========================================================================
// 7. Authorization is untouched by this change.
// ===========================================================================
test("the expression contains no store or user predicates of its own", () => {
  // Store/role isolation is the caller's WHERE clause (getRequestScope).
  // The discount expression must not smuggle in or drop a tenant predicate.
  for (const forbidden of ["_store_type", "_store_id", "_user_email", "customer_id"]) {
    assert.ok(!sql.includes(forbidden), `discount SQL must not reference ${forbidden}`);
  }
});

// ===========================================================================
// 8. The real shapes still resolve to the right number, per the CASE order.
//    (The SQL text encodes the order; these assert the shapes line up with it.)
// ===========================================================================
test("Retail: totalSavings is the whole line+bill figure", () => {
  const { discount_breakdown } = RETAIL_WITH_BILL_AND_LINE;
  assert.equal(typeof discount_breakdown.bill, "object", "Retail bill is an object, not a number");
  assert.equal(discount_breakdown.totalSavings, 175);
  // The line savings (50 + 25) are already inside totalSavings, so the
  // expression must return 175 and must not add anything.
  const lineSum = discount_breakdown.line.reduce((s, l) => s + l.saved, 0);
  assert.equal(discount_breakdown.totalSavings, lineSum + 100);
});

test("Retail with no discount: totalSavings is 0 and bill is null", () => {
  assert.equal(RETAIL_NO_DISCOUNT.discount_breakdown.totalSavings, 0);
  assert.equal(RETAIL_NO_DISCOUNT.discount_breakdown.bill, null);
});

test("Hotel: writes both, and they agree", () => {
  assert.equal(typeof HOTEL.discount_breakdown.bill, "number");
  assert.equal(HOTEL.discount_breakdown.bill, HOTEL.discount_breakdown.totalSavings);
});

test("Service: has no totalSavings, and bill IS the whole discount", () => {
  assert.equal(SERVICE.discount_breakdown.totalSavings, undefined, "Service writes no totalSavings");
  assert.equal(typeof SERVICE.discount_breakdown.bill, "number", "Service bill is a number");
  // This is the case the previous dashboard expression got wrong (returned 0)
  // and the case `->>'$.bill'` also got wrong (it worked for Service but not
  // for Retail, so neither was right everywhere).
  assert.equal(SERVICE.discount_breakdown.bill, 120);
});

test("Laundry: no discount fields at all", () => {
  assert.equal(LAUNDRY.discount, undefined);
  assert.equal(LAUNDRY.discount_breakdown, undefined);
});

// ===========================================================================
// 9. Every call site now uses the shared expression.
// ===========================================================================
test("no module re-implements the discount extraction inline", () => {
  const fs = require("fs");
  const path = require("path");
  const files = [
    "db/queries/reports.js",
    "db/queries/shifts.js",
    "db/queries/customer-history.js",
    "db/queries/dashboard.js",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
    // Strip comments so the explanatory prose does not trip this.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(!/SUM\(\s*`?discount`?\s*\)/i.test(code), `${rel} must not SUM(discount)`);
    assert.ok(!code.includes("->>'$.bill'"), `${rel} must not use ->>'$.bill'`);
  }
});

test("customer-history exposes the same figure for a row as it sums for a total", () => {
  // The per-row `bill_discount` and the lifetime `total_bill_discount` must
  // be the SAME expression, or a customer's line items would not add up to
  // their lifetime total.
  const perRow = discountAmountSql("i.discount", "i.discount_breakdown");
  const summed = discountSumSql("i.discount", "i.discount_breakdown");
  // Strip the aggregate wrapper and normalise whitespace; the CASE bodies must
  // be character-identical.
  const core = (s) =>
    s.replace(/^COALESCE\(SUM\(/, "").replace(/\), 0\)\s*$/, "").replace(/\s+/g, " ").trim();
  assert.equal(core(summed), core(perRow));
});
