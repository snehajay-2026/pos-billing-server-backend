// server/lib/publicInvoice.js
//
// Helpers for the unauthenticated `GET /api/public/invoices/:invoiceNo`
// endpoint used by the WhatsApp/Email share link. Two responsibilities:
//
//   1. sanitizePublicInvoice(row) — strip internal scoping fields
//      (`_storeType`, `_storeId`, `_userEmail`), the cashier's identity
//      (`billedBy`), and `items[].meta` so internal notes don't leak.
//
//   2. getPublicStoreChrome(invoice) — fetch the same store settings
//      payload the authenticated `/api/store-settings` endpoint returns,
//      keyed off the invoice's actual `storeType`/`storeId` so the
//      renderers on the public page show the real store name/address/
//      GSTIN/logo instead of the "Ajay Merchant" fallback.

const invoicesQueries = require("../db/queries/invoices");
const storeSettingsQueries = require("../db/queries/store-settings");
const usersQueries = require("../db/queries/users");

// Build the same scope-key shape `getStoreSettingsScopeKey(req)` produces
// on the server (`server/index.js:211`). Centralised here so the public
// endpoint and the authed endpoint agree on key format.
const buildStoreScopeKey = (storeType, storeId) => {
  const keyType = String(storeType || "").trim() || "system";
  const keyId = String(storeId || keyType || "global").trim() || keyType || "global";
  return `store-settings:${keyType}:${keyId}`;
};

// Walk the items[] (BEFORE stripping `meta`) and pull the customer name
// + mobile from the first line that has them. Mirrors the same fallback
// chain `resolveCustomer()` in `db/queries/invoices.js` uses on SAVE —
// so the public response surfaces the same customer identity the
// cashier's POS flow originally attached to the invoice. This is
// especially important for old / partial rows where the dedicated
// `customer_name` / `customer_mobile` columns are NULL but the customer
// info was carried inside the items JSON blob.
function pickCustomerFromItems(items) {
  if (!Array.isArray(items)) return { name: null, mobile: null };
  const clean = (v) => {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
  };
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const meta = it.meta && typeof it.meta === "object" ? it.meta : null;
    if (!meta) continue;
    const name = clean(meta.guest);
    const mobile = clean(meta.customerMobile) || clean(meta.customerPhone);
    if (name || mobile) {
      return { name: name || null, mobile: mobile || null };
    }
  }
  return { name: null, mobile: null };
}

// Recompute the line-item totals from items[] when the dedicated columns
// are NULL. Only fills missing values — never overrides a populated
// column. This is the same total the cashier's POS computes at checkout
// time (line price × qty, plus line gst%), and the per-item `meta` is
// the same single source of truth the cashier's flow saves into the
// items JSON. So a NULL top-level column paired with intact item data
// still surfaces the right totals on the public page.
function pickTotalsFromItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { subTotal: null, gstTotal: null, grandTotal: null };
  }
  const num = (v) => {
    if (v == null || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  let subTotal = 0;
  let gstTotal = 0;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const price = num(it.price);
    let qty = 0;
    if (it.qtyKg != null) qty = num(it.qtyKg);
    else if (it.qty != null) qty = num(it.qty);
    else if (it.quantity != null) qty = num(it.quantity);
    const lineTotal = price * qty;
    const lineGstPct = num(it.gst);
    const lineGst = (lineTotal * lineGstPct) / 100;
    subTotal += lineTotal;
    gstTotal += lineGst;
  }
  // Round to 2dp to match what the cashier's preview displays.
  const r2 = (n) => Math.round(n * 100) / 100;
  subTotal = r2(subTotal);
  gstTotal = r2(gstTotal);
  return { subTotal, gstTotal, grandTotal: r2(subTotal + gstTotal) };
}

// Pull the payment mode + billed-by email the cashier used at checkout
// time out of items[].meta. Mirrors the same shape `createWithStockDecrement`
// accepts on save (the cashier's POS may attach `paymentMode` to the
// first item's meta in some flows), so a NULL `payment_mode` column
// still resolves to the value the customer actually paid via.
function pickPaymentFromItems(items) {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const meta = it.meta && typeof it.meta === "object" ? it.meta : null;
    if (!meta) continue;
    const mode = meta.paymentMode || meta.payment_mode;
    if (mode) return String(mode);
  }
  return null;
}

