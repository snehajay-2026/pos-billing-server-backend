// server/db/queries/invoices.js
//
// All SQL touching the `invoices` table lives here.
//
// Two important notes:
//   - `items`, `discount`, and `discountBreakdown` are JSON columns.
//     mysql2 serializes JS arrays/objects to JSON for us; we read them
//     back as parsed JSON.
//   - createWithStockDecrement() is the atomic checkout primitive. It
//     runs inside withTransaction(), takes SELECT ... FOR UPDATE row
//     locks on every product in the cart, validates stock, decrements,
//     inserts the invoice, and returns the saved row + updated stock.
//     On any failure (insufficient stock, FK violation, etc.) the
//     transaction rolls back and no partial state is committed.

const { query, withTransaction } = require("../pool");

// `invoices.generated_at` is added in migration `009_invoice_generated_at.sql`
// to persist the cashier-perceived moment of clicking Generate Invoice. We
// can't assume the column exists when this module first boots — a freshly
// deployed build running against a pre-migration DB would crash every
// INSERT with `Unknown column 'generated_at' in 'field list'`. Probe the
// schema once at module load and flip this flag so the INSERT/SELECT
// builders below can branch without paying the probe cost on every save.
//
// We swallow the error: a missing column is the expected pre-migration
// state, and any *other* schema error will surface on the very next query.
let hasGeneratedAtColumn = false;
(async () => {
  try {
    const [rows] = await query(
      `SELECT COUNT(*) AS n
         FROM information_schema.columns
         WHERE table_schema = DATABASE()
           AND table_name = 'invoices'
           AND column_name = 'generated_at'`
    );
    hasGeneratedAtColumn = Number((rows && rows[0] && rows[0].n) || 0) > 0;
  } catch (e) {
    hasGeneratedAtColumn = false;
  }
})();

// Single source of truth for the SELECT column list. Includes the
// optional `generated_at` column when the migration has been applied;
// falls back to the pre-migration column set otherwise so a backend
// running against an un-migrated DB doesn't 500 every invoice fetch.
// Implemented as a getter so the value reflects the post-probe flag
// (the probe is async and resolves after this module finishes
// evaluating — so a `const` snapshot taken at module-load time would
// permanently pin `hasGeneratedAtColumn = false`).
const COLUMNS_NO_GEN =
  "id, invoice_no, date, items, sub_total, gst_total, grand_total, discount, discount_breakdown, payment_mode, billed_by, status, customer_name, customer_mobile, _store_type, _store_id, _user_email, created_at, updated_at";
const COLUMNS_WITH_GEN =
  "id, invoice_no, date, items, sub_total, gst_total, grand_total, discount, discount_breakdown, payment_mode, billed_by, status, customer_name, customer_mobile, _store_type, _store_id, _user_email, created_at, generated_at, updated_at";
