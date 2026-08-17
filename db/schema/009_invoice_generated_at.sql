-- 009_invoice_generated_at.sql
--
-- Persist the exact cashier-perceived moment of invoice generation.
--
-- `invoices.created_at` is stamped server-side by `NOW(3)` at INSERT and
-- is a perfectly fine audit trail, but it reflects the moment the
-- backend received the request — not necessarily the moment the cashier
-- clicked "Generate Invoice". For the Hotel Dining flow we need the
-- cashier's browser-clock moment so the printed receipt and the public
-- share link both display the same instant regardless of which side of
-- the API round-trip captured it.
--
-- The cashier's `HotelBilling.generateAndPreview()` already stamps
-- `new Date()` at click time and sends it as `invoice.generatedAt` (ISO
-- string). Add a nullable DATETIME(3) column so the value round-trips
-- through INSERT → SELECT → rowToInvoice → sanitizePublicInvoice without
-- any further changes to the JSON payload, and the renderer can prefer
-- it over `created_at` when both are present.

ALTER TABLE invoices
  ADD COLUMN `generated_at` DATETIME(3) NULL AFTER `created_at`;
