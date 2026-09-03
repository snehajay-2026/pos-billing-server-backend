-- =============================================================================
-- TiDB schema fix-up — apply only the missing tables
-- -----------------------------------------------------------------------------
-- The first run created the tables from 001_initial_ddl.sql (16 tables) but
-- the second-pass migrations (003-011) didn't take effect. Run this file
-- to apply JUST the missing pieces. Safe to re-run.
-- =============================================================================

-- ===== 003_hotel_module_locks.sql =====
CREATE TABLE IF NOT EXISTS `hotel_module_locks` (
  `customer_email` VARCHAR(255) NOT NULL,
  `module` ENUM('lodging', 'dining', 'liveBill') NOT NULL,
  `locked` TINYINT(1) NOT NULL DEFAULT 0,
  `locked_by` VARCHAR(255) NULL,
  `locked_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`customer_email`, `module`),
  KEY `idx_hotel_module_locks_locked` (`locked`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ===== 004_inventory.sql =====
-- TiDB Cloud SQL Editor doesn't support stored procedures, so we use
-- ADD COLUMN IF NOT EXISTS directly (TiDB 4.0+ supports this).

ALTER TABLE `products` ADD COLUMN IF NOT EXISTS `low_stock` DECIMAL(12, 3) NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS `suppliers` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `phone` VARCHAR(32) NULL,
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `gstin` VARCHAR(32) NULL,
  `notes` TEXT NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_suppliers_store` (`_store_type`, `_store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `purchase_orders` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `po_number` VARCHAR(64) NOT NULL,
  `supplier_id` BIGINT UNSIGNED NULL,
  `supplier_name` VARCHAR(255) NULL,
  `status` ENUM('draft', 'sent', 'received', 'cancelled') NOT NULL DEFAULT 'draft',
  `total_amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `notes` TEXT NULL,
  `expected_at` DATE NULL,
  `received_at` DATETIME(3) NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY `uq_purchase_orders_po_number` (`po_number`),
  KEY `idx_purchase_orders_store` (`_store_type`, `_store_id`),
  KEY `idx_purchase_orders_supplier` (`supplier_id`),
  KEY `idx_purchase_orders_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `purchase_order_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `purchase_order_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `quantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `received_quantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  KEY `idx_po_items_po` (`purchase_order_id`),
  KEY `idx_po_items_product` (`product_id`),
  CONSTRAINT `fk_po_items_po`
    FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `stock_movements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `product_id` BIGINT UNSIGNED NOT NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `type` ENUM('in', 'out', 'adjustment') NOT NULL,
  `quantity` DECIMAL(12, 3) NOT NULL,
  `reason` VARCHAR(255) NULL,
  `purchase_order_id` BIGINT UNSIGNED NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_stock_movements_product` (`product_id`),
  KEY `idx_stock_movements_store` (`_store_type`, `_store_id`),
  KEY `idx_stock_movements_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ===== 005_laundry.sql =====

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


-- ===== 006_hotel_bookings.sql =====

CREATE TABLE IF NOT EXISTS `hotel_bookings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `kind` ENUM('dining', 'lodging') NOT NULL,
  `table_id` VARCHAR(64) NULL,
  `table_name` VARCHAR(255) NULL,
  `zone` VARCHAR(64) NULL,
  `party_size` INT UNSIGNED NULL,
  `order_summary` JSON NULL,
  `ordered_menu_items` JSON NULL,
  `room_id` VARCHAR(64) NULL,
  `room_number` VARCHAR(64) NULL,
  `guest_name` VARCHAR(255) NULL,
  `customer_mobile` VARCHAR(32) NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'booked',
  `notes` TEXT NULL,
  `check_in_date` DATE NULL,
  `check_in_time` VARCHAR(16) NULL,
  `expected_check_out` DATE NULL,
  `actual_check_out` DATETIME(3) NULL,
  `created_by` VARCHAR(255) NULL,
  `_store_type` VARCHAR(64) NOT NULL DEFAULT 'hotel',
  `_store_id` VARCHAR(128) NOT NULL DEFAULT 'hotel',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_hotel_bookings_store` (`_store_type`, `_store_id`),
  KEY `idx_hotel_bookings_kind` (`kind`),
  KEY `idx_hotel_bookings_status` (`status`),
  KEY `idx_hotel_bookings_table` (`table_id`),
  KEY `idx_hotel_bookings_room` (`room_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ===== 007_invoice_customer_columns.sql (idempotent) =====

ALTER TABLE `invoices` ADD COLUMN IF NOT EXISTS `customer_name` VARCHAR(255) NULL AFTER `billed_by`;
ALTER TABLE `invoices` ADD COLUMN IF NOT EXISTS `customer_mobile` VARCHAR(32) NULL AFTER `customer_name`;

-- ===== 008_invoice_status.sql =====
ALTER TABLE `invoices`
  ADD COLUMN IF NOT EXISTS `status` VARCHAR(32) NULL AFTER `billed_by`;

-- ===== 009_invoice_generated_at.sql =====
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS `generated_at` DATETIME(3) NULL AFTER `created_at`;


-- ===== 009_product_images.sql =====
-- Direct ADD COLUMN IF NOT EXISTS (TiDB 4.0+ supports this).

ALTER TABLE `products` ADD COLUMN IF NOT EXISTS `image_path` VARCHAR(255) NULL AFTER `unit`;
ALTER TABLE `products` ADD COLUMN IF NOT EXISTS `image_mime` VARCHAR(64) NULL AFTER `image_path`;


-- ===== 010_hotel_coupons.sql =====

CREATE TABLE IF NOT EXISTS hotel_coupons (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(64)  NOT NULL,
  type            ENUM('percent') NOT NULL DEFAULT 'percent',
  value           DECIMAL(5,2) NOT NULL,
  min_subtotal    DECIMAL(10,2) NULL,
  valid_from      DATETIME NULL,
  valid_until     DATETIME NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  _store_type     VARCHAR(32)  NULL,
  _store_id       VARCHAR(64)  NULL,
  _user_email     VARCHAR(190) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_coupon_scope (code, _store_type, _store_id, _user_email),
  KEY idx_code (code),
  KEY idx_scope (active, _store_type, _store_id, _user_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ===== 011_coupon_usage.sql =====
-- TiDB supports ADD COLUMN IF NOT EXISTS natively (since 4.0), so the
-- original MySQL-8 INFORMATION_SCHEMA + PREPARE dance isn't needed.

ALTER TABLE hotel_coupons ADD COLUMN IF NOT EXISTS usage_limit INT NULL AFTER active;
ALTER TABLE hotel_coupons ADD COLUMN IF NOT EXISTS usage_count INT NOT NULL DEFAULT 0 AFTER usage_limit;

-- =============================================================================
-- END
-- =============================================================================
