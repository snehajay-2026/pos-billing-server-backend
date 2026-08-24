-- 011_coupon_usage.sql
--
-- Add usage-limit tracking to hotel_coupons.
--
-- `usage_limit`  INT NULL  — owner-set maximum redemptions. NULL means
--                            unlimited (the pre-existing behavior).
-- `usage_count`  INT NOT NULL DEFAULT 0 — server-bumped atomically in the
--                            same transaction as the invoice insert. Read
--                            by the Settings UI to render "X / N used".
--
-- This file is idempotent (uses INFORMATION_SCHEMA pattern) so it can be
-- re-run safely. Migration 010's CREATE TABLE IF NOT EXISTS does NOT cover
-- this because ALTER TABLE cannot be made conditional without a procedure
-- on the Railway Query tab (which strips multi-statement payloads).

SET @col_exists := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE()
     AND TABLE_NAME   = 'hotel_coupons'
     AND COLUMN_NAME  = 'usage_limit'
);

SET @sql := IF(@col_exists = 0,
  'ALTER TABLE hotel_coupons
     ADD COLUMN usage_limit INT NULL AFTER active,
     ADD COLUMN usage_count INT NOT NULL DEFAULT 0 AFTER usage_limit',
  'SELECT "usage_limit + usage_count already present" AS status');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;