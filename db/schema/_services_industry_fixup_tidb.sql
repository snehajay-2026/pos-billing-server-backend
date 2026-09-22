-- =============================================================================
-- _services_industry_fixup_tidb.sql
--
-- TiDB-only fix-up for the F9 service-catalog columns. Apply this on
-- TiDB Cloud when the SQL Editor rejects the DELIMITER + CREATE PROCEDURE
-- blocks in 015_services_industry_columns.sql (which is the case for some
-- TiDB Cloud SQL Editor tiers). Mirrors the existing
-- _missing-tidb-fixup.sql pattern used for migrations 003-011.
--
-- Safe to re-run on a partially-migrated DB (ADD COLUMN IF NOT EXISTS
-- is native to TiDB 4.0+ and idempotent on the column level).
--
-- The column ORDER and AFTER clauses match
-- 015_services_industry_columns.sql and db/runtime-migrations.js so
-- the schema state is identical regardless of which path applied it.
--
-- Run order on TiDB:
--   1. _init-tidb.sql (creates tables for a fresh DB)
--   2. _missing-tidb-fixup.sql (back-fills 003-011)
--   3. THIS FILE (back-fills 015 / F9)
-- =============================================================================

USE `pos_billing`;

ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `industry` VARCHAR(64) NULL AFTER `category`;
ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `default_template_id` VARCHAR(64) NULL AFTER `industry`;
ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `hsn_sac` VARCHAR(16) NULL AFTER `default_template_id`;
