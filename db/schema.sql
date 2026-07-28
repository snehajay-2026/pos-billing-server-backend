-- =============================================================================
-- POS Billing — MySQL schema
-- -----------------------------------------------------------------------------
-- Run order:
--   1. As MySQL root (or any user with CREATE USER + GRANT):
--        source db/schema.sql
--      This script bootstraps the database, the dedicated app user, and every
--      table. It is idempotent — re-running drops nothing, only adds missing
--      pieces.
--
--   2. In server/.env (create if missing):
--        DB_HOST=localhost
--        DB_PORT=3306
--        DB_USER=pos_billing_app
--        DB_PASSWORD=<set-this>
--        DB_NAME=pos_billing
--
--   3. Restart `npm start` in server/. The pool in db/pool.js will connect
--      with the credentials above.
--
-- Source of truth for column shapes: server/data/*.json + server/index.js.
-- If a JSON field is missing on a given row, the column is NULL.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Database + dedicated user
-- -----------------------------------------------------------------------------
-- The dedicated user has ONLY grants on `pos_billing.*` — no global privileges,
-- no GRANT OPTION. Root access is not used by app code at any point.

CREATE DATABASE IF NOT EXISTS `pos_billing`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

-- Create the app user. Skip-if-exists keeps the script idempotent.
-- NOTE: Replace 'CHANGE_ME_app_password' with the real password before running
-- in any environment. In dev, copy this file to schema.local.sql and .gitignore
-- it so the real password never gets committed.
CREATE USER IF NOT EXISTS 'pos_billing_app'@'localhost'
  IDENTIFIED BY 'CHANGE_ME_app_password';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON `pos_billing`.*
  TO 'pos_billing_app'@'localhost';

FLUSH PRIVILEGES;

USE `pos_billing`;

-- -----------------------------------------------------------------------------
-- 1. users
-- -----------------------------------------------------------------------------
-- Source: server/data/users.json
-- Notes: `password` is bcrypt-hashed (60 chars). `role` is one of
--   SUPER_OWNER, ADMIN, STORE_ADMIN, CASHIER. `status` mirrors `approved`
--   for backwards compat (the frontend reads either).
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

-- -----------------------------------------------------------------------------
-- 2. products
-- -----------------------------------------------------------------------------
-- Source: server/data/products.json
-- Notes: `stock` is DECIMAL because products sell in kg too. `unit` is
--   ENUM('unit', 'kg'). The scope columns (_storeType / _storeId /
--   _userEmail) drive multi-tenant filtering.
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

-- -----------------------------------------------------------------------------
-- 3. services
-- -----------------------------------------------------------------------------
-- Source: server/data/services.json
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

-- -----------------------------------------------------------------------------
-- 4. expenses
-- -----------------------------------------------------------------------------
-- Source: server/data/expenses.json (currently empty in the repo)
-- Notes: free-form schema. The frontend sets its own columns.
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

-- -----------------------------------------------------------------------------
-- 5. orders
-- -----------------------------------------------------------------------------
-- Source: server/data/orders.json
-- Notes: `items` is a JSON array (laundry orders carry line items; service
--   orders don't). `type` is ENUM('laundry', 'service', etc.) but kept
--   VARCHAR(32) for forward-compat with new verticals.
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

-- -----------------------------------------------------------------------------
-- 6. invoices
-- -----------------------------------------------------------------------------
-- Source: server/data/invoices.json (the largest table — ~4k rows).
-- Notes: `items` is a JSON array of the cart line-items as the POS sent
--   them. `discount` and `discountBreakdown` are JSON. The atomic checkout
--   path uses `SELECT ... FOR UPDATE` on `products`, not on this table.
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

-- -----------------------------------------------------------------------------
-- 7. store_settings
-- -----------------------------------------------------------------------------
-- Source: server/data/storeSettings.json
-- Notes: The JSON file supports three layouts — flat object, {global:{...}},
--   or {store-settings:{type}:{id}:{...}}. We normalize all three into
--   `scope_key` + `payload`. `scope_key` is 'global' for unscoped settings
--   and 'store-settings:{type}:{id}' otherwise.
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

-- -----------------------------------------------------------------------------
-- 8. hotel_state
-- -----------------------------------------------------------------------------
-- Source: server/data/hotel.json
-- Notes: Single-row table holding the entire hotel state object (tables,
--   waiting lists, dining bills, checkout history). The original design
--   keeps this as one blob because the data is small and highly
--   cross-referenced; splitting it into 6 tables would add joins with no
--   real query benefit. App code does in-memory mutation + a single
--   UPDATE on persist.
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

-- Seed the singleton row.
INSERT IGNORE INTO `hotel_state` (`id`) VALUES (1);

-- -----------------------------------------------------------------------------
-- 9. sessions
-- -----------------------------------------------------------------------------
-- Source: server/data/sessions.json
-- Notes: Replaces both the JSON file AND the in-memory `sessions` Map. The
--   in-memory Map was faster but volatile; this row-per-session table is
--   cheap and survives restarts.
CREATE TABLE IF NOT EXISTS `sessions` (
  `session_id` VARCHAR(64) NOT NULL PRIMARY KEY,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `expires_at` BIGINT NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 10. shifts + 11. shift_cash_movements
-- -----------------------------------------------------------------------------
-- New. The frontend already calls /api/shifts/* — these tables back that
-- surface. `shifts` is one row per open/close cycle; `shift_cash_movements`
-- is the audit trail of cash in/out events during a shift.
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

-- -----------------------------------------------------------------------------
-- 12. payment_intents
-- -----------------------------------------------------------------------------
-- New. Backed by the existing frontend paymentService. `intent_id` is a
-- client-generated string (UUID-like). Status is polled by the POS until
-- the cashier marks the intent paid/failed.
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

-- -----------------------------------------------------------------------------
-- 13. audit_log
-- -----------------------------------------------------------------------------
-- New. Append-only feed for RecentActivity.jsx. Indexed on created_at so the
-- paged list query stays fast as it grows. payload is JSON for forward-compat
-- with whatever fields the audit writer decides to include.
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

-- -----------------------------------------------------------------------------
-- 14. customers
-- -----------------------------------------------------------------------------
-- Source: server/data/customers.json
-- Notes: Free-form CRM-ish fields. Name + phone are the only "real" columns;
--   the rest is just whatever the frontend has been storing.
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

-- -----------------------------------------------------------------------------
-- 15. customer_credits
-- -----------------------------------------------------------------------------
-- Source: server/data/customerCredits.json
-- Notes: Each row is a credit balance tied to a customer (by phone) for a
--   specific store scope. amount is DECIMAL because it represents money.
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

-- -----------------------------------------------------------------------------
-- 16. notifications
-- -----------------------------------------------------------------------------
-- Source: server/data/notifications.json
-- Notes: User-scoped activity feed (password-reset requests, system events).
--   `payload` is JSON for forward-compat with whatever fields future
--   notification writers want to attach.
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

-- =============================================================================
-- END
-- =============================================================================
