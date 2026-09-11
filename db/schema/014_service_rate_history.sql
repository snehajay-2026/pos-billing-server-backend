-- =============================================================================
-- 014_service_rate_history.sql
--
-- Append-only audit trail for changes to the `services` catalog rate / GST /
-- hours columns. The service-management page already lets any admin flip
-- `rate`, `hours`, and `gst` on the fly. Before this migration, those
-- edits left no breadcrumb — a cashier who billed an order at the old rate
-- had no way to prove what the rate was at billing time, and the manager
-- had no way to spot a cashier who quietly nudged their friend's rate
-- down before invoicing.
--
-- Why a dedicated table instead of audit_log:
--   - The frontend "View rate history" panel wants a chronological list
--     with explicit before/after columns per field. JSON_EXTRACT-ing the
--     audit_log payload is awkward.
--   - Other append-only ledgers in this codebase (shift_cash_movements,
--     stock_movements, laundry_ledger) follow the same table-specific
--     pattern.
--   - We still append to audit_log too (from the PUT handler) so the
--     existing RecentActivity UI surfaces the change.
--
-- Scope:
--   - The table stores one row per PUT that changed rate/hours/gst.
--     Pure-rename PUTs (name/description/category only) skip the table.
--   - service_id is captured at write time even if the service row is
--     later deleted, so the history outlives the row.
--   - service_name snapshot is captured too so the panel can render the
--     history without a JOIN on services.
--   - changed_by_user_id + changed_by_email mirror the audit_log shape so
--     a future "show all changes by user X" query is symmetric.
-- =============================================================================

USE `pos_billing`;

DROP PROCEDURE IF EXISTS `migrate_014_create_service_rate_history`;

DELIMITER $$
CREATE PROCEDURE `migrate_014_create_service_rate_history`()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'service_rate_history'
  ) THEN
    CREATE TABLE `service_rate_history` (
      `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      `service_id` BIGINT UNSIGNED NOT NULL,
      `service_name` VARCHAR(255) NULL,
      `old_rate` DECIMAL(12, 2) NULL,
      `new_rate` DECIMAL(12, 2) NULL,
      `old_gst` DECIMAL(5, 2) NULL,
      `new_gst` DECIMAL(5, 2) NULL,
      `old_hours` DECIMAL(8, 2) NULL,
      `new_hours` DECIMAL(8, 2) NULL,
      `changed_by_user_id` BIGINT UNSIGNED NULL,
      `changed_by_email` VARCHAR(255) NULL,
      `changed_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      KEY `idx_srh_service_id` (`service_id`, `changed_at`),
      KEY `idx_srh_changed_at` (`changed_at`),
      KEY `idx_srh_user` (`changed_by_user_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  END IF;
END$$
DELIMITER ;

CALL `migrate_014_create_service_rate_history`();
DROP PROCEDURE `migrate_014_create_service_rate_history`;
