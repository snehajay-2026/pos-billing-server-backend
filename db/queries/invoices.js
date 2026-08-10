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

const COLUMNS =
  "id, invoice_no, date, items, sub_total, gst_total, grand_total, discount, discount_breakdown, payment_mode, billed_by, customer_name, customer_mobile, _store_type, _store_id, _user_email, created_at, updated_at";

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
    customerName: row.customer_name || null,
    customerMobile: row.customer_mobile || null,
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

// Resolve the customer name / mobile to persist on the invoices row.
// Clients send them at the top level (customerName) or nested under
// hotelDetails.customerMobile (hotel dining); older booking line items also
// carry them on each item's meta.guest / meta.customerMobile. First non-empty
// value wins, so every store type populates the columns and re-printed saved
// invoices can read the name back from the row instead of the JSON blob.
const resolveCustomer = (invoice = {}) => {
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const first =
    items.find((it) => it && it.meta && (it.meta.guest || it.meta.customerMobile)) ||
    items[0] ||
    null;
  const clean = (v) => (v == null ? "" : String(v).trim());
  return {
    customerName: clean(invoice.customerName) || clean(first?.meta?.guest) || null,
    customerMobile:
      clean(invoice.customerMobile) ||
      clean(invoice.hotelDetails?.customerMobile) ||
      clean(first?.meta?.customerMobile) ||
      null,
  };
};

const findByInvoiceNo = async (invoiceNo) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM invoices WHERE invoice_no = ? LIMIT 1`,
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
const createWithStockDecrement = async (invoice, resolveQty, scope) => {
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

  return withTransaction(async (conn) => {
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
    await conn.query(
      `INSERT INTO invoices
         (id, invoice_no, date, items, sub_total, gst_total, grand_total,
          discount, discount_breakdown, payment_mode, billed_by,
          customer_name, customer_mobile,
          _store_type, _store_id, _user_email, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [
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
      ]
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
    `SELECT ${COLUMNS} FROM invoices ${where} ORDER BY created_at DESC, id DESC`,
    params
  );
  return rows[0].map(rowToInvoice);
};

// create: insert a new invoice WITHOUT touching products. Used by
// /api/:resource POST. The atomic decrement lives in
// createWithStockDecrement above (used by /api/invoices/checkout).
const create = async (item, scope) => {
  const id = Date.now();
  const { customerName, customerMobile } = resolveCustomer(item);
  await query(
    `INSERT INTO invoices
       (id, invoice_no, date, items, sub_total, gst_total, grand_total,
        discount, discount_breakdown, payment_mode, billed_by,
        customer_name, customer_mobile,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
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
    ]
  );
  return findByInvoiceNo(item.invoiceNo || item.invoice_no);
};

const findByIdScoped = async (id, scope) => {
  const conds = [];
  const params = [id];
  if (scope.storeType) { conds.push("_store_type = ?"); params.push(scope.storeType); }
  if (scope.storeId)   { conds.push("_store_id = ?");   params.push(scope.storeId); }
  if (scope.email)     { conds.push("_user_email = ?"); params.push(scope.email); }
  const where = conds.length ? "AND " + conds.join(" AND ") : "";
  const rows = await query(
    `SELECT ${COLUMNS} FROM invoices WHERE id = ? ${where} LIMIT 1`,
    params
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToInvoice(rows[0][0]);
};

const update = async (id, patch) => {
  const allowed = [
    "invoice_no", "date", "items", "sub_total", "gst_total", "grand_total",
    "discount", "discount_breakdown", "payment_mode", "billed_by",
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
};