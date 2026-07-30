-- -----------------------------------------------------------------------------
-- 005_laundry.sql
--
-- Laundry counter + ledger. The counter is a (day, value) pair so each
-- calendar day starts fresh at 1. The ledger is append-only stock
-- movements scoped to a (storeType, storeId) pair.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `laundry_token_counters` (
  `day` DATE NOT NULL,
  `value` INT UNSIGNED NOT NULL DEFAULT 0,
  `_store_type` VARCHAR(64) NOT NULL DEFAULT '',
  `_store_id` VARCHAR(128) NOT NULL DEFAULT '',
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`day`, `_store_type`, `_store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `laundry_ledger` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `product_name` VARCHAR(255) NOT NULL,
  `delta` DECIMAL(12, 3) NOT NULL,
  `reason` VARCHAR(255) NULL,
  `at` DATETIME(3) NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_laundry_ledger_store` (`_store_type`, `_store_id`),
  KEY `idx_laundry_ledger_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;