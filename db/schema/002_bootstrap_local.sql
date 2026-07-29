-- =============================================================================
-- POS Billing — Localhost bootstrap (database + user + grants)
-- -----------------------------------------------------------------------------
-- Run this ONCE on a fresh local MySQL install to create the database and
-- the restricted app user. Skip this file on Railway / PlanetScale / Aiven /
-- Render-managed MySQL — those providers create the database and user for you.
--
-- Usage:
--   mysql -u root -p < schema/002_bootstrap_local.sql
--
-- Then apply the DDL:
--   mysql -u root -p < schema/001_initial_ddl.sql
--
-- The password below is a PLACEHOLDER. Set your real password before running
-- (or change it post-hoc with ALTER USER). The same password must go in
-- server/.env as DB_PASSWORD.
-- =============================================================================
CREATE DATABASE IF NOT EXISTS `pos_billing`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'pos_billing_app'@'localhost'
  IDENTIFIED BY 'CHANGE_ME_app_password';

GRANT SELECT, INSERT, UPDATE, DELETE
  ON `pos_billing`.*
  TO 'pos_billing_app'@'localhost';

FLUSH PRIVILEGES;
