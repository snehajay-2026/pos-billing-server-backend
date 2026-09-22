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
--                                              SAC. The ServiceBilling UI
--                                              applies the same field as
--                                              the bill-level HSN/SAC when
--                                              the bill is fresh and the
--                                              product has one set.
--
-- All three columns are nullable so legacy services rows keep working
-- without a backfill. The query layer (db/queries/services.js) was extended
-- in the same commit to SELECT these columns and the update() allow-list
-- accepts the camelCase keys from the frontend.
--
-- Idempotency:
--   - The helper procedure probes information_schema before each ALTER, so
--     re-running on a fresh DB is a no-op and re-running on a partially-
--     migrated DB completes the rest.
--   - The column ORDER matches db/runtime-migrations.js so the
--     `AFTER <column>` clauses succeed whether the migration runs first
--     via this file or first via the runtime path.
-- =============================================================================

USE `pos_billing`;

-- Drop any leftover procedures from a prior partial run so the CREATE
-- below never collides with a stub.
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

-- === services.industry =====================================================
CALL migrate_015_add_column_if_missing(
  'services', 'industry',
  'VARCHAR(64) NULL AFTER `category`'
);

-- === services.default_template_id =========================================
CALL migrate_015_add_column_if_missing(
  'services', 'default_template_id',
  'VARCHAR(64) NULL AFTER `industry`'
);

-- === services.hsn_sac =====================================================
CALL migrate_015_add_column_if_missing(
  'services', 'hsn_sac',
  'VARCHAR(16) NULL AFTER `default_template_id`'
);

-- Cleanup: drop the helper procedure so it doesn't pollute the schema.
DROP PROCEDURE `migrate_015_add_column_if_missing`;
