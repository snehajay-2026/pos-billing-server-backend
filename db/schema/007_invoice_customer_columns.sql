-- -----------------------------------------------------------------------------
-- 007_invoice_customer_columns.sql
-- Adds customer_name / customer_mobile to the `invoices` table so the guest
-- (customer) name and mobile survive independent of the JSON `items` column.
-- Previously these lived only on the frontend preview payload (hotelDetails /
-- customerName); the DB never stored them, so re-printed saved invoices lost
-- the name and fell back to the store default / "Walking Guest".
--
-- 001_initial_ddl.sql already carries these columns for FRESH installs.
-- This file is for EXISTING deployments that were created before the columns
-- existed. It is idempotent: every statement is a no-op if the target
-- already exists.
--
-- Note: `ADD COLUMN IF NOT EXISTS` requires MySQL 8.0.29+. On older servers,
-- check `information_schema.columns` first (see scripts/migrate-invoice-customer-columns.js,
-- which does exactly that and can be run instead).
-- -----------------------------------------------------------------------------

ALTER TABLE `invoices` ADD COLUMN IF NOT EXISTS `customer_name` VARCHAR(255) NULL AFTER `billed_by`;
ALTER TABLE `invoices` ADD COLUMN IF NOT EXISTS `customer_mobile` VARCHAR(32) NULL AFTER `customer_name`;

-- Backfill from the JSON `items` column. The guest name / mobile were set at
-- booking time on each line item's meta.guest / meta.customerMobile, so we
-- restore them for rows saved before the columns existed. Only fills NULLs so
-- re-running never clobbers newer values.
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
