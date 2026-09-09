// server/scripts/migrate-shift-invoice-link.js
//
// One-time migration companion to db/schema/012_shift_invoice_link.sql.
// Use this script on databases that pre-date MySQL 8.0.29 and don't
// support `ADD COLUMN IF NOT EXISTS` natively — every statement below
// is guarded by an information_schema check so re-running is a no-op.
//
//   node scripts/migrate-shift-invoice-link.js            # run it
//   node scripts/migrate-shift-invoice-link.js --dry-run  # preview only
//
// Reads DB_* from server/.env (same as db/pool.js). The ALTER step needs
// CREATE/ALTER privileges; if DB_ADMIN_USER / DB_ADMIN_PASSWORD are set,
// the script connects as that admin for the DDL and as the app user for
// verification. Without them it prints the exact ALTER statements to run
// manually if DDL is denied.

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

const adminConfig = process.env.DB_ADMIN_USER
  ? {
      ...config,
      user: process.env.DB_ADMIN_USER,
      password: process.env.DB_ADMIN_PASSWORD || process.env.DB_PASSWORD,
    }
  : null;

const describeTable = async (conn, table) => {
  const [rows] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [config.database, table]
  );
  return new Set(rows.map((r) => r.COLUMN_NAME));
};

const hasIndex = async (conn, table, name) => {
  const [rows] = await conn.query(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [config.database, table, name]
  );
  return Number((rows && rows[0] && rows[0].n) || 0) > 0;
};

(async () => {
  const conn = await mysql.createConnection(config);
  const ddl = adminConfig ? await mysql.createConnection(adminConfig) : conn;
  try {
    // === shifts table =====================================================
    const shiftCols = await describeTable(conn, "shifts");
    const shiftsAdds = [
      { name: "branch_name", ddl: "VARCHAR(128) NULL AFTER `store_id`" },
      { name: "customer_email", ddl: "VARCHAR(255) NULL AFTER `branch_name`" },
      { name: "opened_by_user_id", ddl: "BIGINT UNSIGNED NULL AFTER `customer_email`" },
      { name: "closed_by_user_id", ddl: "BIGINT UNSIGNED NULL AFTER `opened_by_user_id`" },
      { name: "total_sales", ddl: "DECIMAL(14, 2) NULL AFTER `closing_cash`" },
      { name: "variance", ddl: "DECIMAL(12, 2) NULL AFTER `total_sales`" },
    ];
    let missingShift = [];
    for (const col of shiftsAdds) {
      if (shiftCols.has(col.name)) continue;
      missingShift.push(col);
      const sql = `ALTER TABLE \`shifts\` ADD COLUMN \`${col.name}\` ${col.ddl}`;
      console.log(`  ${DRY_RUN ? "[dry-run] " : ""}${sql}`);
      if (DRY_RUN) continue;
      try {
        await ddl.query(sql);
      } catch (err) {
        const denied =
          err.errno === 1142 ||
          String(err.code || "").includes("DENIED") ||
          /command denied/i.test(String(err.message || ""));
        if (denied) {
          console.log(`\n  !! ALTER denied — the app user is DML-only. Run as an admin:\n`);
          for (const m of shiftsAdds) console.log(`     ALTER TABLE \`shifts\` ADD COLUMN \`${m.name}\` ${m.ddl};`);
          console.log("");
          return;
        }
        throw err;
      }
    }

    // === invoices.shift_id column =========================================
    const invCols = await describeTable(conn, "invoices");
    if (!invCols.has("shift_id")) {
      const sql = "ALTER TABLE `invoices` ADD COLUMN `shift_id` BIGINT UNSIGNED NULL AFTER `_user_email`";
      console.log(`  ${DRY_RUN ? "[dry-run] " : ""}${sql}`);
      if (!DRY_RUN) {
        try { await ddl.query(sql); } catch (err) { throw err; }
      }
    } else {
      console.log("  - invoices.shift_id already exists (skip)");
    }
    if (!(await hasIndex(conn, "invoices", "idx_invoices_shift"))) {
      const sql = "ALTER TABLE `invoices` ADD KEY `idx_invoices_shift` (`shift_id`, `_store_type`, `_store_id`)";
      console.log(`  ${DRY_RUN ? "[dry-run] " : ""}${sql}`);
      if (!DRY_RUN) {
        try { await ddl.query(sql); } catch (err) { throw err; }
      }
    } else {
      console.log("  - idx_invoices_shift already exists (skip)");
    }

    // Re-verify everything landed.
    const [shiftColsAfter] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'shifts'`,
      [config.database]
    );
    const stillMissing = shiftsAdds.filter((c) => !new Set(shiftColsAfter.map((r) => r.COLUMN_NAME)).has(c.name));
    if (stillMissing.length) {
      console.log(`\n  Still missing on shifts: ${stillMissing.map((m) => m.name).join(", ")}. Re-run as admin.`);
      return;
    }

    console.log(DRY_RUN ? "\nDRY-RUN COMPLETE" : "\nMIGRATION COMPLETE");
  } finally {
    await conn.end();
    if (ddl !== conn) await ddl.end();
  }
})().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
