-- =============================================================================
-- POS Billing — TiDB Cloud combined schema (all 11 migrations)
-- -----------------------------------------------------------------------------
-- Apply via TiDB Cloud SQL Editor: select `pos_billing` database in the
-- top-right dropdown, paste this file, click Run (▶).
--
-- Idempotent: re-running is safe. CREATE TABLE IF NOT EXISTS, ADD COLUMN
-- IF NOT EXISTS where supported, and INFORMATION_SCHEMA guards where not.
-- =============================================================================

-- ===== 001_initial_ddl.sql =====

-- 1. users
CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `email` VARCHAR(255) NOT NULL,
  `password` VARCHAR(255) NOT NULL,
  `role` ENUM('SUPER_OWNER', 'ADMIN', 'STORE_ADMIN', 'CASHIER') NOT NULL DEFAULT 'CASHIER',
  `store_type` VARCHAR(64) NULL,
  `store_id` VARCHAR(128) NULL,
  `owner_email` VARCHAR(255) NULL,
  `root_owner_email` VARCHAR(255) NULL,
  `approved` TINYINT(1) NOT NULL DEFAULT 0,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `name` VARCHAR(255) NULL,
  `phone` VARCHAR(64) NULL,
  `address` TEXT NULL,
  `reset_token` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  UNIQUE KEY `uq_users_email` (`email`),
  KEY `idx_users_role` (`role`),
  KEY `idx_users_store` (`store_type`, `store_id`),
  KEY `idx_users_owner_email` (`owner_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. products
CREATE TABLE IF NOT EXISTS `products` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `gst` DECIMAL(5, 2) NOT NULL DEFAULT 0,
  `stock` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `barcode` VARCHAR(64) NULL,
  `category` VARCHAR(128) NULL,
  `unit` ENUM('unit', 'kg') NOT NULL DEFAULT 'unit',
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_products_store` (`_store_type`, `_store_id`),
  KEY `idx_products_user` (`_user_email`),
  KEY `idx_products_barcode` (`barcode`),
  KEY `idx_products_category` (`category`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. services
CREATE TABLE IF NOT EXISTS `services` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL,
  `description` TEXT NULL,
  `rate` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `hours` DECIMAL(8, 2) NULL,
  `gst` DECIMAL(5, 2) NOT NULL DEFAULT 0,
  `category` VARCHAR(128) NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_services_store` (`_store_type`, `_store_id`),
  KEY `idx_services_user` (`_user_email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. expenses
CREATE TABLE IF NOT EXISTS `expenses` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `category` VARCHAR(128) NULL,
  `description` TEXT NULL,
  `date` DATE NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_expenses_store` (`_store_type`, `_store_id`),
  KEY `idx_expenses_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. orders
CREATE TABLE IF NOT EXISTS `orders` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `customer` VARCHAR(255) NULL,
  `phone` VARCHAR(64) NULL,
  `service` VARCHAR(255) NULL,
  `items` JSON NULL,
  `qty` INT NULL,
  `qty_kg` DECIMAL(12, 3) NULL,
  `status` VARCHAR(64) NOT NULL DEFAULT 'pending',
  `type` VARCHAR(32) NULL,
  `token` VARCHAR(32) NULL,
  `invoice_no` VARCHAR(64) NULL,
  `subtotal` DECIMAL(12, 2) NULL,
  `gst_total` DECIMAL(12, 2) NULL,
  `express_surcharge` DECIMAL(12, 2) NULL,
  `total` DECIMAL(12, 2) NULL,
  `express` TINYINT(1) NOT NULL DEFAULT 0,
  `expected_return` DATE NULL,
  `notes` TEXT NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_orders_store` (`_store_type`, `_store_id`),
  KEY `idx_orders_status` (`status`),
  KEY `idx_orders_type` (`type`),
  KEY `idx_orders_invoice` (`invoice_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. invoices
CREATE TABLE IF NOT EXISTS `invoices` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `invoice_no` VARCHAR(64) NOT NULL,
  `date` DATE NULL,
  `items` JSON NULL,
  `sub_total` DECIMAL(12, 2) NULL,
  `gst_total` DECIMAL(12, 2) NULL,
  `grand_total` DECIMAL(12, 2) NULL,
  `discount` JSON NULL,
  `discount_breakdown` JSON NULL,
  `payment_mode` VARCHAR(32) NULL,
  `billed_by` VARCHAR(255) NULL,
  `customer_name` VARCHAR(255) NULL,
  `customer_mobile` VARCHAR(32) NULL,
  `status` VARCHAR(32) NULL,
  `generated_at` DATETIME(3) NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  UNIQUE KEY `uq_invoices_invoice_no` (`invoice_no`),
  KEY `idx_invoices_store` (`_store_type`, `_store_id`),
  KEY `idx_invoices_user` (`_user_email`),
  KEY `idx_invoices_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. store_settings
CREATE TABLE IF NOT EXISTS `store_settings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `scope_key` VARCHAR(255) NOT NULL,
  `scope_type` ENUM('global', 'store') NOT NULL DEFAULT 'global',
  `store_type` VARCHAR(64) NULL,
  `store_id` VARCHAR(128) NULL,
  `payload` JSON NOT NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  UNIQUE KEY `uq_store_settings_scope` (`scope_key`),
  KEY `idx_store_settings_store` (`store_type`, `store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. hotel_state
CREATE TABLE IF NOT EXISTS `hotel_state` (
  `id` TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  `tables` JSON NULL,
  `waiting` JSON NULL,
  `dining_waiting` JSON NULL,
  `lodging_waiting` JSON NULL,
  `checkout_history` JSON NULL,
  `dining_bills` JSON NULL,
  `updated_at` DATETIME(3) NULL,
  CONSTRAINT `chk_hotel_state_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `hotel_state` (`id`) VALUES (1);

-- 9. sessions
CREATE TABLE IF NOT EXISTS `sessions` (
  `session_id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. shifts + 11. shift_cash_movements
CREATE TABLE IF NOT EXISTS `shifts` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `store_type` VARCHAR(64) NULL,
  `store_id` VARCHAR(128) NULL,
  `status` ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  `opening_float` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `closing_cash` DECIMAL(12, 2) NULL,
  `expected_cash` DECIMAL(12, 2) NULL,
  `notes` TEXT NULL,
  `close_notes` TEXT NULL,
  `opened_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `closed_at` DATETIME(3) NULL,
  KEY `idx_shifts_user_status` (`user_id`, `status`),
  KEY `idx_shifts_store` (`store_type`, `store_id`),
  KEY `idx_shifts_opened_at` (`opened_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `shift_cash_movements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `shift_id` BIGINT UNSIGNED NOT NULL,
  `type` ENUM('cash_in', 'cash_out') NOT NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `reason` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_shift_cash_shift` (`shift_id`),
  CONSTRAINT `fk_shift_cash_shift`
    FOREIGN KEY (`shift_id`) REFERENCES `shifts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. payment_intents
CREATE TABLE IF NOT EXISTS `payment_intents` (
  `id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `invoice_no` VARCHAR(64) NULL,
  `amount` DECIMAL(12, 2) NOT NULL,
  `method` ENUM('cash', 'upi', 'card', 'other') NOT NULL,
  `status` ENUM('pending', 'paid', 'failed', 'cancelled') NOT NULL DEFAULT 'pending',
  `note` TEXT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_payment_intents_invoice` (`invoice_no`),
  KEY `idx_payment_intents_status` (`status`),
  KEY `idx_payment_intents_store` (`_store_type`, `_store_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. audit_log
CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user_id` BIGINT UNSIGNED NULL,
  `action` VARCHAR(64) NOT NULL,
  `entity_type` VARCHAR(64) NULL,
  `entity_id` VARCHAR(128) NULL,
  `payload` JSON NULL,
  `ip` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_audit_created_at` (`created_at`),
  KEY `idx_audit_user` (`user_id`),
  KEY `idx_audit_action` (`action`),
  KEY `idx_audit_entity` (`entity_type`, `entity_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. customers
CREATE TABLE IF NOT EXISTS `customers` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `name` VARCHAR(255) NULL,
  `phone` VARCHAR(64) NULL,
  `email` VARCHAR(255) NULL,
  `address` TEXT NULL,
  `notes` TEXT NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_customers_store` (`_store_type`, `_store_id`),
  KEY `idx_customers_user` (`_user_email`),
  KEY `idx_customers_phone` (`phone`),
  KEY `idx_customers_email` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. customer_credits
CREATE TABLE IF NOT EXISTS `customer_credits` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `customer_phone` VARCHAR(64) NULL,
  `customer_name` VARCHAR(255) NULL,
  `amount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `description` TEXT NULL,
  `date` DATE NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_credits_store` (`_store_type`, `_store_id`),
  KEY `idx_credits_user` (`_user_email`),
  KEY `idx_credits_phone` (`customer_phone`),
  KEY `idx_credits_date` (`date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. notifications
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  `read_flag` TINYINT(1) NOT NULL DEFAULT 0,
  `email` VARCHAR(255) NULL,
  `type` VARCHAR(64) NULL,
  `message` TEXT NULL,
  `payload` JSON NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NULL,
  `updated_at` DATETIME(3) NULL,
  KEY `idx_notifications_user` (`_user_email`),
  KEY `idx_notifications_email` (`email`),
  KEY `idx_notifications_read` (`read_flag`),
  KEY `idx_notifications_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


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

DROP PROCEDURE IF EXISTS add_low_stock_if_missing;
CREATE PROCEDURE add_low_stock_if_missing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'low_stock'
  ) THEN
    ALTER TABLE `products` ADD COLUMN `low_stock` DECIMAL(12, 3) NULL DEFAULT 0;
  END IF;
END;
CALL add_low_stock_if_missing();
DROP PROCEDURE add_low_stock_if_missing;

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

UPDATE `invoices`
SET `customer_name` = NULLIF(
      TRIM(JSON_UNQUOTE(JSON_EXTRACT(`items`, '$[0].meta.guest'))),
      ''
    )
WHERE `customer_name` IS NULL
  AND `items` IS NOT NULL;

UPDATE `invoices`
SET `customer_mobile` = NULLIF(
      TRIM(JSON_UNQUOTE(JSON_EXTRACT(`items`, '$[0].meta.customerMobile'))),
      ''
    )
WHERE `customer_mobile` IS NULL
  AND `items` IS NOT NULL;


-- ===== 008_invoice_status.sql =====

ALTER TABLE `invoices`
  ADD COLUMN IF NOT EXISTS `status` VARCHAR(32) NULL AFTER `billed_by`;


-- ===== 009_invoice_generated_at.sql =====

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS `generated_at` DATETIME(3) NULL AFTER `created_at`;


-- ===== 009_product_images.sql =====

DROP PROCEDURE IF EXISTS add_product_image_if_missing;
CREATE PROCEDURE add_product_image_if_missing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'image_path'
  ) THEN
    ALTER TABLE `products` ADD COLUMN `image_path` VARCHAR(255) NULL AFTER `unit`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'image_mime'
  ) THEN
    ALTER TABLE `products` ADD COLUMN `image_mime` VARCHAR(64) NULL AFTER `image_path`;
  END IF;
END;
CALL add_product_image_if_missing();
DROP PROCEDURE add_product_image_if_missing;


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
-- TiDB supports ADD COLUMN IF NOT EXISTS natively (since 4.0).

ALTER TABLE hotel_coupons ADD COLUMN IF NOT EXISTS usage_limit INT NULL AFTER active;
ALTER TABLE hotel_coupons ADD COLUMN IF NOT EXISTS usage_count INT NOT NULL DEFAULT 0 AFTER usage_limit;

-- =============================================================================
-- END
-- =============================================================================
