// shift-discount.test.js
//
// Arithmetic coverage for the shift-close discount total.
//
// The defect: `shifts.invoiceTotals` used to compute a percentage discount as
//   sub_total * discountPercent / 100
// but `sub_total` is stored POST-discount (POSBilling.jsx:1055 —
// `subTotal = subTotalBeforeBillDiscount - billDiscountAmount`). So a 10%
// discount on a ₹1000 gross, stored as sub_total ₹900, reported ₹90 instead of
// ₹100 — roughly a 10% under-report on every percent discount.
//
// The fix reads the canonical monetary figure the POS already stored
// (`discount_breakdown.totalSavings`, with `$.bill` as the Service fallback),
// via lib/discount-sql.js. It does not recompute anything.
//
// WHY A JS MODEL RATHER THAN SQL ASSERTIONS
// discount-sql.test.js already pins the generated SQL. This file pins the
// ARITHMETIC: it re-implements the JSON path resolution over the exact shapes
// the frontend writes and asserts the resulting totals. That is the assertion
// the ticket actually asks for ("expected shift discount = ₹100"), and it does
// not need a live database. The shared `discountAmountSql` resolution order is
// asserted to be identical to this model, so the two cannot drift.
//
// Every fixture below is derived from the real writers:
//   POSBilling.jsx:1034-1041 (applyDiscount), :1050-1067 (totals), :1168-1181
//   HotelBilling.jsx:3611-3621, ServiceBilling.jsx:515-518

const test = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// The POS's own discount + total math, copied from POSBilling.jsx.
// ---------------------------------------------------------------------------

// POSBilling.jsx:1034 — percent is taken off the base, flat is taken off the
// base, and neither can exceed it.
const applyDiscount = (base, discount) => {
  if (!discount || !discount.value || Number(discount.value) <= 0) return 0;
  const v = Number(discount.value);
  if (discount.type === "percent") return Math.min(base, (base * v) / 100);
  return Math.min(base, v);
};

// POSBilling.jsx:1050-1056. subTotal is POST-discount — this is the fact the
// whole ticket turns on.
const computePosTotals = (items, billDiscount) => {
  const subTotalBeforeBillDiscount = items.reduce((s, i) => s + i.effective, 0);
  const lineDiscountTotal = items.reduce((s, i) => s + applyDiscount(i.gross, i.lineDiscount), 0);
  const billDiscountAmount = applyDiscount(subTotalBeforeBillDiscount, billDiscount);
  const subTotal = subTotalBeforeBillDiscount - billDiscountAmount;
  const totalSavings = lineDiscountTotal + billDiscountAmount;
  return { subTotal, lineDiscountTotal, billDiscountAmount, totalSavings };
};

// The resolution order implemented by lib/discount-sql.js, in JS.
const canonicalDiscount = (discountBreakdown) => {
  if (discountBreakdown == null) return 0;
  if (typeof discountBreakdown.totalSavings === "number") return discountBreakdown.totalSavings;
  if (typeof discountBreakdown.bill === "number") return discountBreakdown.bill;
  return 0;
};

// The full shift aggregate: SUM over the invoices linked to the shift.
const shiftDiscountTotal = (invoices) =>
  invoices.reduce((sum, inv) => sum + canonicalDiscount(inv.discount_breakdown), 0);

// The broken formula, kept ONLY to demonstrate the regression it caused.
const brokenShiftDiscountTotal = (invoices) =>
  invoices.reduce((sum, inv) => {
    const d = inv.discount;
    if (!d || d.value == null) return sum;
    if (d.type === "percent") return sum + (inv.sub_total * Number(d.value)) / 100;
    if (d.type === "flat") return sum + Math.min(inv.sub_total, Number(d.value));
    return sum;
  }, 0);

// The Retail payload POSBilling.jsx:1168-1181 would produce.
const retailInvoice = ({ items, billDiscount, billedBy = "cashier-a@example.com" }) => {
  const t = computePosTotals(items, billDiscount);
  return {
    billedBy,
    sub_total: t.subTotal,
    discount: billDiscount ? { ...billDiscount, source: "manual" } : undefined,
    discount_breakdown: {
      line: items
        .filter((i) => i.lineDiscount && Number(i.lineDiscount.value) > 0)
        .map((i) => ({
          productName: i.name,
          discount: { ...i.lineDiscount, source: "manual" },
          saved: applyDiscount(i.gross, i.lineDiscount),
        })),
      bill: billDiscount ? { ...billDiscount, source: "manual" } : null,
      totalSavings: t.totalSavings,
    },
  };
};

