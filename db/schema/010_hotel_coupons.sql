-- 010_hotel_coupons.sql
--
-- Hotel Store discount feature: persist coupon codes so cashiers can
-- redeem customer-supplied codes at checkout time. The cashier's
-- `HotelBilling.jsx` flows validate coupons against this table via
-- `GET /api/hotel/coupons/:code` (cashier-facing, scope-filtered).
--
-- Scope isolation mirrors the existing pattern in `invoices` /
-- `hotel_state` / `hotel_bookings`: each row carries `_store_type`,
-- `_store_id`, `_user_email` so the same code can exist under
-- different stores / owners without colliding. `active = 0` is the
-- soft-delete (the Settings UI flips this flag rather than DELETE,
-- so we never lose audit history).
--
-- The unique key is `(code, _store_type, _store_id, _user_email)` —
-- same code can exist across stores, but only one row per scope.
-- `idx_code` covers the bare-code lookups the validator runs.
-- `idx_scope` covers the Settings UI list queries.

CREATE TABLE IF NOT EXISTS hotel_coupons (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  code            VARCHAR(64)  NOT NULL,
  type            ENUM('percent') NOT NULL DEFAULT 'percent',
  value           DECIMAL(5,2) NOT NULL,
  min_subtotal    DECIMAL(10,2) NULL,
  valid_from      DATETIME NULL,
  valid_until     DATETIME NULL,
  active          TINYINT(1)   NOT NULL DEFAULT 1,
  _store_type     VARCHAR(32)  NULL,
  _store_id       VARCHAR(64)  NULL,
  _user_email     VARCHAR(190) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_coupon_scope (code, _store_type, _store_id, _user_email),
  KEY idx_code (code),
  KEY idx_scope (active, _store_type, _store_id, _user_email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;