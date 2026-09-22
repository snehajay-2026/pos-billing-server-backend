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
//
// F8 hard-startup-gate: a small number of migrations are CORRECTNESS
// gates rather than performance / DX polish. If `invoices.customer_id`
// is missing (the cashier's `customerId` would silently drop on every
// POST) or `idx_invoices_customer` is missing (the customer-statement
// lookup has no supporting index), the backend refuses to start so the
// operator sees the failure at deploy time, not at request time. Other
// denied migrations continue to soft-warn — see `CRITICAL_MIGRATIONS`
// below for the exact list and `runRuntimeMigrations` for the gate the
// startup path uses.

const { query, pool } = require("./pool");

// Names whose denial or failure must abort the backend startup. The
// names match either the `name` field of a `MIGRATIONS` entry, or one
// of the inline `*IdxName` constants below for the index migrations.
// Anything not in this set continues to soft-warn — keeping the
// original belt-and-braces behavior intact for the unrelated migrations
// (customers.shift_id, customers.approval_status, etc.).
const CRITICAL_MIGRATIONS = new Set([
  // Column-add: the cashier's `customerId` would silently drop on every
  // POST /api/invoices and /api/invoices/checkout if this column doesn't
  // exist. Without the column, no row of an invoice with a linked
  // customer ever sees the linkage — and the customer-statement
  // endpoint can't return those invoices either.
  "invoices.customer_id",
  // Index: `WHERE customer_id = ? AND _store_type = ? AND _store_id = ?`
  // is the customer-statement lookup. Without the index this becomes a
  // full table scan on a rapidly-growing table. Performance-critical for
  // correctness windows (e.g. an admin running a month-end statement).
  "idx_invoices_customer",
]);

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
  {
    name: "purchase_order_items.catalog_type",
    table: "purchase_order_items",
    column: "catalog_type",
    ddl: "ALTER TABLE `purchase_order_items` ADD COLUMN `catalog_type` ENUM('product', 'service') NOT NULL DEFAULT 'product' AFTER `purchase_order_id`",
  },
  {
    name: "purchase_order_items.catalog_id",
    table: "purchase_order_items",
    column: "catalog_id",
    ddl: "ALTER TABLE `purchase_order_items` ADD COLUMN `catalog_id` BIGINT UNSIGNED NULL AFTER `catalog_type`",
  },
  {
    // Bug #2 fix: ref_type/ref_id were planned but never migrated onto
    // shift_cash_movements. Without them, the cashier's "Record drop"
    // button could fire twice and double-count into expected_cash. After
    // these columns land, the route layer can upsert on
    // (shift_id, ref_type, ref_id) to make the endpoint idempotent.
    name: "shift_cash_movements.ref_type",
    table: "shift_cash_movements",
    column: "ref_type",
    ddl: "ALTER TABLE `shift_cash_movements` ADD COLUMN `ref_type` VARCHAR(32) NULL AFTER `reason`",
  },
  {
    name: "shift_cash_movements.ref_id",
    table: "shift_cash_movements",
    column: "ref_id",
    ddl: "ALTER TABLE `shift_cash_movements` ADD COLUMN `ref_id` VARCHAR(128) NULL AFTER `ref_type`",
  },
  // F7: customer approval workflow. Adds the columns needed for the
  // Cashier-submits / Admin-approves workflow (Option B from the customer
  // management audit). All columns are additive — the ALTER uses DEFAULT
  // 'approved' so legacy rows surface as approved without the backfill
  // UPDATE below.
  {
    name: "customers.gstin",
    table: "customers",
    column: "gstin",
    ddl: "ALTER TABLE `customers` ADD COLUMN `gstin` VARCHAR(15) NULL AFTER `notes`",
  },
  {
    name: "customers.approval_status",
    table: "customers",
    column: "approval_status",
    ddl: "ALTER TABLE `customers` ADD COLUMN `approval_status` VARCHAR(16) NOT NULL DEFAULT 'approved' AFTER `gstin`",
  },
  {
    name: "customers.approved_by_email",
    table: "customers",
    column: "approved_by_email",
    ddl: "ALTER TABLE `customers` ADD COLUMN `approved_by_email` VARCHAR(255) NULL AFTER `approval_status`",
  },
  {
    name: "customers.approved_at",
    table: "customers",
    column: "approved_at",
    ddl: "ALTER TABLE `customers` ADD COLUMN `approved_at` DATETIME(3) NULL AFTER `approved_by_email`",
  },
  {
    name: "customers.rejected_by_email",
    table: "customers",
    column: "rejected_by_email",
    ddl: "ALTER TABLE `customers` ADD COLUMN `rejected_by_email` VARCHAR(255) NULL AFTER `approved_at`",
  },
  {
    name: "customers.rejected_at",
    table: "customers",
    column: "rejected_at",
    ddl: "ALTER TABLE `customers` ADD COLUMN `rejected_at` DATETIME(3) NULL AFTER `rejected_by_email`",
  },
  {
    name: "customers.rejection_reason",
    table: "customers",
    column: "rejection_reason",
    ddl: "ALTER TABLE `customers` ADD COLUMN `rejection_reason` TEXT NULL AFTER `rejected_at`",
  },
  {
    name: "customers.created_by_email",
    table: "customers",
    column: "created_by_email",
    ddl: "ALTER TABLE `customers` ADD COLUMN `created_by_email` VARCHAR(255) NULL AFTER `rejection_reason`",
  },
  // F8: invoice ↔ customer linkage for the customer approval workflow.
  // Adds a nullable BIGINT UNSIGNED `customer_id` so the invoice row can
  // reference the CRM record that paid for it. Same data type as
  // `customers.id` (BIGINT UNSIGNED, populated by Date.now() by the
  // customers query helper). Nullable so legacy invoices without a
  // selected customer keep working; the route layer treats NULL as
  // "walking customer" and preserves existing behavior. Cross-store /
  // pending / rejected customer ids are rejected at the route layer
  // before this INSERT ever runs.
  {
    name: "invoices.customer_id",
    table: "invoices",
    column: "customer_id",
    ddl: "ALTER TABLE `invoices` ADD COLUMN `customer_id` BIGINT UNSIGNED NULL AFTER `customer_mobile`",
  },
  // F9: service catalog ↔ industry-specific invoice template linkage.
  // Adds three nullable columns on the `services` table so a row in the
  // Service Catalog can carry:
  //   - industry              — one of the 16 industry ids from the shared
  //                             template registry (`consulting`,
  //                             `manufacturing`, …). NULL means "no specific
  //                             industry / use the store-level default".
  //   - default_template_id   — picks the per-invoice renderer family +
  //                             sections at billing time (e.g.
  //                             `consulting-modern`,
  //                             `manufacturing-traditional`). Falls back to
  //                             the system default when NULL.
  //   - hsn_sac               — HSN (goods) or SAC (services) tax code;
  //                             optional free-text up to 16 chars. Captured
  //                             here so the cashier doesn't have to retype
  //                             it on every bill.
  // All three columns are nullable so legacy services keep working; the
  // migration is additive only and the rate-history capture (which diffs
  // on `rate`/`hours`/`gst`) is untouched.
  {
    name: "services.industry",
    table: "services",
    column: "industry",
    ddl: "ALTER TABLE `services` ADD COLUMN `industry` VARCHAR(64) NULL AFTER `category`",
  },
  {
    name: "services.default_template_id",
    table: "services",
    column: "default_template_id",
    ddl: "ALTER TABLE `services` ADD COLUMN `default_template_id` VARCHAR(64) NULL AFTER `industry`",
  },
  {
    name: "services.hsn_sac",
    table: "services",
    column: "hsn_sac",
    ddl: "ALTER TABLE `services` ADD COLUMN `hsn_sac` VARCHAR(16) NULL AFTER `default_template_id`",
  },
  // F10: per-service dynamic field values keyed off the industry
  // template registry. The Service Catalog form (ServiceManagementPage.jsx)
  // grows industry-specific inputs (PO number, distributor code, etc.) as
  // soon as the cashier picks an industry, and persists whatever they
  // type here so the next bill can pre-fill the same fields via
  // ServiceBilling.jsx's toggleItem auto-seed.
  //
  // Shape: a JSON-encoded object whose keys are the field `key`s from
  // `fieldConfigFor(industry)` and whose values are free-text strings.
  // Only the keys belonging to the service's saved industry are
  // persisted; switching industries on the row drops stale keys so the
  // JSON stays tight. Legacy services (no field_values column) keep
  // working — the column is nullable with no default.
  //
  // Why LONGTEXT and not native JSON: this codebase already standardizes
  // on LONGTEXT for free-form JSON columns (invoices.items,
  // invoices.discount, invoices.discount_breakdown). Following the
  // convention keeps the migration uniform and avoids the TiDB-vs-MySQL
  // dialect differences on JSON extraction paths.
  {
    name: "services.field_values",
    table: "services",
    column: "field_values",
    ddl: "ALTER TABLE `services` ADD COLUMN `field_values` LONGTEXT NULL AFTER `hsn_sac`",
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

// F8 hard-startup-gate (probe-failure leg). For CORRECTNESS-CRITICAL
// migrations, a single failed information_schema probe could be a
// transient infra blip OR a sign that the schema state cannot be read
// at all (e.g. permission revoked on information_schema itself, or the
// connection is mid-failover). We re-probe once. If the second probe
// also fails we cannot tell whether the column/index exists, so the
// safe choice is to refuse to start rather than silently proceed. The
// re-probe is boot-time only — there are no per-request probes — and it
// only runs on critical entries, so the total cost is at most one extra
// round-trip per critical migration per backend boot.

const probeColumn = async (table, column) => {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [process.env.DB_NAME, table, column]
  );
  return { present: !!(rows && rows.length) };
};