const COLUMNS = {
  get withGen() {
    return hasGeneratedAtColumn ? COLUMNS_WITH_GEN : COLUMNS_NO_GEN;
  },
};

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Convert an ISO-ish datetime string from the cashier's frontend
// (e.g. "2026-08-17T15:27:45.123Z") to MySQL DATETIME(3) format
// ("2026-08-17 15:27:45.123"). Falls back to NOW(3) via the SQL COALESCE
// when the input is missing or unparseable. The cashier's local-clock
// ISO string is preserved as-is — we do NOT shift timezones here,
// because the renderer's `timeZone: "Asia/Kolkata"` formatter is the
// single source of truth for IST display.
const toMysqlDatetime = (v) => {
  if (v == null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.` +
    `${pad(d.getUTCMilliseconds(), 3)}`
  );
};

const rowToInvoice = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    invoiceNo: row.invoice_no,
    date: row.date,
    items: row.items || [],
    subTotal: toNumber(row.sub_total),
    gstTotal: toNumber(row.gst_total),
    grandTotal: toNumber(row.grand_total),
    discount: row.discount || null,
    discountBreakdown: row.discount_breakdown || null,
    paymentMode: row.payment_mode || null,
    billedBy: row.billed_by || null,
    status: row.status || null,
    customerName: row.customer_name || null,
    customerMobile: row.customer_mobile || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    generatedAt: row.generated_at || null,
    updatedAt: row.updated_at || null,
  };
};

// Resolve the customer name / mobile to persist on the invoices row.
// Clients send them at the top level (customerName / customerPhone) or
// nested under hotelDetails.guestName / hotelDetails.customerMobile (hotel
// dining); older booking line items also carry them on each item's
// meta.guest / meta.customerMobile. The Laundry Store sends them as
// `customer` / `phone` (the field names the Laundry Billing UI uses for
// its own customer-input row). First non-empty value wins, so every
// store type populates the columns and re-printed saved invoices can
// read the name back from the row instead of the JSON blob.
//
// NOTE: the Retail POS Billing UI sends the phone as `customerPhone`,
// not `customerMobile`. The previous implementation only checked
// `invoice.customerMobile`, so retail invoices saved with a typed phone
// number lost the field — the rendered invoice always showed an empty
// Mobile line. We accept both spellings now (and prefer the existing
// `customerMobile` first, so any legacy callers keep their shape).
const resolveCustomer = (invoice = {}) => {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const first =
    items.find((it) => it && it.meta && (it.meta.guest || it.meta.customerMobile || it.meta.customerPhone)) ||
    items[0] ||
    null;
  const clean = (v) => (v == null ? "" : String(v).trim());
  return {
    customerName:
      clean(invoice.customerName) ||
      // Laundry Store sends its customer input as the top-level `customer`
      // field (the field name LaundryBilling.jsx uses in its bill-meta
      // row). Without this, Laundry invoices saved with a typed name
      // landed in the DB with customer_name=NULL and the cashier's name
      // never appeared on either the Invoice Preview or the Public
      // Invoice share link.
      clean(invoice.customer) ||
      clean(invoice.hotelDetails?.guestName) ||
      clean(first?.meta?.guest) ||
      clean(first?.meta?.customerName) ||
      null,
    customerMobile:
      clean(invoice.customerMobile) ||
      clean(invoice.customerPhone) ||
      // Laundry Store sends its phone input as the top-level `phone` field
      // (paired with `customer` above). Symmetric to the customerName
      // fallback so the column mirrors what the cashier typed.
      clean(invoice.phone) ||
      clean(invoice.hotelDetails?.customerMobile) ||
      clean(invoice.hotelDetails?.customerPhone) ||
      clean(first?.meta?.customerMobile) ||
      clean(first?.meta?.customerPhone) ||
      null,
  };
};

const findByInvoiceNo = async (invoiceNo) => {
  const rows = await query(
    `SELECT ${COLUMNS.withGen} FROM invoices WHERE invoice_no = ? LIMIT 1`,
    [String(invoiceNo)]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToInvoice(rows[0][0]);
};

// createWithStockDecrement: the atomic checkout. fn(conn) is given a
// single connection inside withTransaction(); throws if anything goes
// wrong so the whole txn rolls back.
//
// Inputs:
//   invoice — the full invoice body from req.body (already validated by
//             the route handler for shape: items, invoiceNo, discounts).
//   resolveQty(item) — converts an item to a numeric quantity, mirroring
//                      the existing JSON behavior (kg items use qtyKg).
//   scope — { storeType, storeId, email } from getRequestScope(req).
//
// Returns: { invoice, updatedStock } matching the JSON path's response
// shape so the route handler can return it verbatim.
const createWithStockDecrement = async (invoice, resolveQty, scope, conn) => {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  if (items.length === 0) {
    const err = new Error("Invoice has no line items");
    err.status = 400;
    throw err;
  }
  if (!invoice.invoiceNo) {
    const err = new Error("invoiceNo is required");
    err.status = 400;
    throw err;
  }

  const id = Date.now();
  const updatedStock = [];
  const { customerName, customerMobile } = resolveCustomer(invoice);

  // If the caller already opened a transaction (e.g. /api/invoices/checkout
  // wraps stock decrement + invoice INSERT + coupon usage-count bump
  // together), reuse the connection instead of starting a nested
  // transaction (MySQL would error with "There is already an active
  // transaction"). Otherwise open our own transaction the legacy way.
  const runInTransaction = async (fn) =>
    conn ? fn(conn) : withTransaction(fn);

  return runInTransaction(async (conn) => {
    // 1. Lock + validate every line item.
    for (const item of items) {
      const [rows] = await conn.query(
        "SELECT id, name, stock FROM products WHERE id = ? FOR UPDATE",
        [item.id]
      );
      if (rows.length === 0) {
        const err = new Error("Product not found");
        err.status = 404;
        err.productId = item.id;
        err.productName = item.name;
        throw err;
      }
      const product = rows[0];
      const requested = Number(resolveQty(item)) || 0;
      if (requested <= 0) {
        const err = new Error("Invalid quantity");
        err.status = 400;
        err.productId = item.id;
        err.productName = product.name;
        err.requested = requested;
        throw err;
      }
      const available = Number(product.stock) || 0;
      if (available < requested) {
        const err = new Error("Insufficient stock");
        err.status = 409;
        err.productId = item.id;
        err.productName = product.name;
        err.available = available;
        err.requested = requested;
        throw err;
      }
      const nextStock = +(available - requested).toFixed(3);
      await conn.query(
        "UPDATE products SET stock = ?, updated_at = NOW(3) WHERE id = ?",
        [nextStock, item.id]
      );
      updatedStock.push({ id: product.id, name: product.name, stock: nextStock });
    }

    // 2. Insert the invoice. MySQL JSON columns accept objects directly.
    //    `generated_at` is the cashier-perceived moment of clicking
    //    Generate Invoice (sent by the cashier's frontend as
    //    `invoice.generatedAt`, an ISO timestamp taken from a live
    //    `new Date()` at click time). When the cashier didn't send
    //    `generatedAt` — older POS flows, or non-frontend callers — we
    //    fall back to NOW(3) so the column is never NULL on a fresh
    //    insert while still preferring the live cashier moment when
    //    present.
    const generatedAtSql = invoice.generatedAt ? toMysqlDatetime(invoice.generatedAt) : null;
    // Build the INSERT shape dynamically so the `generated_at` column
    // is only referenced when the migration has run. The probe at
    // module-load sets `hasGeneratedAtColumn`; by the time the first
    // invoice save request lands, the flag has settled, so this branch
    // picks the right shape for every save after that.
    const insertBaseCols =
      "id, invoice_no, date, items, sub_total, gst_total, grand_total, discount, discount_breakdown, payment_mode, billed_by, customer_name, customer_mobile, _store_type, _store_id, _user_email, created_at";
    const insertBaseVals = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3)";
    const insertCols = hasGeneratedAtColumn
      ? `${insertBaseCols}, generated_at, updated_at`
      : `${insertBaseCols}, updated_at`;
    const insertVals = hasGeneratedAtColumn
      ? `${insertBaseVals}, COALESCE(?, NOW(3)), NOW(3)`
      : `${insertBaseVals}, NOW(3)`;
    const insertParams = [
      id,
      invoice.invoiceNo,
      invoice.date || null,
      JSON.stringify(items),
      toNumber(invoice.subTotal ?? invoice.sub_total) ?? 0,
      toNumber(invoice.gstTotal ?? invoice.gst_total) ?? 0,
      toNumber(invoice.grandTotal ?? invoice.grand_total) ?? 0,
      invoice.discount ? JSON.stringify(invoice.discount) : null,
      invoice.discountBreakdown ? JSON.stringify(invoice.discountBreakdown) : null,
      invoice.paymentMode || invoice.payment_mode || null,
      invoice.billedBy || invoice.billed_by || null,
      customerName,
      customerMobile,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ];
    if (hasGeneratedAtColumn) insertParams.push(generatedAtSql);
    await conn.query(
      `INSERT INTO invoices (${insertCols}) VALUES (${insertVals})`,
      insertParams
    );

    return { id, updatedStock };
  }).then(async () => {
    // After commit, re-read the invoice so the caller gets the full row
    // including server-generated timestamps.
    const saved = await findByInvoiceNo(invoice.invoiceNo);
    return { invoice: saved, updatedStock };
  });
};

const list = async (scope) => {
  const conds = [];
  const params = [];
  if (scope.storeType) { conds.push("_store_type = ?"); params.push(scope.storeType); }
  if (scope.storeId)   { conds.push("_store_id = ?");   params.push(scope.storeId); }
  if (scope.email)     { conds.push("_user_email = ?"); params.push(scope.email); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const rows = await query(
    `SELECT ${COLUMNS.withGen} FROM invoices ${where} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows[0].map(rowToInvoice);
};

// create: insert a new invoice WITHOUT touching products. Used by
// /api/:resource POST. The atomic decrement lives in
// createWithStockDecrement above (used by /api/invoices/checkout).
//
// `conn` is optional: when passed, the INSERT runs on the supplied
// transaction connection so it can join withTransaction() blocks
// (e.g. atomic coupon usage-count bump). When omitted, the call uses
// the shared pool and behaves exactly as before.
const create = async (item, scope, conn) => {
  const id = Date.now();
  const { customerName, customerMobile } = resolveCustomer(item);
  const generatedAtSql = item.generatedAt ? toMysqlDatetime(item.generatedAt) : null;
  // Same dynamic INSERT shape as `createWithStockDecrement` — the
  // `generated_at` column is only referenced when the
  // `009_invoice_generated_at.sql` migration has run.
  const insertBaseCols =
    "id, invoice_no, date, items, sub_total, gst_total, grand_total, discount, discount_breakdown, payment_mode, billed_by, customer_name, customer_mobile, _store_type, _store_id, _user_email, created_at";
  const insertBaseVals = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3)";
  const insertCols = hasGeneratedAtColumn
    ? `${insertBaseCols}, generated_at, updated_at`
    : `${insertBaseCols}, updated_at`;
  const insertVals = hasGeneratedAtColumn
    ? `${insertBaseVals}, COALESCE(?, NOW(3)), NOW(3)`
    : `${insertBaseVals}, NOW(3)`;
  const insertParams = [
    id,
    item.invoiceNo || item.invoice_no || null,
    item.date || null,
    item.items ? JSON.stringify(item.items) : null,
    toNumber(item.subTotal ?? item.sub_total) ?? 0,
    toNumber(item.gstTotal ?? item.gst_total) ?? 0,
    toNumber(item.grandTotal ?? item.grand_total) ?? 0,
    item.discount ? JSON.stringify(item.discount) : null,
    item.discountBreakdown ? JSON.stringify(item.discountBreakdown) : null,
    item.paymentMode || item.payment_mode || null,
    item.billedBy || item.billed_by || null,
    customerName,
    customerMobile,
    scope.storeType || null,
    scope.storeId || null,
    scope.email || null,
  ];
  if (hasGeneratedAtColumn) insertParams.push(generatedAtSql);
  const exec = conn
    ? (sql, params) => conn.query(sql, params)
    : query;
  await exec(
    `INSERT INTO invoices (${insertCols}) VALUES (${insertVals})`,
    insertParams
  );
  // Read back via the same connection so the caller sees the just-
  // inserted row even when the transaction hasn't COMMITted yet.
  const readExec = conn
    ? (sql, params) => conn.query(sql, params)
    : query;
  const [rows] = await readExec(
    `SELECT ${COLUMNS.withGen} FROM invoices WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows || rows.length === 0) {
    return findByInvoiceNo(item.invoiceNo || item.invoice_no);
  }
  return rowToInvoice(rows[0]);
};

const findByIdScoped = async (id, scope) => {
  const conds = [];
  const params = [id];
  if (scope.storeType) { conds.push("_store_type = ?"); params.push(scope.storeType); }
  if (scope.storeId)   { conds.push("_store_id = ?");   params.push(scope.storeId); }
  if (scope.email)     { conds.push("_user_email = ?"); params.push(scope.email); }
  const where = conds.length ? "AND " + conds.join(" AND ") : "";
  const rows = await query(
    `SELECT ${COLUMNS.withGen} FROM invoices WHERE id = ? ${where} LIMIT 1`,
    params
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToInvoice(rows[0][0]);
};

const update = async (id, patch) => {
  const allowed = [
    "invoice_no", "date", "items", "sub_total", "gst_total", "grand_total",
    "discount", "discount_breakdown", "payment_mode", "billed_by", "status",
    "customer_name", "customer_mobile",
  ];
  const camelToSnake = {
    invoiceNo: "invoice_no", subTotal: "sub_total", gstTotal: "gst_total",
    grandTotal: "grand_total", discountBreakdown: "discount_breakdown",
    paymentMode: "payment_mode", billedBy: "billed_by",
    customerName: "customer_name", customerMobile: "customer_mobile",
  };
  const sets = [];
  const params = [];
  for (const k of allowed) {
    const camel = Object.keys(camelToSnake).find((c) => camelToSnake[c] === k) || k;
    if (!Object.prototype.hasOwnProperty.call(patch, camel)) continue;
    let v = patch[camel];
    if (["sub_total", "gst_total", "grand_total"].includes(k)) v = toNumber(v);
    if (["items", "discount", "discount_breakdown"].includes(k)) v = v ? JSON.stringify(v) : null;
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE invoices SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findByIdScoped(id, { storeType: null, storeId: null, email: null })
      .then((inv) => inv || { id });
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE invoices SET ${sets.join(", ")} WHERE id = ?`, params);
  return findByIdScoped(id, { storeType: null, storeId: null, email: null });
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM invoices WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = {
  findByInvoiceNo,
  createWithStockDecrement,
  list,
  create,
  findByIdScoped,
  update,
  deleteById,
  rowToInvoice,
};