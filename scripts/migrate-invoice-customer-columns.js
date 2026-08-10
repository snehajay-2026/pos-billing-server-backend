// server/scripts/migrate-invoice-customer-columns.js
//
// One-time migration: adds customer_name / customer_mobile to the `invoices`
// table and backfills them from the JSON `items` column.
//
// Why: the DB never stored the guest name/mobile — they only lived on the
// frontend preview payload (hotelDetails / customerName) and inside each line
// item's meta.guest / meta.customerMobile. Saved invoices re-printed after a
// reload therefore lost the name. This migration persists the columns (for
// EXISTING deployments — fresh installs get them from 001_initial_ddl.sql)
// and restores the name/mobile for rows saved before the columns existed.
//
// Safe to re-run: column adds are guarded by information_schema checks, and
// the backfill only fills NULLs, so it never clobbers newer values.
//
// Usage:
//   node scripts/migrate-invoice-customer-columns.js            # run it
//   node scripts/migrate-invoice-customer-columns.js --dry-run  # preview only
//
// Reads DB_* from server/.env (same as db/pool.js).

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const mysql = require("mysql2/promise");

const DRY_RUN = process.argv.includes("--dry-run");

const config = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

// The DDL step (ALTER TABLE ... ADD COLUMN) needs CREATE/ALTER privileges,
// which the restricted `pos_billing_app` user deliberately lacks. Provide an
// admin connection via DB_ADMIN_USER / DB_ADMIN_PASSWORD (e.g. root) to let
// the script add the columns itself. Without it, the script still runs the
// backfill if the columns already exist, and fails the ALTER with a clear hint.
const adminConfig = process.env.DB_ADMIN_USER
  ? {
      ...config,
      user: process.env.DB_ADMIN_USER,
      password: process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD,
    }
  : null;

const clean = (v) => (v == null ? "" : String(v).trim());
const parseItems = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
};

const firstGuest = (items) => {
  for (const it of items) {
    if (it && it.meta && clean(it.meta.guest)) return clean(it.meta.guest);
  }
  return "";
};
const firstMobile = (items) => {
  for (const it of items) {
    if (it && it.meta && clean(it.meta.customerMobile)) return clean(it.meta.customerMobile);
  }
  return "";
};

(async () => {
  const c = await mysql.createConnection(config);
  try {
    // 1. Inspect current columns.
    const [cols] = await c.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'invoices'`,
      [config.database]
    );
    const existing = new Set(cols.map((r) => r.COLUMN_NAME));
    console.log(`invoices columns now: ${[...existing].join(", ")}`);

    // 2. Add missing columns. The app user is DML-only (see
    //    002_bootstrap_local.sql), so ALTER may be denied — in that case we
    //    print the exact SQL for an admin and skip the backfill.
    const adds = [
      { name: "customer_name", ddl: "VARCHAR(255) NULL AFTER `billed_by`" },
      { name: "customer_mobile", ddl: "VARCHAR(32) NULL AFTER `customer_name`" },
    ];
    let missing = [];
    for (const col of adds) {
      if (existing.has(col.name)) {
        console.log(`  - ${col.name} already exists (skip)`);
        continue;
      }
      missing.push(col);
      const sql = `ALTER TABLE \`invoices\` ADD COLUMN \`${col.name}\` ${col.ddl}`;
      console.log(`  ${DRY_RUN ? "[dry-run] " : ""}${sql}`);
      if (DRY_RUN) continue;
      try {
        await c.query(sql);
      } catch (err) {
        const denied =
          err.errno === 1142 ||
          String(err.code || "").includes("DENIED") ||
          /command denied/i.test(String(err.message || ""));
        if (denied) {
          console.log(
            `\n  !! ALTER denied — the app user is DML-only. Run this as an admin`
          );
          console.log(`     (e.g. mysql -u root -p) and then re-run this script:\n`);
          for (const m of adds) {
            console.log(`     ALTER TABLE \`invoices\` ADD COLUMN \`${m.name}\` ${m.ddl};`);
          }
          console.log("");
        } else {
          throw err;
        }
      }
    }

    // 3. Re-check columns after any ALTER attempts. If either is still
    //    missing, we cannot backfill — stop and let the admin finish the DDL.
    const [colsAfter] = await c.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'invoices'`,
      [config.database]
    );
    const after = new Set(colsAfter.map((r) => r.COLUMN_NAME));
    missing = adds.filter((col) => !after.has(col.name));
    if (missing.length) {
      console.log(
        `Skipping backfill: still missing column(s) ${missing.map((m) => m.name).join(", ")}. ` +
          `Run the ALTER as an admin, then re-run this script to backfill.`
      );
      return;
    }

    // 4. Backfill from items JSON — only where the column is NULL.
    const [rows] = await c.query(
      `SELECT invoice_no, items FROM invoices WHERE items IS NOT NULL`
    );
    let nameHits = 0;
    let mobileHits = 0;
    for (const row of rows) {
      const items = parseItems(row.items);
      const name = firstGuest(items);
      const mobile = firstMobile(items);
      if (!name && !mobile) continue;
      console.log(
        `  ${DRY_RUN ? "[dry-run] " : ""}${row.invoice_no} → ${name || "(no name)"}${
          mobile ? ` | ${mobile}` : ""
        }`
      );
      if (name) nameHits += 1;
      if (mobile) mobileHits += 1;
      if (DRY_RUN) continue;
      await c.query(
        `UPDATE invoices
         SET customer_name = COALESCE(customer_name, ?),
             customer_mobile = COALESCE(customer_mobile, ?)
         WHERE invoice_no = ?`,
        [name || null, mobile || null, row.invoice_no]
      );
    }

    console.log(
      DRY_RUN ? "DRY-RUN COMPLETE" : "MIGRATION COMPLETE",
      `| ${nameHits} rows would get / got a customer name, ${mobileHits} a mobile.`
    );
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