const probeIndex = async (table, indexName) => {
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [process.env.DB_NAME, table, indexName]
  );
  return { present: !!(rows && rows.length) };
};

const runRuntimeMigrations = async () => {
  if (!process.env.DB_NAME) {
    // Pool would have thrown already; this is just a belt-and-braces guard.
    console.warn("[runtime-migrations] DB_NAME not set; skipping.");
    return {
      applied: 0,
      skipped: 0,
      denied: 0,
      deniedCritical: [],
      deniedNames: [],
      unconfirmedCritical: [],
      unconfirmedNames: [],
    };
  }

  let applied = 0;
  let skipped = 0;
  let denied = 0;
  // F8: track WHICH migrations were denied so the startup path can abort
  // when the denial lands on a correctness gate (see CRITICAL_MIGRATIONS).
  // Each entry captures the failure reason and the DBA-actionable DDL the
  // operator needs to run by hand — the same hint that was already logged
  // inline, but kept here in a structured form so the abort message can
  // echo it back without duplicating log parsing.
  const deniedCritical = [];
  const deniedNames = [];
  // F8: track critical migrations whose information_schema probe failed
  // TWICE in a row. We cannot tell whether the column/index exists, so
  // the safe choice is to abort startup rather than silently dropping
  // the column or running the ALTER blind. The startup gate (in
  // index.js startServer) reads this field and exits non-zero.
  const unconfirmedCritical = [];
  const unconfirmedNames = [];

  for (const m of MIGRATIONS) {
    const isCritical = CRITICAL_MIGRATIONS.has(m.name);
    let needs = false;
    let probeUnconfirmed = false;
    try {
      const probe = await probeColumn(m.table, m.column);
      needs = !probe.present;
    } catch (err) {
      if (!isCritical) {
        // Unrelated migrations keep the original fail-open behavior: log
        // and try the ALTER anyway. If the ALTER also fails we surface
        // that failure inline; we don't gate startup on it.
        console.warn(`[runtime-migrations] ${m.name} inspection failed: ${err.message}`);
        needs = true;
      } else {
        // Critical migration — single probe failure could be transient.
        // Re-probe once; if the second probe also throws, the schema
        // state is unconfirmed, so record the entry in unconfirmedCritical
        // and skip the ALTER entirely (proceeding blind could either
        // silently miss a missing column or ALTER a column that already
        // exists with a different shape).
        try {
          const reProbe = await probeColumn(m.table, m.column);
          needs = !reProbe.present;
        } catch (reErr) {
          console.warn(
            `[runtime-migrations] ${m.name} inspection failed twice — cannot confirm schema state: ${reErr.message}`
          );
          probeUnconfirmed = true;
        }
      }
    }

    if (probeUnconfirmed) {
      unconfirmedCritical.push({
        name: m.name,
        ddl: m.ddl,
        reason: "information_schema probe failed twice at startup; schema state could not be confirmed",
      });
      unconfirmedNames.push(m.name);
      continue;
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
        deniedNames.push(m.name);
        if (CRITICAL_MIGRATIONS.has(m.name)) {
          deniedCritical.push({ name: m.name, ddl: m.ddl, reason: err.message });
        }
        console.warn(
          `[runtime-migrations] ${m.name} skipped — app user lacks ALTER rights. ` +
            `Run this once as a DBA:\n  ${m.ddl};`
        );
      } else {
        console.warn(`[runtime-migrations] ${m.name} failed: ${err.message}`);
      }
    }
  }

  // Bug #2 fix: a UNIQUE index on (shift_id, ref_type, ref_id) makes
  // POST /api/shifts/:id/cash-movements idempotent at the DB level.
  // Without it, two clicks on "Record drop" for the same invoice would
  // produce two rows and double-count into expected_cash. The query
  // layer uses INSERT … ON DUPLICATE KEY UPDATE so even rows that
  // arrive before the index exists don't break; once the index is
  // present the second insert becomes a no-op.
  const uniqueIdxName = "uq_shift_cash_movements_ref";
  try {
    const [idxRows] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [process.env.DB_NAME, "shift_cash_movements", uniqueIdxName]
    );
    if (!idxRows || idxRows.length === 0) {
      try {
        await query(
          "ALTER TABLE `shift_cash_movements` ADD UNIQUE KEY `uq_shift_cash_movements_ref` (`shift_id`, `ref_type`, `ref_id`)"
        );
        applied += 1;
        console.log(`[runtime-migrations] applied: ${uniqueIdxName}`);
      } catch (err) {
        if (isDenied(err)) {
          denied += 1;
          deniedNames.push(uniqueIdxName);
          console.warn(
            `[runtime-migrations] ${uniqueIdxName} skipped — app user lacks ALTER rights. ` +
              `Run this once as a DBA:\n  ALTER TABLE shift_cash_movements ` +
              `ADD UNIQUE KEY uq_shift_cash_movements_ref (shift_id, ref_type, ref_id);`
          );
        } else {
          console.warn(`[runtime-migrations] ${uniqueIdxName} failed: ${err.message}`);
        }
      }
    } else {
      skipped += 1;
    }
  } catch (err) {
    console.warn(`[runtime-migrations] ${uniqueIdxName} inspection failed: ${err.message}`);
  }

  // F7: composite index on customers for the new Pending-tab query
  // (`WHERE _store_type = ? AND _store_id = ? AND approval_status = 'pending'`).
  // Same belt-and-braces pattern as the shift_cash_movements unique index:
  // probe information_schema first, log a hint if the app user lacks ALTER.
  const customerStatusIdxName = "idx_customers_status";
  try {
    const [idxRows] = await pool.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [process.env.DB_NAME, "customers", customerStatusIdxName]
    );
    if (!idxRows || idxRows.length === 0) {
      try {
        await query(
          "ALTER TABLE `customers` ADD KEY `idx_customers_status` (`_store_type`, `_store_id`, `approval_status`)"
        );
        applied += 1;
        console.log(`[runtime-migrations] applied: ${customerStatusIdxName}`);
      } catch (err) {
        if (isDenied(err)) {
          denied += 1;
          deniedNames.push(customerStatusIdxName);
          console.warn(
            `[runtime-migrations] ${customerStatusIdxName} skipped — app user lacks ALTER rights. ` +
              `Run this once as a DBA:\n  ALTER TABLE customers ` +
              `ADD KEY idx_customers_status (_store_type, _store_id, approval_status);`
          );
        } else {
          console.warn(`[runtime-migrations] ${customerStatusIdxName} failed: ${err.message}`);
        }
      }
    } else {
      skipped += 1;
    }
  } catch (err) {
    console.warn(`[runtime-migrations] ${customerStatusIdxName} inspection failed: ${err.message}`);
  }

  // F8: composite index on invoices for the customer-statement lookup
  // (`WHERE customer_id = ? AND _store_type = ? AND _store_id = ?`).
  // Same belt-and-braces pattern as the customers status index: probe
  // information_schema first, log a hint if the app user lacks ALTER.
  const invoiceCustomerIdxName = "idx_invoices_customer";
  const invoiceCustomerIdxDdl =
    "ALTER TABLE `invoices` ADD KEY `idx_invoices_customer` (`customer_id`, `_store_type`, `_store_id`)";
  let invoiceCustomerIdxPresent = false;
  let invoiceCustomerIdxUnconfirmed = false;
  try {
    const probe = await probeIndex("invoices", invoiceCustomerIdxName);
    invoiceCustomerIdxPresent = probe.present;
  } catch (err) {
    // Critical index — single probe failure could be transient. Re-probe
    // once; if the second probe also throws, the schema state is
    // unconfirmed, so record the entry in unconfirmedCritical and skip
    // the ALTER entirely.
    try {
      const reProbe = await probeIndex("invoices", invoiceCustomerIdxName);
      invoiceCustomerIdxPresent = reProbe.present;
    } catch (reErr) {
      console.warn(
        `[runtime-migrations] ${invoiceCustomerIdxName} inspection failed twice — cannot confirm schema state: ${reErr.message}`
      );
      invoiceCustomerIdxUnconfirmed = true;
      unconfirmedCritical.push({
        name: invoiceCustomerIdxName,
        ddl: invoiceCustomerIdxDdl + ";",
        reason: "information_schema probe failed twice at startup; schema state could not be confirmed",
      });
      unconfirmedNames.push(invoiceCustomerIdxName);
    }
  }

  if (!invoiceCustomerIdxPresent && !invoiceCustomerIdxUnconfirmed) {
    try {
      await query(invoiceCustomerIdxDdl);
      applied += 1;
      console.log(`[runtime-migrations] applied: ${invoiceCustomerIdxName}`);
    } catch (err) {
      if (isDenied(err)) {
        denied += 1;
        deniedNames.push(invoiceCustomerIdxName);
        // F8 hard-startup-gate. The column-add `invoices.customer_id`
        // gate is handled above; this gate catches the case where the
        // column was added (DBA ran the migration by hand) but the
        // supporting index is still missing. Without the index the
        // customer-statement query degrades from index lookup to full
        // scan; we refuse to start so the operator notices before the
        // first end-of-month statement run.
        if (CRITICAL_MIGRATIONS.has(invoiceCustomerIdxName)) {
          deniedCritical.push({
            name: invoiceCustomerIdxName,
            ddl: invoiceCustomerIdxDdl + ";",
            reason: err.message,
          });
        }
        console.warn(
          `[runtime-migrations] ${invoiceCustomerIdxName} skipped — app user lacks ALTER rights. ` +
            `Run this once as a DBA:\n  ALTER TABLE invoices ` +
            "ADD KEY idx_invoices_customer (customer_id, _store_type, _store_id);"
        );
      } else {
        console.warn(`[runtime-migrations] ${invoiceCustomerIdxName} failed: ${err.message}`);
      }
    }
  } else if (invoiceCustomerIdxPresent) {
    skipped += 1;
  }

  // F7 backfill: legacy rows whose approval_status is missing/blank must
  // surface as 'approved' so the new status filter doesn't hide them.
  // Idempotent — only runs when the column was freshly added in this boot
  // (detected by checking if ANY row has a NULL/blank status). When the
  // DEFAULT 'approved' already populated every row, the UPDATE matches
  // zero rows and is a no-op.
  try {
    const [statusRows] = await pool.query(
      `SELECT COUNT(*) AS c FROM customers
         WHERE approval_status IS NULL OR approval_status = ''`
    );
    const legacyNullCount = Number(statusRows && statusRows[0] && statusRows[0].c) || 0;
    if (legacyNullCount > 0) {
      const result = await query(
        `UPDATE customers
            SET approval_status = 'approved',
                approved_by_email = COALESCE(created_by_email, _user_email),
                approved_at = COALESCE(approved_at, created_at, NOW(3))
          WHERE approval_status IS NULL OR approval_status = ''`
      );
      const affected = result && result[0] && result[0].affectedRows;
      console.log(
        `[runtime-migrations] customer approval_status backfill: updated ${affected || 0} legacy row(s)`
      );
    }
  } catch (err) {
    console.warn(`[runtime-migrations] customer approval_status backfill failed: ${err.message}`);
  }

  return {
    applied,
    skipped,
    denied,
    deniedCritical,
    deniedNames,
    unconfirmedCritical,
    unconfirmedNames,
  };
};

