// lib/discount-sql.js
//
// The ONE canonical SQL expression for an invoice's monetary discount.
//
// Why this file exists
// --------------------
// `invoices.discount` and `invoices.discount_breakdown` are JSON columns
// (db/schema/001_initial_ddl.sql). Four separate aggregations tried to SUM
// them and all four were wrong in different ways:
//
//   1. reports.js        — `SUM(discount)` summed a JSON OBJECT. Always 0.
//   2. customer-history  — `SUM(discount_breakdown->>'$.bill')` extracts
//                          `$.bill`, which is an OBJECT in Retail, so the
//                          unquoted extraction is not a number. Always 0 for
//                          the main vertical.
//   3. shifts.js         — read `discount->>'$.value'` correctly, but applied
//                          `percent` against `sub_total`, which is stored
//                          POST-discount. A 10% discount reported ~9%.
//   4. dashboard.js      — read `$.totalSavings` correctly, but Service
//                          invoices do not write that key at all, so the
//                          service vertical reported 0.
//
// The shapes actually written by the frontend
// --------------------------------------------
//   Retail  (POSBilling.jsx:1168-1181)
//     discount_breakdown = { line: [{ discount:{type,value}, saved:<num>} ],
//                           bill: {type,value,source} | null,
//                           totalSavings: <num> }
//     `totalSavings = lineDiscountTotal + billDiscountAmount` — the complete
//     monetary saving, already line + bill, computed pre-discount.
//
//   Hotel   (HotelBilling.jsx:3759-3766)
//     discount_breakdown = { bill: <num>, totalSavings: <num>, ... }
//     `totalSavings = discountAmount` — bill only; hotel has no line discounts.
//
//   Service (ServiceBilling.jsx:515-518)
//     discount_breakdown = { bill: <num>, taxableAmount: <num> }
//     NO totalSavings, and NO line discounts — the service flow only has a
//     bill-level `discountPct`, so `bill` IS the whole discount.
//
//   Laundry — no discount is offered, so no breakdown is written.
//
// The resolution order below therefore is, per invoice:
//
//   1. `$.totalSavings` when it is a number  → Retail and Hotel, already the
//      complete line+bill figure. Nothing is added to it, so there is no way
//      to double-count.
//   2. otherwise `$.bill` when it is a NUMBER → Service. Retail's `bill` is
//      an object and is rejected by the JSON_TYPE guard, so a Retail invoice
//      that somehow lost `totalSavings` degrades to 0 rather than to a
//      half-counted figure.
//   3. otherwise 0                          → NULL, empty, malformed, or a
//      legacy row predating the breakdown column.
//
// Deliberately NOT reconstructed from `discount.value`:
// `sub_total` is stored post-discount, so `percent` cannot be re-derived from
// it without the pre-discount base, which is not in the row. Recomputing
// would be a second, disagreeing definition of discount — exactly what the
// original `shifts.js` bug was. The stored breakdown is the value the POS
// already showed the customer on the receipt, so reports now agree with the
// paper.
//
// Compatibility
// -------------
// `JSON_EXTRACT` / `JSON_TYPE` / `JSON_UNQUOTE` are MySQL 5.7+ and TiDB,
// which is what the project targets (mysql2 driver, TiDB Cloud in prod).
// No PostgreSQL-only syntax. `JSON_TYPE` is the guard that keeps a JSON
// scalar, array, or absent key from being CAST to 0 silently — it is the
// same idiom shifts.js already used.

/**
 * The per-row monetary discount, as a SQL expression.
 *
 * Defaults are UNQUALIFIED so a caller whose query has no table alias (e.g.
 * reports.js, which selects `FROM invoices` with no `i.`) gets valid SQL.
 * Callers that alias the table pass "i.discount" / "i.discount_breakdown".
 *
 * @param {string} [col] column reference, optionally table-qualified
 * @param {string} [breakdownCol] the discount_breakdown column reference
 * @returns {string} SQL expression evaluating to a DECIMAL-compatible value
 */
const discountAmountSql = (col = "discount", breakdownCol = "discount_breakdown") => `
  CASE
    WHEN ${breakdownCol} IS NULL THEN 0
    WHEN JSON_TYPE(JSON_EXTRACT(${breakdownCol}, '$.totalSavings')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
      THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${breakdownCol}, '$.totalSavings')) AS DECIMAL(12,2))
    WHEN JSON_TYPE(JSON_EXTRACT(${breakdownCol}, '$.bill')) IN ('INTEGER', 'DOUBLE', 'DECIMAL')
      THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(${breakdownCol}, '$.bill')) AS DECIMAL(12,2))
    ELSE 0
  END`;

/**
 * Aggregate form: `COALESCE(SUM(<expr>), 0)`.
 *
 * The outer COALESCE matters. A period with no invoice rows makes SUM()
 * return NULL, and a report that prints "₹NaN" or a blank where a zero
 * belongs is worse than a zero. (The inner per-row CASE already yields 0 for
 * every row, so this only fires on the empty-table path.)
 */
const discountSumSql = (col = "discount", breakdownCol = "discount_breakdown") =>
  `COALESCE(SUM(${discountAmountSql(col, breakdownCol)}), 0)`;

module.exports = {
  discountAmountSql,
  discountSumSql,
};
