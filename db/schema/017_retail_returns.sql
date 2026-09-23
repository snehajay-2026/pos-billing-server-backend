-- -----------------------------------------------------------------------------
-- 017_retail_returns.sql
--
-- Returns / Refunds / Exchanges for the Retail store. Hotel, Laundry, and
-- Service workflows are intentionally not touched here — those write into
-- `hotel_state` / `orders` / `services` and have their own settlement paths
-- (hotel checkout / kitchen bills / service delivery). This migration only
-- adds the retail-side surface.
--
-- Two tables:
--   invoice_returns        — header per return/refund/exchange event.
--                            One row per business action. Stores totals,
--                            method, status, audit fields, store scope.
--   invoice_return_items   — per-line items inside a return. Captures
--                            the original invoice line (so over-return is
--                            detected), the returned quantity, restock /
--                            damaged flag (drives stock reconciliation),
--                            and per-line totals.
--
-- Indexes:
--   invoice_returns.invoice_no    — fast lookup of "all returns against
--                                   this invoice" used for over-return
--                                   checks and the history view.
--   invoice_return_items.product_id — the audit / inventory drilldown
--                                   joins through here.
--   _store_type/_store_id on both — multi-tenant row scoping (matches
--                                   every other retail table).
--
-- Both tables use BIGINT UNSIGNED for ids (matches invoices / products /
-- stock_movements) so an existing LEFT JOIN from the inventory module
-- can pick up returns by product_id without cast mismatch.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `invoice_returns` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  -- Source invoice this return is against. Nullable only on rare back-dated
  -- entries; the UI always supplies one. Indexed for the per-invoice history
  -- query (the cashier / admin viewing returns against a single invoice).
  `invoice_no` VARCHAR(64) NULL,
  -- "return" | "refund" | "exchange" | "cancel". Drives what the UI shows:
  --   return  — items taken back, money refunded (full or partial).
  --   refund  — money-only adjustment, no items change hands (e.g. goodwill).
  --   exchange — items swapped, optional price difference handled.
  --   cancel  — full-invoice void before end-of-day close.
  `type` ENUM('return', 'refund', 'exchange', 'cancel') NOT NULL DEFAULT 'return',
  -- "full" | "partial". Pure UI hint — the per-line qty is the real source
  -- of truth (over-return is rejected at the SQL layer).
  `scope` ENUM('full', 'partial') NOT NULL DEFAULT 'partial',
  -- Refund method: how the money went back to the customer.
  --   cash   — physically handed out from the cashier's drawer; the
  --            createReturn path also inserts a `shift_cash_movements`
  --            row with reason='refund:' + ref_type='return' + ref_id=<id>
  --            so expected_cash drops + the bucket in summary.outflows.refund
  --            picks it up automatically.
  --   upi / card / bank_transfer — recorded against the original payment
  --            method; for retail we don't reverse the gateway here, we
  --            just record the liability (the cashier settles via the
  --            actual gateway dashboard).
  --   store_credit — creates a `customer_credits` row keyed to the same
  --            customer_phone so the next invoice can apply it.
  --   exchange — money settled via the replacement invoice, no refund
  --            movement is recorded.
  `refund_method` ENUM('cash', 'upi', 'card', 'bank_transfer', 'store_credit', 'exchange', 'none') NOT NULL DEFAULT 'cash',
  -- For exchanges, the invoice_no of the replacement bill so the cashier can
  -- see "exchange against original X, replacement is Y" in history.
  `replacement_invoice_no` VARCHAR(64) NULL,
  -- Totals. sub_total / gst / grand reflect what was actually returned
  -- (NOT the original invoice's full totals).
  `sub_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `gst_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `grand_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  -- For exchanges, this is the *net* settlement: positive = customer paid
  -- the difference (handed over by card / UPI), negative = cashier handed
  -- out the difference (cash). Zero when the swap is even.
  `price_difference` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  -- Free-text reason from the cashier. Required on damaged items so the
  -- stock_movement audit trail is interpretable later.
  `reason` VARCHAR(512) NULL,
  -- 'pending' until the cashier submits; 'approved' after admin/manager
  -- sign-off (gate is role-based in the route layer, not at the SQL layer
  -- since cashiers can submit and self-approve up to a small value).
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

CREATE TABLE IF NOT EXISTS `invoice_return_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `return_id` BIGINT UNSIGNED NOT NULL,
  -- Mirror of the original invoice line so we don't depend on the JSON
  -- items[] column shape for over-return detection.
  `product_id` BIGINT UNSIGNED NULL,
  `product_name` VARCHAR(255) NOT NULL,
  `original_quantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  -- The original invoice line's quantity — used to compute "how much of
  -- this invoice's stock has already been returned" before letting the
  -- current return submit.
  `returned_quantity` DECIMAL(12, 3) NOT NULL DEFAULT 0,
  `unit_price` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `line_discount` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `line_gst` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  `line_total` DECIMAL(12, 2) NOT NULL DEFAULT 0,
  -- 'resalable' — add the quantity back to products.stock (with a
  -- stock_movement reason='return' for the audit trail).
  -- 'damaged' — write a stock_movement with type='out' reason='damaged'
  -- so the inventory counts the loss but doesn't bump the salable stock.
  `condition` ENUM('resalable', 'damaged') NOT NULL DEFAULT 'resalable',
  KEY `idx_invoice_return_items_return` (`return_id`),
  KEY `idx_invoice_return_items_product` (`product_id`),
  KEY `idx_invoice_return_items_invoice` (`original_invoice_no`),
  CONSTRAINT `fk_invoice_return_items_return`
    FOREIGN KEY (`return_id`) REFERENCES `invoice_returns` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The `original_invoice_no` column for fast "has this product been
-- over-returned?" lookups. MySQL 8 doesn't support ADD COLUMN IF NOT EXISTS,
-- so wrap in a procedure like the low_stock migration in 004_inventory.sql.
DROP PROCEDURE IF EXISTS add_original_invoice_no_if_missing;
CREATE PROCEDURE add_original_invoice_no_if_missing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'invoice_return_items'
      AND COLUMN_NAME = 'original_invoice_no'
  ) THEN
    ALTER TABLE `invoice_return_items`
      ADD COLUMN `original_invoice_no` VARCHAR(64) NULL AFTER `product_name`,
      ADD KEY `idx_invoice_return_items_invoice` (`original_invoice_no`);
  END IF;
END;
CALL add_original_invoice_no_if_missing();
DROP PROCEDURE add_original_invoice_no_if_missing;