// TABLE_MIGRATIONS: idempotent CREATE TABLE IF NOT EXISTS migrations that
// also run on backend startup. Column-add migrations above cover the
// "ALTER existing table" case; this list covers the "new table for a new
// feature" case. Same portability considerations apply (no IF NOT EXISTS
// for some TiDB tiers; the guard is performed from Node).
//
// Why we don't unconditionally use CREATE TABLE IF NOT EXISTS in raw
// SQL: TiDB Cloud sometimes surfaces "duplicate column" / "feature not
// supported" errors on the IF NOT EXISTS parser branch, so we probe
// information_schema first and execute the DDL only when needed — same
// belt-and-braces pattern as the column adds above.
const TABLE_MIGRATIONS = [
  {
    name: "service_rate_history",
    table: "service_rate_history",
    ddl: `CREATE TABLE \`service_rate_history\` (
      \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      \`service_id\` BIGINT UNSIGNED NOT NULL,
      \`service_name\` VARCHAR(255) NULL,
      \`old_rate\` DECIMAL(12, 2) NULL,
      \`new_rate\` DECIMAL(12, 2) NULL,
      \`old_gst\` DECIMAL(5, 2) NULL,
      \`new_gst\` DECIMAL(5, 2) NULL,
      \`old_hours\` DECIMAL(8, 2) NULL,
      \`new_hours\` DECIMAL(8, 2) NULL,
      \`changed_by_user_id\` BIGINT UNSIGNED NULL,
      \`changed_by_email\` VARCHAR(255) NULL,
      \`changed_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY \`idx_srh_service_id\` (\`service_id\`, \`changed_at\`),
      KEY \`idx_srh_changed_at\` (\`changed_at\`),
      KEY \`idx_srh_user\` (\`changed_by_user_id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  },
];

const runTableMigrations = async () => {
  if (!process.env.DB_NAME) return { applied: 0, skipped: 0, denied: 0 };
  let applied = 0;
  let skipped = 0;
  let denied = 0;
  for (const m of TABLE_MIGRATIONS) {
    let needs = false;
    try {
      const [rows] = await pool.query(
        `SELECT TABLE_NAME FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1`,
        [process.env.DB_NAME, m.table]
      );
      needs = !rows || rows.length === 0;
    } catch (err) {
      console.warn(`[runtime-migrations] ${m.name} inspection failed: ${err.message}`);
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
          `[runtime-migrations] ${m.name} skipped — app user lacks CREATE rights. ` +
            `Run this once as a DBA:\n  ${m.ddl};`
        );
      } else {
        console.warn(`[runtime-migrations] ${m.name} failed: ${err.message}`);
      }
    }
  }
  return { applied, skipped, denied };
};

module.exports = {
  runRuntimeMigrations,
  runTableMigrations,
  MIGRATIONS,
  TABLE_MIGRATIONS,
  CRITICAL_MIGRATIONS,
};

