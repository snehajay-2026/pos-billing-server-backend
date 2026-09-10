-- =============================================================================
-- 013_cash_movement_unique_ref.sql
--
-- Bug #2 fix: cash-movement endpoint is not idempotent.
--
-- The `shift_cash_movements` ledger was missing `ref_type` and `ref_id`
-- columns. The route handler accepted these fields but the query layer
-- silently dropped them, so the INSERT that followed succeeded but no
-- row could be referenced later. Worse: there was no uniqueness check,
-- so a cashier who clicked "Record drop" twice for the same invoice
-- produced two rows and double-counted into expected_cash. The close-
-- shift dialog would then demand a drawer balance that was actually
-- correct, surfacing as a phantom variance.
--
-- This migration:
--   1. Adds `ref_type` (VARCHAR(32)) and `ref_id` (VARCHAR(128)) columns
--      to `shift_cash_movements`. Both are nullable so existing manual
--      rows (refund:…/drop:…/paid_out:…) keep working unchanged.
--   2. Adds a UNIQUE index on (shift_id, ref_type, ref_id) so the
--      route layer's INSERT … ON DUPLICATE KEY UPDATE actually has
--      something to dedupe against. NULLs are allowed multiple times
--      by MySQL's UNIQUE semantics, which is what we want for
--      ad-hoc manual movements without a ref.
--
-- Idempotency: same shape as 012 — uses information_schema probes.
-- The Node side mirrors this in db/runtime-migrations.js so a fresh
-- Render deploy self-applies without a manual SQL run.
--
-- Safe rollback: the application degrades gracefully if these columns
-- are absent (the query layer omits them from the INSERT and the route
-- layer's idempotency check is a no-op). The opposite — index without
-- columns — would error on the ALTER, which is why the column ADDs run
-- first.
-- =============================================================================

USE `pos_billing`;

DROP PROCEDURE IF EXISTS `migrate_013_add_column_if_missing`;
DROP PROCEDURE IF EXISTS `migrate_013_add_unique_index_if_missing`;

DELIMITER $$
CREATE PROCEDURE `migrate_013_add_column_if_missing`(
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

CREATE PROCEDURE `migrate_013_add_unique_index_if_missing`(
  IN p_table VARCHAR(64),
  IN p_index VARCHAR(64),
  IN p_columns VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = p_table
      AND INDEX_NAME = p_index
  ) THEN
    SET @sql = CONCAT(
      'ALTER TABLE `', p_table, '` ADD UNIQUE KEY `', p_index, '` (', p_columns, ')'
    );
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- === shift_cash_movements.ref_type / ref_id ================================
CALL migrate_013_add_column_if_missing(
  'shift_cash_movements', 'ref_type',
  'VARCHAR(32) NULL AFTER `reason`'
);
CALL migrate_013_add_column_if_missing(
  'shift_cash_movements', 'ref_id',
  'VARCHAR(128) NULL AFTER `ref_type`'
);

-- === UNIQUE index for idempotency ==========================================
-- NULLs are allowed multiple times by MySQL UNIQUE semantics, so manual
-- rows without a ref continue to insert without conflict. Only rows
-- that carry a non-null (ref_type, ref_id) pair dedupe against each
-- other for the same shift.
CALL migrate_013_add_unique_index_if_missing(
  'shift_cash_movements', 'uq_shift_cash_movements_ref',
  '`shift_id`, `ref_type`, `ref_id`'
);

DROP PROCEDURE `migrate_013_add_column_if_missing`;
DROP PROCEDURE `migrate_013_add_unique_index_if_missing`;
