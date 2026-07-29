// server/scripts/load-json-to-mysql.js
//
// One-shot data migration: reads every server/data/*.json file and
// bulk-inserts each row into the matching MySQL table.
//
// Run with: `node server/scripts/load-json-to-mysql.js`
//
// IMPORTANT: this is a destructive operation. After a successful run,
// the loader moves the JSON files into server/data/archive-<date>/ so
// they can't be loaded twice. Re-run with `--no-archive` to leave the
// JSONs in place (useful for dry-runs).
//
// Concurrency: the script uses INSERT IGNORE for every row, so re-running
// against a populated database is safe. Per-row errors are logged and
// skipped, not fatal.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs").promises;
const path = require("path");
const { query, closePool } = require("../db/pool");

const DATA_DIR = path.join(__dirname, "..", "data");
const ARCHIVE = process.argv.includes("--no-archive")
  ? null
  : path.join(DATA_DIR, `archive-${new Date().toISOString().slice(0, 10)}`);

const args = process.argv.slice(2);
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7)?.split(",");
const DRY_RUN = args.includes("--dry-run");

// Track results per table.
const results = {};
const record = (table, attempted, ok, failed) => {
  results[table] = { attempted, ok, failed };
};

const loadJson = async (filename) => {
  const filePath = path.join(DATA_DIR, filename);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
};

// --- Per-table loaders -------------------------------------------------------
// Each loader takes the parsed JSON array and inserts rows into MySQL.
// Returns { attempted, ok, failed }.

