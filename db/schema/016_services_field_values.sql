-- =============================================================================
-- 016_services_field_values.sql
--
-- Persist the per-service dynamic field values from F10. The Service
-- Management form (ServiceManagementPage.jsx) grows industry-specific
-- inputs (PO number, distributor code, LR / GR No, donor name, etc.) as
-- soon as the cashier picks an industry, and persists whatever they type
-- here so the next bill can pre-fill the same fields via
-- ServiceBilling.jsx's toggleItem auto-seed.
--
-- Background:
--   - The per-industry field set is defined in
--     src/components/service/templates/index.js (the FIELDS object). The
--     same registry's `required: true` markers are mirrored on the
--     backend at db/queries/services.js:REQUIRED_FIELDS_BY_INDUSTRY.
--   - The runtime migration at db/runtime-migrations.js adds the column
--     at backend boot when the app user has ALTER rights. This file is
--     the parallel DBA-executed path for managed MySQL / TiDB Cloud
--     setups where the runtime path's ALTER is denied.
--
-- Column added to `services`:
--   - field_values   LONGTEXT  NULL — JSON-encoded object whose keys are
--                                   the field `key`s from
--                                   fieldConfigFor(industry) and whose
--                                   values are free-text strings. Only
--                                   the keys belonging to the service's
--                                   saved industry are persisted;
--                                   switching industries on the row
--                                   drops stale keys so the JSON stays
--                                   tight. NULL / "{}" indicates no
--                                   industry-specific fields configured.
--
-- Nullable with no default, so legacy services rows keep working without
-- a backfill. The query layer (db/queries/services.js:rowToService)
-- parses the JSON with a safe fallback to {} on read so the frontend
-- never has to defend against null.
--
-- Why LONGTEXT and not native JSON: this codebase already standardizes
-- on LONGTEXT for free-form JSON columns (invoices.items,
-- invoices.discount). Following the convention keeps the migration
-- uniform and avoids the TiDB-vs-MySQL dialect differences on JSON
-- extraction paths.
--
-- Engine support:
--   - MySQL 8.0 / MariaDB 10.x: gated helper procedure that probes
--     information_schema before each ALTER, so re-runs are no-ops.
--   - TiDB 4.0+ (managed TiDB Cloud included): the SQL Editor rejects
--     DELIMITER + CREATE PROCEDURE blocks (see _missing-tidb-fixup.sql
--     for the existing pattern). This file first detects TiDB via
--     VERSION() and switches to plain `ALTER TABLE ... ADD COLUMN IF NOT
--     EXISTS` (TiDB-native, idempotent) for that engine.
--
-- Verification after running:
--   SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'services'
--     AND COLUMN_NAME = 'field_values';
--   Expect one row: `field_values | longtext | YES`.
-- =============================================================================

USE `pos_billing`;

-- Drop any leftover procedures from a prior partial run on MySQL 8.
-- These statements are no-ops on TiDB (no procedure exists to drop) but
-- we wrap them so a single file works on both engines.
DROP PROCEDURE IF EXISTS `migrate_016_add_column_if_missing`;

DELIMITER $$
CREATE PROCEDURE `migrate_016_add_column_if_missing`(
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
-- TiDB VERSION() comments look like "5.7.25-TiDB-v7.5.0"; on MySQL 8
-- they look like "8.0.32". So `VERSION() LIKE '%TiDB%'` reliably
-- distinguishes the two engines. We wrap the TiDB branch in a
-- stored-procedure that CALLs nothing on MySQL 8 (so the no-op stored
-- procedure is invisible there) and CALLs the procedural ALTERs on
-- TiDB. That keeps this file runnable on both engines from a single
-- .sql file with no client-side branching.
-- =============================================================================

DELIMITER $$
CREATE PROCEDURE `migrate_016_apply`()
BEGIN
  IF VERSION() LIKE '%TiDB%' THEN
    -- TiDB 4.0+ supports ADD COLUMN IF NOT EXISTS natively, which is
    -- idempotent and runs cleanly inside the TiDB Cloud SQL Editor
    -- where DELIMITER / CREATE PROCEDURE statements themselves are
    -- not supported.
    SET @sql_field_values = 'ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `field_values` LONGTEXT NULL AFTER `hsn_sac`';
    PREPARE stmt FROM @sql_field_values; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  ELSE
    -- MySQL 8 / MariaDB path: go through the gated helper procedure
    -- so re-runs on a partially-migrated DB are safe. Same column
    -- shape as the TiDB branch above.
    CALL migrate_016_add_column_if_missing(
      'services', 'field_values',
      'LONGTEXT NULL AFTER `hsn_sac`'
    );
  END IF;
END$$
DELIMITER ;

CALL `migrate_016_apply`;

-- Cleanup: drop the helper procedures so they don't pollute the schema.
DROP PROCEDURE `migrate_016_apply`;
DROP PROCEDURE `migrate_016_add_column_if_missing`;