// Strip internal scoping + per-item internal meta. Keeps `billedBy`
// (the cashier's identifier) so the public receipt can show the same
// "Billed By" line the cashier's preview shows. Keeps `storeType` so
// the frontend renderer switch (retail / hotel / service / laundry /
// msme-service) can pick the right invoice layout.
async function sanitizePublicInvoice(row) {
  // `row` is the camelCased invoice object already returned by
  // `invoicesQueries.findByInvoiceNo()` (which calls `rowToInvoice`
  // internally). Going through `rowToInvoice` a second time here would
  // re-read snake_case columns (`row.customer_name`, `row.billed_by`,
  // …) from an already-camelCased object, which is why the public
  // response was returning `null` for every column the cashier had
  // legitimately populated. Treat `row` as the canonical camelCased
  // invoice and redact straight from it.
  if (!row) return null;
  const {
    _storeType,
    _storeId,
    _userEmail,
    ...rest
  } = row;

  // Promote `_storeType` -> `storeType` so the public renderer can pick
  // the right template without knowing about the underscore-prefixed
  // internal naming. Same for `_storeId` -> `storeId` so the frontend
  // store-settings cache key (`store-settings:<storeType>:<storeId>`)
  // resolves to the same scope the authed cashier preview used.
  if (_storeType && !rest.storeType) rest.storeType = _storeType;
  if (_storeId && !rest.storeId) rest.storeId = _storeId;

  // Fall back to items[].meta for customer name + mobile BEFORE we drop
  // `meta`. This guarantees the public response carries the same customer
  // identity the cashier's Retail POS originally attached — for old rows
  // where the dedicated columns are NULL, or for hotel dining invoices
  // where the cashier saved the guest name on the booking line instead
  // of the top-level column.
  const fromItems = pickCustomerFromItems(rest.items);
  if (!rest.customerName && fromItems.name) rest.customerName = fromItems.name;
  if (!rest.customerMobile && fromItems.mobile) rest.customerMobile = fromItems.mobile;

  // Recompute totals from items[] when the saved columns are NULL. The
  // line-Level price × qty × gst% math is the same one the cashier's
  // preview already runs, and the items JSON is the single source of
  // truth the cashier's POS flow wrote at checkout time. Without this
  // fallback, any row that landed in the DB with NULL totals (partial
  // migration, race, or a save path that missed the columns) shows
  // ₹0.00 on the public view even though the cashier's preview shows
  // the real amount. Only fills missing values — never overrides.
  const fromTotals = pickTotalsFromItems(rest.items);
  if (rest.subTotal == null) rest.subTotal = fromTotals.subTotal;
  if (rest.gstTotal == null) rest.gstTotal = fromTotals.gstTotal;
  if (rest.grandTotal == null) rest.grandTotal = fromTotals.grandTotal;

  // Recover payment mode from items[].meta if the column is NULL. The
  // cashier's older flows at times attached `meta.paymentMode` to the
  // first line; newer flows store it on the column. Cover both.
  const fromPayment = pickPaymentFromItems(rest.items);
  if (!rest.paymentMode && fromPayment) rest.paymentMode = fromPayment;

  // Resolve the cashier's identity to a display name. The DB row's
  // `billed_by` column is the cashier's email (set by
  // POSBilling.jsx: `billingUser.email || billingUser.name`); the
  // authed preview shows it as-is. For the public view we prefer the
  // user's `name` (displayable) and fall back to:
  //   1. the row's `billed_by` if it looks like a name (no `@`),
  //   2. the user table's `name`,
  //   3. the email-prefix (everything before `@`),
  //   4. the existing `billed_by` value (preserves back-compat).
  if (rest.billedBy && typeof rest.billedBy === "string") {
    const raw = rest.billedBy;
    let resolved = raw;
    if (raw.includes("@")) {
      // It's an email — look up the user to get a friendly name.
      const user = await usersQueries.findByEmail(raw);
      if (user && user.name) {
        resolved = user.name;
      } else {
        // Fall back to the local part of the email (avoids exposing the
        // full email to the customer).
        resolved = raw.split("@")[0];
      }
    }
    rest.billedBy = resolved;
  }

  // Strip internal scoping + per-item meta on each
  // cart line. Individual items also carry `_storeType` / `_storeId` /
  // `_userEmail` (they're persisted per-row by the multi-store scoping
  // layer); those must not leak to a customer either.
  if (Array.isArray(rest.items)) {
    rest.items = rest.items.map((it) => {
      if (!it || typeof it !== "object") return it;
      const {
        _storeType: _itStoreType,
        _storeId: _itStoreId,
        _userEmail: _itUserEmail,
        meta,
        ...itemRest
      } = it;
      return itemRest;
    });
  }

  return rest;
}

// Look up the store settings payload by the invoice's actual scope.
// Mirrors `app.get("/api/store-settings", ensureAuth, ...)` so the
// returned object has the same flat key shape (`name`, `address`,
// `phone`, `gstNo`, `logo`, etc.) the thermal renderers read via
// `getStoreSettings()`.
async function getPublicStoreChrome(invoice) {
  if (!invoice) return null;
  const storeType = invoice._storeType || invoice.storeType;
  const storeId = invoice._storeId || invoice.storeId;
  if (!storeType) return null;

  const scopeKey = buildStoreScopeKey(storeType, storeId);
  // Same fallback chain as the authed endpoint: try the requested scope
  // first, then global, then empty (renderer falls back to defaults).
  const payload =
    (await storeSettingsQueries.getPayloadByScopeKey(scopeKey)) ??
    (await storeSettingsQueries.getPayloadByScopeKey("global")) ??
    null;

  return payload && typeof payload === "object" ? payload : null;
}

module.exports = {
  sanitizePublicInvoice,
  getPublicStoreChrome,
};
