-- =============================================================================
-- 015_services_industry_columns.sql
--
-- Wire the Service Catalog to the industry-specific invoice template registry
-- shipped in f3d4ff8 ("feat(service): industry-specific invoice templates")
-- + dd2cfb8 ("feat(service): industry-default UI + lock enforcement").
--
-- Background:
--   - The 16-industry / 3-renderer-family template registry lives on the
--     frontend at src/components/service/templates/index.js. The renderer
--     chain (resolveTemplate → ModernA4 / TraditionalA4 / CondensedReceipt)
--     is already wired into InvoiceView and PublicInvoiceView and reads
--     industry / templateId / fields off `items[0].meta` AND the top-level
--     invoice object.
--   - The runtime migration at db/runtime-migrations.js adds the same three
--     columns at backend boot when the app user has ALTER rights. This file
--     is the parallel DBA-executed path for managed MySQL / TiDB Cloud
--     setups where the runtime path's ALTER is denied.
--
-- Columns added to `services`:
--   - industry              VARCHAR(64)  NULL  — one of the 16 industry
--                                              ids in the shared registry
--                                              (consulting, manufacturing,
--                                              …). NULL = "use the store
--                                              default / no specific
--                                              industry".
--   - default_template_id   VARCHAR(64)  NULL  — picks the per-invoice
--                                              renderer family + sections
--                                              at billing time
--                                              (consulting-modern,
--                                              manufacturing-traditional,
--                                              …). NULL = fall back to the
--                                              store-level default template.
--   - hsn_sac               VARCHAR(16)  NULL  — HSN (goods) or SAC
--                                              (services) tax code. Free
--                                              text per the F9 spec so a
--                                              cashier can enter either an
--                                              8-digit HSN or a 6-digit
--                                              SAC.
--
-- All three columns are nullable so legacy services rows keep working
-- without a backfill. The query layer (db/queries/services.js) was extended
-- in the same commit to SELECT these columns and the update() allow-list
-- accepts the camelCase keys from the frontend.
--
-- Engine support:
--   - MySQL 8.0 / MariaDB 10.x: uses a helper stored procedure that probes
--     information_schema before each ALTER, so re-runs are no-ops.
--   - TiDB 4.0+ (managed TiDB Cloud included): the SQL Editor rejects
--     DELIMITER + CREATE PROCEDURE blocks (see _missing-tidb-fixup.sql for
--     the existing pattern). This file first detects TiDB via
--     VERSION() and switches to plain `ALTER TABLE ... ADD COLUMN IF NOT
--     EXISTS` (TiDB-native, idempotent) for that engine.
--
--   Verification after running:
--     SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
--     FROM information_schema.COLUMNS
--     WHERE TABLE_SCHEMA = DATABASE()
--       AND TABLE_NAME = 'services'
--       AND COLUMN_NAME IN ('industry', 'default_template_id', 'hsn_sac');
--   Expect three rows back, all VARCHAR, all IS_NULLABLE = 'YES'.
-- =============================================================================

USE `pos_billing`;

-- Drop any leftover procedures from a prior partial run on MySQL 8.
-- These statements are no-ops on TiDB (no procedure exists to drop) but
-- we wrap them so a single file works on both engines.
DROP PROCEDURE IF EXISTS `migrate_015_add_column_if_missing`;

DELIMITER $$
CREATE PROCEDURE `migrate_015_add_column_if_missing`(
  IN p_table VARCHAR(64),
  IN p_column VARCHAR(64),
  IN p_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND COLUMN_NAME = p_column
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD COLUMN `', p_column, '` ', p_definition);
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- =============================================================================
-- Engine branch.
--
-- TiDB VERSION() comments look like "5.7.25-TiDB-v7.5.0"; on MySQL 8 they
-- look like "8.0.32". So `VERSION() LIKE '%TiDB%'` reliably distinguishes
-- the two engines. We wrap the TiDB branch in a stored-procedure that
-- CALLs nothing on MySQL 8 (so the no-op stored procedure is invisible
-- there) and CALLs the procedural ALTERs on TiDB. That keeps this file
-- runnable on both engines from a single .sql file with no client-side
-- branching.
-- =============================================================================

DELIMITER $$
CREATE PROCEDURE `migrate_015_apply`()
BEGIN
  IF VERSION() LIKE '%TiDB%' THEN
    -- TiDB 4.0+ supports ADD COLUMN IF NOT EXISTS natively, which is
    -- idempotent and runs cleanly inside the TiDB Cloud SQL Editor
    -- where DELIMITER / CREATE PROCEDURE statements themselves are
    -- not supported. We still respect the AFTER clause to keep the
    -- column ORDER identical to the MySQL branch so the runtime
    -- migration at db/runtime-migrations.js can never disagree with
    -- what's actually on disk.
    SET @sql_industry = 'ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `industry` VARCHAR(64) NULL AFTER `category`';
    PREPARE stmt FROM @sql_industry; EXECUTE stmt; DEALLOCATE PREPARE stmt;

    SET @sql_template = 'ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `default_template_id` VARCHAR(64) NULL AFTER `industry`';
    PREPARE stmt FROM @sql_template; EXECUTE stmt; DEALLOCATE PREPARE stmt;

    SET @sql_hsn = 'ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `hsn_sac` VARCHAR(16) NULL AFTER `default_template_id`';
    PREPARE stmt FROM @sql_hsn; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  ELSE
    -- MySQL 8 / MariaDB path: go through the gated helper procedure so
    -- re-runs on a partially-migrated DB are safe. Same column shape
    -- as the TiDB branch above.
    CALL migrate_015_add_column_if_missing(
      'services', 'industry',
      'VARCHAR(64) NULL AFTER `category`'
    );
    CALL migrate_015_add_column_if_missing(
      'services', 'default_template_id',
      'VARCHAR(64) NULL AFTER `industry`'
    );
    CALL migrate_015_add_column_if_missing(
      'services', 'hsn_sac',
      'VARCHAR(16) NULL AFTER `default_template_id`'
    );
  END IF;
END$$
DELIMITER ;

CALL `migrate_015_apply`();

-- Cleanup: drop the helper procedures so they don't pollute the schema.
DROP PROCEDURE `migrate_015_apply`;
DROP PROCEDURE `migrate_015_add_column_if_missing`;