const loadUsers = async () => {
  const rows = await loadJson("users.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    // Skip rows without a usable id (would clash with autoincrement elsewhere)
    if (!r.id || !r.email) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO users
          (id, email, password, role, store_type, store_id, owner_email, root_owner_email,
           approved, status, name, phone, address, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          String(r.email).toLowerCase(),
          r.password || "",
          r.role || "CASHIER",
          r.storeType || r.store_type || null,
          r.storeId || r.store_id || null,
          r.ownerEmail || r.owner_email || null,
          r.rootOwnerEmail || r.root_owner_email || null,
          r.approved ? 1 : 0,
          r.status || (r.approved ? "approved" : "pending"),
          r.name || null,
          r.phone || null,
          r.address || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  users[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("users", rows.length, ok, failed);
};

const loadProducts = async () => {
  const rows = await loadJson("products.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id || !r.name) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO products
          (id, name, price, gst, stock, barcode, category, unit,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          r.name,
          Number(r.price) || 0,
          Number(r.gst) || 0,
          Number(r.stock) || 0,
          r.barcode || null,
          r.category || null,
          r.unit === "kg" ? "kg" : "unit",
          r._storeType || r._storeType === "" ? r._storeType : null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  products[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("products", rows.length, ok, failed);
};

const loadServices = async () => {
  const rows = await loadJson("services.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO services
          (id, name, description, rate, hours, gst, category,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          r.name || "",
          r.description || null,
          Number(r.rate) || 0,
          r.hours == null ? null : Number(r.hours),
          Number(r.gst) || 0,
          r.category || null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  services[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("services", rows.length, ok, failed);
};

const loadExpenses = async () => {
  const rows = await loadJson("expenses.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO expenses
          (id, amount, category, description, date,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          Number(r.amount) || 0,
          r.category || null,
          r.description || null,
          r.date || null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  expenses[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("expenses", rows.length, ok, failed);
};

const loadOrders = async () => {
  const rows = await loadJson("orders.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO orders
          (id, customer, phone, service, items, qty, qty_kg, status, type, token, invoice_no,
           subtotal, gst_total, express_surcharge, total, express, expected_return, notes,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          r.customer || null,
          r.phone || null,
          r.service || null,
          r.items ? JSON.stringify(r.items) : null,
          r.qty == null ? null : Number(r.qty),
          r.qtyKg != null ? Number(r.qtyKg) : r.qty_kg != null ? Number(r.qty_kg) : null,
          r.status || "pending",
          r.type || null,
          r.token || null,
          r.invoiceNo || r.invoice_no || null,
          r.subtotal == null ? null : Number(r.subtotal),
          r.gstTotal != null ? Number(r.gstTotal) : r.gst_total != null ? Number(r.gst_total) : null,
          r.expressSurcharge != null
            ? Number(r.expressSurcharge)
            : r.express_surcharge != null
            ? Number(r.express_surcharge)
            : null,
          r.total == null ? null : Number(r.total),
          r.express ? 1 : 0,
          r.expectedReturn || r.expected_return || null,
          r.notes || null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  orders[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("orders", rows.length, ok, failed);
};

const loadInvoices = async () => {
  const rows = await loadJson("invoices.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id || !r.invoiceNo) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO invoices
          (id, invoice_no, date, items, sub_total, gst_total, grand_total,
           discount, discount_breakdown, payment_mode, billed_by,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          String(r.invoiceNo),
          r.date || null,
          r.items ? JSON.stringify(r.items) : null,
          r.subTotal != null ? Number(r.subTotal) : r.sub_total != null ? Number(r.sub_total) : null,
          r.gstTotal != null ? Number(r.gstTotal) : r.gst_total != null ? Number(r.gst_total) : null,
          r.grandTotal != null
            ? Number(r.grandTotal)
            : r.grand_total != null
            ? Number(r.grand_total)
            : null,
          r.discount ? JSON.stringify(r.discount) : null,
          r.discountBreakdown
            ? JSON.stringify(r.discountBreakdown)
            : r.discount_breakdown
            ? JSON.stringify(r.discount_breakdown)
            : null,
          r.paymentMode || r.payment_mode || null,
          r.billedBy || r.billed_by || null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  invoices[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("invoices", rows.length, ok, failed);
};

const loadCustomers = async () => {
  const rows = await loadJson("customers.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO customers
          (id, name, phone, email, address, notes,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          r.name || null,
          r.phone || null,
          r.email || null,
          r.address || null,
          r.notes || null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  customers[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("customers", rows.length, ok, failed);
};

const loadCustomerCredits = async () => {
  const rows = await loadJson("customerCredits.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO customer_credits
          (id, customer_phone, customer_name, amount, description, date,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          r.customerPhone || r.customer_phone || null,
          r.customerName || r.customer_name || null,
          r.amount != null ? Number(r.amount) : 0,
          r.description || null,
          r.date || null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  customer_credits[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("customer_credits", rows.length, ok, failed);
};

const loadNotifications = async () => {
  const rows = await loadJson("notifications.json");
  let ok = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.id) { failed++; continue; }
    try {
      await query(
        `INSERT IGNORE INTO notifications
          (id, read_flag, email, type, message, payload,
           _store_type, _store_id, _user_email, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          Number(r.id),
          r.read ? 1 : 0,
          r.email || null,
          r.type || null,
          r.message || null,
          r.payload ? JSON.stringify(r.payload) : null,
          r._storeType || null,
          r._storeId || null,
          r._userEmail || null,
          r.createdAt ? new Date(r.createdAt) : null,
          r.updatedAt ? new Date(r.updatedAt) : null,
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  notifications[${r.id}] failed: ${err.message}`);
      failed++;
    }
  }
  record("notifications", rows.length, ok, failed);
};

// storeSettings: handles three layouts from the JSON file.
//   1. Flat object: { gst: 18, currency: "INR" } -> single scope 'global' row
//   2. { global: {...} } -> same as a flat object, scope 'global'
//   3. { "store-settings:type:id": {...}, ... } -> one row per scope key
const loadStoreSettings = async () => {
  const filePath = path.join(DATA_DIR, "storeSettings.json");
  let data;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    data = JSON.parse(raw || "{}");
  } catch (err) {
    if (err.code === "ENOENT") {
      record("store_settings", 0, 0, 0);
      return;
    }
    throw err;
  }
  let ok = 0;
  let failed = 0;
  let attempted = 0;
  const entries = [];

  if (data && typeof data === "object" && !Array.isArray(data)) {
    const keys = Object.keys(data);
    const isScoped = keys.some((k) => k.startsWith("store-settings:"));
    if (isScoped) {
      // Layout 3: multi-scope
      for (const key of keys) {
        entries.push({ scopeKey: key, scopeType: "store", payload: data[key] });
      }
    } else if (keys.length === 1 && keys[0] === "global") {
      // Layout 2: { global: {...} }
      entries.push({ scopeKey: "global", scopeType: "global", payload: data.global });
    } else {
      // Layout 1: flat object
      entries.push({ scopeKey: "global", scopeType: "global", payload: data });
    }
  }

  for (const e of entries) {
    attempted++;
    try {
      await query(
        `INSERT IGNORE INTO store_settings
          (scope_key, scope_type, store_type, store_id, payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3))`,
        [e.scopeKey, e.scopeType, e.storeType || null, e.storeId || null, JSON.stringify(e.payload || {})]
      );
      ok++;
    } catch (err) {
      console.error(`  store_settings[${e.scopeKey}] failed: ${err.message}`);
      failed++;
    }
  }
  record("store_settings", attempted, ok, failed);
};

// hotel: single row, six JSON columns.
const loadHotel = async () => {
  const rows = await loadJson("hotel.json");
  let ok = 0;
  let failed = 0;
  let attempted = 0;
  if (rows.length > 0) {
    // The JSON file is an array; the loader treats it as a single
    // hotel state object (the first element).
    const state = rows[0] || {};
    attempted = 1;
    try {
      await query(
        `UPDATE hotel_state
         SET tables = ?, waiting = ?, dining_waiting = ?, lodging_waiting = ?,
             checkout_history = ?, dining_bills = ?, updated_at = NOW(3)
         WHERE id = 1`,
        [
          JSON.stringify(state.tables || []),
          JSON.stringify(state.waiting || []),
          JSON.stringify(state.diningWaiting || []),
          JSON.stringify(state.lodgingWaiting || []),
          JSON.stringify(state.checkoutHistory || []),
          JSON.stringify(state.diningBills || []),
        ]
      );
      ok++;
    } catch (err) {
      console.error(`  hotel_state failed: ${err.message}`);
      failed++;
    }
  }
  record("hotel_state", attempted, ok, failed);
};

// --- Run ---------------------------------------------------------------------

const LOADERS = {
  users: loadUsers,
  products: loadProducts,
  services: loadServices,
  expenses: loadExpenses,
  orders: loadOrders,
  invoices: loadInvoices,
  customers: loadCustomers,
  customer_credits: loadCustomerCredits,
  notifications: loadNotifications,
  store_settings: loadStoreSettings,
  hotel_state: loadHotel,
};

const main = async () => {
  console.log("=== JSON → MySQL loader ===");
  console.log(`Source: ${DATA_DIR}`);
  console.log(`Archive: ${ARCHIVE || "(none — --no-archive)"}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN" : "WRITE"}`);
  if (ONLY) console.log(`Only: ${ONLY.join(", ")}`);
  console.log();

  for (const [table, loader] of Object.entries(LOADERS)) {
    if (ONLY && !ONLY.includes(table)) continue;
    console.log(`Loading ${table}...`);
    await loader();
    const r = results[table];
    if (r) {
      console.log(`  ${table}: ${r.ok}/${r.attempted} loaded${r.failed ? `, ${r.failed} failed` : ""}`);
    }
  }

  console.log("\n=== Summary ===");
  for (const [table, r] of Object.entries(results)) {
    console.log(`  ${table.padEnd(20)} ${r.ok}/${r.attempted}${r.failed ? ` (${r.failed} failed)` : ""}`);
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no rows written, no archive created.");
  } else if (ARCHIVE) {
    console.log(`\nArchiving JSON files to ${ARCHIVE}...`);
    await fs.mkdir(ARCHIVE, { recursive: true });
    for (const filename of [
      "users.json", "products.json", "services.json", "expenses.json",
      "orders.json", "invoices.json", "customers.json", "customerCredits.json",
      "notifications.json", "storeSettings.json", "hotel.json",
    ]) {
      const src = path.join(DATA_DIR, filename);
      try {
        await fs.access(src);
      } catch {
        continue; // ENOENT — skip
      }
      const dst = path.join(ARCHIVE, filename);
      await fs.rename(src, dst);
    }
    console.log("  Done. JSON files moved to archive.");
  }

  await closePool();
};

if (require.main === module) {
  main().catch((err) => {
    console.error("Loader failed:", err);
    process.exit(1);
  });
}

module.exports = { main, results };