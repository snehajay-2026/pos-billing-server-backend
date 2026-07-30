-- -----------------------------------------------------------------------------
-- 004_inventory.sql
--
-- Inventory tables: suppliers, purchase_orders + purchase_order_items,
-- stock_movements, and a `low_stock` threshold column on `products`.
--
-- Idempotent — safe to re-apply. Adds new tables + a column on products
-- (with a default) so existing rows aren't broken.
-- -----------------------------------------------------------------------------

-- Add low_stock threshold to products (used by /api/inventory/low-stock).
-- Default 0 means "no threshold; never alert".
-- MySQL 8 doesn't support ADD COLUMN IF NOT EXISTS, so we use a procedure
-- to make this idempotent: only add the column if it doesn't already exist.
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