// A single undiscounted line worth `amount`.
const line = (amount, lineDiscount = null, name = "Item") => ({
  name,
  gross: amount,
  // lineEffective() is gross minus that line's own discount.
  effective: lineDiscount ? amount - applyDiscount(amount, lineDiscount) : amount,
  lineDiscount,
});

// ===========================================================================
// A. Percentage discount — the ticket's worked example.
// ===========================================================================
test("A: 10% on a ₹1000 gross reports ₹100, not ₹90", () => {
  const inv = retailInvoice({
    items: [line(1000)],
    billDiscount: { type: "percent", value: 10 },
  });
  // The stored subtotal is post-discount — the fact that broke the old formula.
  assert.equal(inv.sub_total, 900);
  assert.equal(inv.discount_breakdown.totalSavings, 100);
  assert.equal(shiftDiscountTotal([inv]), 100);
  // And the old formula really was wrong by exactly the reported amount.
  assert.equal(brokenShiftDiscountTotal([inv]), 90);
});

// ===========================================================================
// B. A second percentage, to prove it is not a coincidence of one example.
// ===========================================================================
test("B: 15% on a ₹2000 gross reports ₹300", () => {
  const inv = retailInvoice({
    items: [line(2000)],
    billDiscount: { type: "percent", value: 15 },
  });
  assert.equal(inv.sub_total, 1700);
  assert.equal(shiftDiscountTotal([inv]), 300);
  assert.equal(brokenShiftDiscountTotal([inv]), 255);
});

// ===========================================================================
// C. Flat discount — no percentage reconstruction may be applied.
// ===========================================================================
test("C: a ₹100 flat discount on a ₹1000 gross reports ₹100", () => {
  const inv = retailInvoice({
    items: [line(1000)],
    billDiscount: { type: "flat", value: 100 },
  });
  assert.equal(inv.sub_total, 900);
  assert.equal(shiftDiscountTotal([inv]), 100);
  // The old formula was accidentally right for flat, which is why the bug
  // survived: it only mis-reported percent discounts.
  assert.equal(brokenShiftDiscountTotal([inv]), 100);
});

// ===========================================================================
// D. No discount at all.
// ===========================================================================
test("D: an invoice with no discount contributes 0", () => {
  const inv = retailInvoice({ items: [line(1000)], billDiscount: null });
  assert.equal(inv.sub_total, 1000);
  assert.equal(inv.discount_breakdown.totalSavings, 0);
  assert.equal(shiftDiscountTotal([inv]), 0);
});

// ===========================================================================
// E. Line + bill combined — the no-double-counting case.
// ===========================================================================
test("E: line discount + bill discount are reported once, combined", () => {
  // Two lines: 600 with a flat ₹50 off, 400 with no line discount. Bill 10% of
  // the post-line total (1000 - 50 = 950) = 95.
  const inv = retailInvoice({
    items: [line(600, { type: "flat", value: 50 }, "A"), line(400, null, "B")],
    billDiscount: { type: "percent", value: 10 },
  });
  assert.equal(inv.discount_breakdown.totalSavings, 50 + 95);
  // The shift total is that combined figure, NOT line + bill counted twice.
  assert.equal(shiftDiscountTotal([inv]), 145);
  // `bill` is an OBJECT here, so a naive `->>'$.bill'` read would be a non-number.
  assert.equal(typeof inv.discount_breakdown.bill, "object");
});

