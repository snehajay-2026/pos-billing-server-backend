-- -----------------------------------------------------------------------------
-- 006_hotel_bookings.sql
--
-- Per-booking storage for hotel tables and rooms. Replaces the JSON-blob
-- approach in hotel_state (where every device read/wrote the same global
-- list with no per-store scoping). Each row is a single booking for a
-- specific store; columns mirror the existing room/table shape so the
-- frontend can store its booking state without translation.
--
-- Kind discriminator:
--   'dining' = dining table booking (table booking, party size, etc.)
--   'lodging' = hotel room booking (room number, guest, folio, etc.)
--
-- Idempotent — safe to re-apply.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `hotel_bookings` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `kind` ENUM('dining', 'lodging') NOT NULL,
  -- Dining-only fields
  `table_id` VARCHAR(64) NULL,
  `table_name` VARCHAR(255) NULL,
  `zone` VARCHAR(64) NULL,
  `party_size` INT UNSIGNED NULL,
  `order_summary` JSON NULL,
  `ordered_menu_items` JSON NULL,
  -- Lodging-only fields
  `room_id` VARCHAR(64) NULL,
  `room_number` VARCHAR(64) NULL,
  -- Shared fields
  `guest_name` VARCHAR(255) NULL,
  `customer_mobile` VARCHAR(32) NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'booked',
  `notes` TEXT NULL,
  `check_in_date` DATE NULL,
  `check_in_time` VARCHAR(16) NULL,
  `expected_check_out` DATE NULL,
  `actual_check_out` DATETIME(3) NULL,
  `created_by` VARCHAR(255) NULL,
  `_store_type` VARCHAR(64) NOT NULL DEFAULT 'hotel',
  `_store_id` VARCHAR(128) NOT NULL DEFAULT 'hotel',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY `idx_hotel_bookings_store` (`_store_type`, `_store_id`),
  KEY `idx_hotel_bookings_kind` (`kind`),
  KEY `idx_hotel_bookings_status` (`status`),
  KEY `idx_hotel_bookings_table` (`table_id`),
  KEY `idx_hotel_bookings_room` (`room_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
