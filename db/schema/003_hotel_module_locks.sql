-- -----------------------------------------------------------------------------
-- 003_hotel_module_locks.sql
--
-- Hotel module locks: per-customer toggles that gate access to the Lodging,
-- Dining, and LiveBill workflows. Super Owner can flip any customer's locks;
-- other roles read their own.
--
-- One row per (customerEmail, module). Lookups for /me join on customerEmail;
-- Super Owner's /all query returns every row.
--
-- This migration is idempotent — safe to re-apply.
-- -----------------------------------------------------------------------------

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