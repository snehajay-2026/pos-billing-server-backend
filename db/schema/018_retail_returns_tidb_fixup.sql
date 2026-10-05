-- -----------------------------------------------------------------------------
-- 018_retail_returns_tidb_fixup.sql
--
-- TiDB-safe ADDITIVE fix-up for the retail returns schema introduced by
-- 017_retail_returns.sql. Migration 017 is deliberately left untouched:
-- environments that already applied it keep their migration history, and this
-- file only ADDS the pieces 017 could not deliver. It does not renumber,
-- rewrite, delete or re-run anything.
--
-- -----------------------------------------------------------------------------
-- WHY 017 IS NOT TiDB-SAFE (root cause)
-- -----------------------------------------------------------------------------
-- 1. 017 creates `invoice_return_items` with an index that references a column
--    the same CREATE TABLE never defines:
--
--        KEY `idx_invoice_return_items_invoice` (`original_invoice_no`)
--
--    `original_invoice_no` is absent from the column list above it. MySQL and
--    TiDB both reject the statement (errno 1072 — "Key column
--    'original_invoice_no' doesn't exist in table"), so the table is never
--    created at all.
--
-- 2. 017 then tries to repair itself with a STORED PROCEDURE
--    (`add_original_invoice_no_if_missing`) that adds the column and index
--    afterwards. TiDB Cloud's SQL editor cannot run stored procedures, so even
--    if the CREATE TABLE had succeeded, the repair could not run.
--
-- NET EFFECT on TiDB: `invoice_returns` is created, `invoice_return_items` is
-- not, and `original_invoice_no` — which db/queries/returns.js reads and writes
-- on every return — never lands.
--
-- -----------------------------------------------------------------------------
-- WHAT THIS FILE DOES (additive, idempotent, no procedures)
-- -----------------------------------------------------------------------------
--   * CREATE TABLE IF NOT EXISTS for both tables, declaring
--     `original_invoice_no` in the COLUMN list BEFORE the index that
--     references it — the ordering 017 got wrong.
--   * ALTER ... ADD COLUMN IF NOT EXISTS as a backfill for a database where
--     `invoice_return_items` already exists without the column. ADD COLUMN IF
--     NOT EXISTS is native to TiDB 4.0+, the same convention used by
--     _missing-tidb-fixup.sql and _services_field_values_fixup_tidb.sql.
--
-- Every statement is a no-op on a database that is already correct, so this
-- file is safe to apply to a fresh, partially-migrated or existing database,
-- and safe to re-run.
--
-- RELATIONSHIP TO THE RUNTIME MIGRATION LAYER
-- -----------------------------------------------------------------------------
-- db/runtime-migrations.js (TABLE_MIGRATIONS) creates these same two tables on
-- backend startup with the same column-before-index ordering, so a deployment
-- that never runs this file by hand still converges to this schema. This file
-- is the DBA-facing equivalent for TiDB Cloud's SQL editor.
--
-- The supporting index `idx_invoice_return_items_invoice` is created inline by
-- the CREATE TABLE below for a fresh table. For a PRE-EXISTING table that
-- lacked the column, the runtime layer's probe-guarded migration adds the
-- column AND its index together (TiDB has no `ADD INDEX IF NOT EXISTS`, which
-- is why the index is not repeated as a standalone statement here).
--
-- Run order on TiDB (append to the existing fix-up list):
--   1. _init-tidb.sql
--   2. _missing-tidb-fixup.sql
--   3. _services_industry_fixup_tidb.sql
--   4. _services_field_values_fixup_tidb.sql
--   5. THIS FILE
-- -----------------------------------------------------------------------------

USE `pos_billing`;

-- -----------------------------------------------------------------------------
-- 1. invoice_returns — one header row per return / refund / exchange event.
--    Column set matches 017_retail_returns.sql exactly, including `approved_by`
--    (read by db/queries/returns.js). No forward column references here.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_returns` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `invoice_no` VARCHAR(64) NULL,
  `type` ENUM('return', 'refund', 'exchange', 'cancel') NOT NULL DEFAULT 'return',
  `scope` ENUM('full', 'partial') NOT NULL DEFAULT 'partial',
  `refund_method` ENUM('cash', 'upi', 'card', 'bank_transfer', 'store_credit', 'exchange', 'none') NOT NULL DEFAULT 'cash',
  `replacement_invoice_no` VARCHAR(64) NULL,
  `sub_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `gst_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `grand_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `price_difference` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `reason` VARCHAR(512) NULL,
  `status` ENUM('pending', 'approved', 'rejected', 'completed') NOT NULL DEFAULT 'completed',
  `created_by` BIGINT UNSIGNED NULL,
  `approved_by` BIGINT UNSIGNED NULL,
  `_store_type` VARCHAR(64) NULL,
  `_store_id` VARCHAR(128) NULL,
  `_user_email` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_invoice_returns_invoice_no` (`invoice_no`),
  KEY `idx_invoice_returns_store` (`_store_type`, `_store_id`),
  KEY `idx_invoice_returns_user` (`_user_email`),
  KEY `idx_invoice_returns_status` (`status`),
  KEY `idx_invoice_returns_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 2. invoice_return_items — per-line detail. `original_invoice_no` is declared
--    in the COLUMN list BEFORE `idx_invoice_return_items_invoice`, which is the
--    ordering fix over 017 (017 declared the index without the column).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS `invoice_return_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `return_id` BIGINT UNSIGNED NOT NULL,
  `product_id` BIGINT UNSIGNED NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `original_invoice_no` VARCHAR(64) NULL,
  `original_quantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `returned_quantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `line_discount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `line_gst` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `line_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `condition` ENUM('resalable', 'damaged') NOT NULL DEFAULT 'resalable',
  KEY `idx_invoice_return_items_return` (`return_id`),
  KEY `idx_invoice_return_items_product` (`product_id`),
  KEY `idx_invoice_return_items_invoice` (`original_invoice_no`),
  CONSTRAINT `fk_invoice_return_items_return`
    FOREIGN KEY (`return_id`) REFERENCES `invoice_returns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- -----------------------------------------------------------------------------
-- 3. Backfill for a partially-migrated `invoice_return_items` (the table
--    already exists but the column never landed). No-op when the table was
--    created by step 2 above. TiDB 4.0+ supports ADD COLUMN IF NOT EXISTS.
-- -----------------------------------------------------------------------------
ALTER TABLE `invoice_return_items`
  ADD COLUMN IF NOT EXISTS `original_invoice_no` VARCHAR(64) NULL AFTER `product_name`;
