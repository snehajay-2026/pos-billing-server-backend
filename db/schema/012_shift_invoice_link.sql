-- =============================================================================
-- 012_shift_invoice_link.sql
--
-- Wire invoices to shifts so the cashier's drawer session (open float, close
-- count, variance) actually reflects what was sold.
--
-- Background:
--   - The shifts table already exists (001_initial_ddl.sql).
--   - The shift_cash_movements table is the audit log of cash in/out events.
--   - But the invoices table has no shift_id, and the shift table has no
--     branch_name / customer_email / total_sales / variance columns.
--   - The frontend's CloseShiftDialog + ShiftsPage render branch_name,
--     openedByUser, totalSales, variance, etc. None of those are persisted
--     today, so the dialog renders zeros and the history list shows blanks.
--   - The frontend's recordCashSaleForShift POSTs to a URL that doesn't
--     exist on the backend, so cash sales never land on the shift's
--     cash_movements ledger. Expected closing cash always equals opening
--     float because nothing ever bumps it up.
--
-- This migration:
--   1. Adds shift_id to invoices (NULL allowed: invoices outside any shift
--      — e.g. system, super-owner impersonating — still work).
--   2. Adds branch_name / customer_email / opened_by_user_id /
--      closed_by_user_id / total_sales / variance to shifts so the
--      cashier's typed branch label and "who opened/closed this" survive
--      past the request and the history list renders without per-row
--      joins.
--   3. Adds idx_invoices_shift so the new shift summary endpoint can
--      aggregate invoices WHERE shift_id = ? cheaply.
--
-- Idempotency:
--   - Each ALTER is wrapped in a stored procedure that probes
--     information_schema before applying. Re-running on a fresh DB is
--     fine; re-running on a partially-migrated DB completes the rest.
--   - We deliberately do NOT use `ADD COLUMN IF NOT EXISTS` because
--     some TiDB Cloud tiers emit a confusing "column does not exist"
--     error when they hit the unsupported parser branch. The procedure
--     approach is portable across MySQL 8.0, TiDB 4.0+, and older
--     MySQL 5.7.
--   - On older MySQL (< 5.5) without information_schema support, run
--     scripts/migrate-shift-invoice-link.js instead — it does the same
--     probes from Node.
--
-- Why denormalize opened_by_user_id / closed_by_user_id onto shifts:
--   - The history list reads totalSales + variance on every render; we'd
--     otherwise pay a users join per row. Denormalizing the user_id keys
--     keeps the history page cheap, and the detail dialog can still JOIN
--     users for email/role display.
-- =============================================================================

USE `pos_billing`;

-- Drop any leftover procedures from a prior partial run so the CREATE
-- below never collides with a stub.
DROP PROCEDURE IF EXISTS `migrate_012_add_column_if_missing`;
DROP PROCEDURE IF EXISTS `migrate_012_add_index_if_missing`;

DELIMITER $$
CREATE PROCEDURE `migrate_012_add_column_if_missing`(
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

CREATE PROCEDURE `migrate_012_add_index_if_missing`(
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
    SET @sql = CONCAT('ALTER TABLE `', p_table, '` ADD KEY `', p_index, '` (', p_columns, ')');
    PREPARE stmt FROM @sql;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- === invoices.shift_id ======================================================
CALL migrate_012_add_column_if_missing(
  'invoices', 'shift_id',
  'BIGINT UNSIGNED NULL AFTER `_user_email`'
);
CALL migrate_012_add_index_if_missing(
  'invoices', 'idx_invoices_shift',
  '`shift_id`, `_store_type`, `_store_id`'
);

-- === shifts metadata columns ================================================
CALL migrate_012_add_column_if_missing(
  'shifts', 'branch_name',
  'VARCHAR(128) NULL AFTER `store_id`'
);
CALL migrate_012_add_column_if_missing(
  'shifts', 'customer_email',
  'VARCHAR(255) NULL AFTER `branch_name`'
);
CALL migrate_012_add_column_if_missing(
  'shifts', 'opened_by_user_id',
  'BIGINT UNSIGNED NULL AFTER `customer_email`'
);
CALL migrate_012_add_column_if_missing(
  'shifts', 'closed_by_user_id',
  'BIGINT UNSIGNED NULL AFTER `opened_by_user_id`'
);
CALL migrate_012_add_column_if_missing(
  'shifts', 'total_sales',
  'DECIMAL(14, 2) NULL AFTER `closing_cash`'
);
CALL migrate_012_add_column_if_missing(
  'shifts', 'variance',
  'DECIMAL(12, 2) NULL AFTER `total_sales`'
);

-- Cleanup: drop the helper procedures so they don't pollute the schema.
DROP PROCEDURE `migrate_012_add_column_if_missing`;
DROP PROCEDURE `migrate_012_add_index_if_missing`;
