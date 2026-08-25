// server/db/runtime-migrations.js
//
// Self-applying, idempotent schema migrations that run on backend startup.
// Keeps deploys self-healing for additive column changes the app code
// expects to read/write — without a manual Railway/Render DBA step.
//
// Why this exists: the `invoices` table was created by 001_initial_ddl.sql
// without a `status` column. The PUT /api/invoices/:invoiceNo route
// (Clear / Cancel / Pending) writes { status: "..." } to that table, but
// until this migration ran, the column didn't exist so the value was
// silently dropped and the row came back without a status — the
// frontend's invoice.status stayed undefined and the pill kept showing
// "pending" even after a successful round-trip.
//
// The app user (`pos_billing_app`) is DML-only. If ALTER is denied, we
// log a clear hint and return; the route handlers still install so the
// rest of the app keeps working, and the SQL is printed for the DBA to
// run by hand.

const { query, pool } = require("./pool");

// One entry per additive migration. Each entry is:
//   - name: human-readable identifier for log output
//   - table: the table to inspect
//   - column: the column that must exist
//   - ddl: the full `ALTER TABLE ... ADD COLUMN` clause (no IF NOT EXISTS
//          for portability with MySQL < 8; we gate on information_schema
//          ourselves)
//
// Note: `products.image_path` + `products.image_mime` come from migration
// `009_product_images.sql`. That file uses a stored procedure (the MySQL
// Query tab on Railway is single-statement and cannot run procedures),
// so on a fresh Railway DB the columns were never created. The product
// image upload route tries to `UPDATE products SET image_path = ?,
// image_mime = ?` and would 500 with "Unknown column" until the columns
// existed. We re-apply the equivalent ALTERs here on every backend boot
// so a redeploy to a DB that never ran the original migration still gets
// the columns — without the operator having to drop into the Query tab.
const MIGRATIONS = [
  {
    name: "invoices.status",
    table: "invoices",
    column: "status",
    ddl: "ALTER TABLE `invoices` ADD COLUMN `status` VARCHAR(32) NULL AFTER `billed_by`",
  },
  {
    name: "products.image_path",
    table: "products",
    column: "image_path",
    ddl: "ALTER TABLE `products` ADD COLUMN `image_path` VARCHAR(255) NULL AFTER `unit`",
  },
  {
    name: "products.image_mime",
    table: "products",
    column: "image_mime",
    ddl: "ALTER TABLE `products` ADD COLUMN `image_mime` VARCHAR(64) NULL AFTER `image_path`",
  },
];

const isDenied = (err) => {
  if (!err) return false;
  if (err.errno === 1142) return true; // ER_TABLEACCESS_DENIED_ERROR
  if (err.errno === 1227) return true; // ER_SPECIFIC_ACCESS_DENIED_ERROR
  const code = String(err.code || "");
  if (code.includes("DENIED") || code.includes("denied")) return true;
  return /command denied/i.test(String(err.message || ""));
};

const runRuntimeMigrations = async () => {
  if (!process.env.DB_NAME) {
    // Pool would have thrown already; this is just a belt-and-braces guard.
    console.warn("[runtime-migrations] DB_NAME not set; skipping.");
    return { applied: 0, skipped: 0, denied: 0 };
  }

  let applied = 0;
  let skipped = 0;
  let denied = 0;

  for (const m of MIGRATIONS) {
    let needs = false;
    try {
      const [rows] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
        [process.env.DB_NAME, m.table, m.column]
      );
      needs = !rows || rows.length === 0;
    } catch (err) {
      console.warn(`[runtime-migrations] ${m.name} inspection failed: ${err.message}`);
      // Fail open: try the ALTER anyway; if it errors we'll surface it.
      needs = true;
    }

    if (!needs) {
      skipped += 1;
      continue;
    }

    try {
      await query(m.ddl);
      applied += 1;
      console.log(`[runtime-migrations] applied: ${m.name}`);
    } catch (err) {
      if (isDenied(err)) {
        denied += 1;
        console.warn(
          `[runtime-migrations] ${m.name} skipped — app user lacks ALTER rights. ` +
            `Run this once as a DBA:\n  ${m.ddl};`
        );
      } else {
        console.warn(`[runtime-migrations] ${m.name} failed: ${err.message}`);
      }
    }
  }

  return { applied, skipped, denied };
};

module.exports = { runRuntimeMigrations, MIGRATIONS };

