-- 008_invoice_status.sql
--
-- Adds `status` to the `invoices` table so the Invoice Preview "Mark as
-- Cleared" / "Cancel invoice" buttons can persist a status flip on the
-- server. Until now the PUT /api/invoices/:invoiceNo route would accept
-- { status: "cleared" } but the invoices table had no `status` column —
-- the value was silently dropped, the response row carried no status,
-- and the frontend's invoice.status remained undefined so the pill kept
-- showing the "pending" fallback even after a successful round-trip.
--
-- Stored as a free-form VARCHAR(32) (matching the frontend's
-- STATUS_META keys: pending / cleared / paid / cancelled / partial /
-- overdue). We do not constrain via ENUM here because future flows may
-- add new status values without a schema migration.
--
-- Apply (DBA / app user with ALTER rights):
--
--   mysql -u <admin> -p <db> < schema/008_invoice_status.sql
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS is idempotent in MySQL 8+;
-- older MySQL versions can simply ignore the error if the column exists.

ALTER TABLE `invoices`
  ADD COLUMN IF NOT EXISTS `status` VARCHAR(32) NULL AFTER `billed_by`;

-- Existing rows are left NULL — the frontend treats NULL the same as
-- "pending" (its fallback in computeStatus / InvoiceView's currentStatus),
-- so nothing regresses and we don't need a backfill.