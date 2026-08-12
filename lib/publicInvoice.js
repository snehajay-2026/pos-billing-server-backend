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

// Strip internal scoping + cashier identity + per-item internal meta.
// Keeps `storeType` so the frontend renderer switch (retail / hotel /
// service / laundry / msme-service) can pick the right invoice layout.
function sanitizePublicInvoice(row) {
  // Reuse the same camelCased mapping the authed endpoint returns so
  // the public response shape mirrors the authed one (minus the redacted
  // fields).
  const full = invoicesQueries.rowToInvoice(row);
  if (!full) return null;
  const {
    _storeType,
    _storeId,
    _userEmail,
    billedBy,
    ...rest
  } = full;

  // Promote `_storeType` -> `storeType` so the public renderer can pick
  // the right template without knowing about the underscore-prefixed
  // internal naming.
  if (_storeType && !rest.storeType) rest.storeType = _storeType;

  // Fall back to items[].meta for customer name + mobile BEFORE we drop
  // `meta`. This guarantees the public response carries the same customer
  // identity the cashier's Retail POS originally attached — for old rows
  // where the dedicated columns are NULL, or for hotel dining invoices
  // where the cashier saved the guest name on the booking line instead
  // of the top-level column.
  const fromItems = pickCustomerFromItems(rest.items);
  if (!rest.customerName && fromItems.name) rest.customerName = fromItems.name;
  if (!rest.customerMobile && fromItems.mobile) rest.customerMobile = fromItems.mobile;

  // Strip internal scoping + cashier identity + per-item meta on each
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
