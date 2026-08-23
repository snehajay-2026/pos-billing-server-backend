-- -----------------------------------------------------------------------------
-- 009_product_images.sql
--
-- Adds an image reference to the `products` table for the Upload Picture
-- feature. Idempotent — safe to re-apply. Uses the same procedure pattern
-- as 004_inventory.sql because MySQL 8 doesn't support
-- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
--
-- Columns:
--   image_path  — relative path on the backend's filesystem under
--                 server/uploads/products/<id>.<ext>.
--   image_mime  — MIME type (jpg/png/webp/gif) so the server can serve
--                 the file with the correct Content-Type.
--
-- The frontend computes an absolute URL of the form
-- `/api/products/<id>/image` from `image_path`-presence, so no URL
-- column is needed.
-- -----------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS add_product_image_if_missing;
CREATE PROCEDURE add_product_image_if_missing()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'image_path'
  ) THEN
    ALTER TABLE `products` ADD COLUMN `image_path` VARCHAR(255) NULL AFTER `unit`;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'products'
      AND COLUMN_NAME = 'image_mime'
  ) THEN
    ALTER TABLE `products` ADD COLUMN `image_mime` VARCHAR(64) NULL AFTER `image_path`;
  END IF;
END;
CALL add_product_image_if_missing();
DROP PROCEDURE add_product_image_if_missing;
