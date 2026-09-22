-- =============================================================================
-- _services_field_values_fixup_tidb.sql
--
-- TiDB-only fix-up for the F10 service-catalog `field_values` column.
-- Apply this on TiDB Cloud when the SQL Editor rejects the DELIMITER +
-- CREATE PROCEDURE blocks in 016_services_field_values.sql (which is
-- the case for some TiDB Cloud SQL Editor tiers). Mirrors the existing
-- _missing-tidb-fixup.sql and _services_industry_fixup_tidb.sql
-- patterns used for prior migrations.
--
-- Safe to re-run on a partially-migrated DB (ADD COLUMN IF NOT EXISTS
-- is native to TiDB 4.0+ and idempotent on the column level).
--
-- Run order on TiDB:
--   1. _init-tidb.sql (creates tables for a fresh DB)
--   2. _missing-tidb-fixup.sql (back-fills 003-011)
--   3. _services_industry_fixup_tidb.sql (back-fills 015 / F9)
--   4. THIS FILE (back-fills 016 / F10)
-- =============================================================================

USE `pos_billing`;

ALTER TABLE `services` ADD COLUMN IF NOT EXISTS `field_values` LONGTEXT NULL AFTER `hsn_sac`;
