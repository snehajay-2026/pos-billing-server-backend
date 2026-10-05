-- -----------------------------------------------------------------------------
-- 019_invoice_public_token.sql
--
-- Additive migration: adds a cryptographically random public_token column to
-- the invoices table for non-enumerable public invoice sharing.
--
-- The existing /invoice/{invoiceNo} share link uses a predictable invoice
-- number (SI{year}-{timestamp-slice}) as the sole access identifier. An
-- attacker can enumerate invoice numbers and retrieve any invoice without
-- authentication.
--
-- This migration adds a public_token column (64-char hex string from
-- crypto.randomBytes(32)) that is:
--   - Generated server-side at invoice creation time
--   - Unguessable (256 bits of entropy)
--   - Used in new share links: /invoice/{publicToken}
--
-- Old /invoice/{invoiceNo} links continue to work for backward compatibility.
--
-- Safe to re-run (ADD COLUMN IF NOT EXISTS).
-- No stored procedures. No destructive changes.
-- -----------------------------------------------------------------------------

USE `pos_billing`;

-- Add the public_token column if it doesn't exist.
ALTER TABLE `invoices`
  ADD COLUMN IF NOT EXISTS `public_token` VARCHAR(64) NULL AFTER `invoice_no`;

-- Backfill: generate tokens for existing invoices that don't have one.
-- This MUST be done via a Node.js script using crypto.randomBytes(32),
-- NOT via SQL RAND() which is not cryptographically secure.
--
-- Example Node.js backfill script:
--   const crypto = require('crypto');
--   const { query } = require('./db/pool');
--   const [rows] = await query('SELECT id FROM invoices WHERE public_token IS NULL');
--   for (const row of rows) {
--     const token = crypto.randomBytes(32).toString('hex');
--     await query('UPDATE invoices SET public_token = ? WHERE id = ?', [token, row.id]);
--   }
--
-- Until the backfill runs, old invoices remain accessible via their
-- invoice_no (backward compatibility). New invoices always get a token.