// ===========================================================================
// F. Multiple invoices — the shift total is the sum of each invoice's figure.
// ===========================================================================
test("F: a shift total is the sum across its invoices", () => {
  const invoices = [
    retailInvoice({ items: [line(1000)], billDiscount: { type: "percent", value: 10 }, billedBy: "a" }),
    retailInvoice({ items: [line(2000)], billDiscount: { type: "percent", value: 15 }, billedBy: "b" }),
    retailInvoice({ items: [line(500)], billDiscount: { type: "flat", value: 50 }, billedBy: "c" }),
    retailInvoice({ items: [line(750)], billDiscount: null, billedBy: "d" }),
  ];
  assert.equal(shiftDiscountTotal(invoices), 100 + 300 + 50 + 0);
  // The old formula would have reported 90 + 255 + 50 = 395 for the same shift.
  assert.equal(brokenShiftDiscountTotal(invoices), 395);
});

// ===========================================================================
// G. NULL / missing / malformed must contribute 0, never fail.
// ===========================================================================
test("G: NULL, missing and legacy rows contribute 0", () => {
  const cases = [
    { discount_breakdown: null },
    { discount_breakdown: undefined },
    {},
    { discount_breakdown: {} },
    // Legacy Retail row: bill present but no totalSavings. `bill` is an object,
    // so it must NOT be read as a number.
    { discount_breakdown: { line: [], bill: { type: "percent", value: 10 } } },
    // Service row: no totalSavings, `bill` IS the number.
    { discount_breakdown: { bill: 120, taxableAmount: 880 } },
    // Hotel row: both, and they agree.
    { discount_breakdown: { bill: 150, totalSavings: 150 } },
    // Zero is a real zero, not a missing value.
    { discount_breakdown: { line: [], bill: null, totalSavings: 0 } },
  ];
  // `map` hands each element to the callback, so unwrap `.discount_breakdown`
  // rather than passing the wrapper object itself.
  assert.deepEqual(
    cases.map((c) => canonicalDiscount(c.discount_breakdown)),
    [0, 0, 0, 0, 0, 120, 150, 0]
  );
  // And they must not poison a real invoice in the same shift.
  const withGap = [
    { discount_breakdown: null },
    retailInvoice({ items: [line(1000)], billDiscount: { type: "percent", value: 10 } }),
  ];
  assert.equal(shiftDiscountTotal(withGap), 100);
});

// ===========================================================================
// H. The Service vertical, whose shape has no totalSavings.
// ===========================================================================
test("H: a Service bill reports its bill-level amount", () => {
  // ServiceBilling.jsx has no line discounts — only discountPct — so `bill`
  // is the entire discount and must not be reported as 0.
  const serviceInvoice = { sub_total: 880, discount_breakdown: { bill: 120, taxableAmount: 880 } };
  assert.equal(shiftDiscountTotal([serviceInvoice]), 120);
});

// ===========================================================================
// Consistency: the SQL and this model must agree on the resolution order.
// ===========================================================================
test("the SQL resolution order matches this model", () => {
  const { discountAmountSql } = require("./lib/discount-sql");
  const sql = discountAmountSql();
  const ts = sql.indexOf("$.totalSavings");
  const bill = sql.indexOf("$.bill");
  const nullGuard = sql.indexOf("IS NULL THEN 0");
  // Same order as canonicalDiscount(): NULL guard, then totalSavings, then bill.
  assert.ok(nullGuard < ts, "SQL checks NULL first; the model returns 0 first");
  assert.ok(ts < bill, "SQL prefers totalSavings; the model prefers totalSavings");
  // Both numeric paths are type-guarded, which is what stops Retail's object
  // `bill` from being cast to 0 when totalSavings is absent.
  assert.match(sql, /JSON_TYPE\(JSON_EXTRACT\([^)]*'\$\.bill'\)\) IN \('INTEGER', 'DOUBLE', 'DECIMAL'\)/);
});

test("shifts.js consumes the shared expression rather than its own", () => {
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "db/queries/shifts.js"), "utf8");
  assert.match(src, /require\("\.\.\/\.\.\/lib\/discount-sql"\)/);
  assert.match(src, /\$\{discountSumSql\("i\.discount", "i\.discount_breakdown"\)\} AS discount/);
  // The old percent-from-sub_total expression must be gone entirely.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
    .filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/sub_total\s*\*\s*JSON_EXTRACT/.test(code), "percent-of-post-discount-subtotal must be gone");
  assert.ok(!/WHEN 'percent'/.test(code), "the percent branch must be gone");
});
