// server/lib/product-images.js
//
// Filesystem layer for product images. Stores files under
// `server/uploads/products/<id>.<ext>` and provides MIME validation
// + size limits matching the Upload Picture UI.
//
// Why a dedicated module: keeps the route handler thin and lets the
// queries/products.js module stay pure SQL. Also makes it easy to swap
// for object storage (S3/R2) later — only this file changes.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// Server-side root for product uploads. Resolved relative to this file
// so it works whether the server is started from the repo root or from
// `server/`. Created on first import.
const UPLOAD_ROOT = path.join(__dirname, "..", "uploads", "products");

const ensureUploadDir = async () => {
  await fsp.mkdir(UPLOAD_ROOT, { recursive: true });
};

// Allowed MIME types (must mirror the frontend validation). Stored as a
// Set for O(1) membership checks. Keep in sync with ProductPage.jsx.
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const MAX_BYTES = 2 * 1024 * 1024; // 2 MB

const mimeToExt = (mime) => {
  switch (mime) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
};

// Generate a short, content-addressed filename so identical uploads
// don't collide and so an attacker can't enumerate other products'
// images by guessing IDs.
const makeFilename = (productId, mime) => {
  const ext = mimeToExt(mime);
  const rand = crypto.randomBytes(6).toString("hex");
  const ts = Date.now();
  return `p${Number(productId) || 0}-${ts}-${rand}.${ext}`;
};

// resolve: turn a stored path into an absolute filesystem path. The
// stored value is either a bare filename (e.g. "p123-1234-abc.jpg") or a
// legacy relative path with the "uploads/products/" prefix written by an
// earlier version of save(). Files actually live directly under
// UPLOAD_ROOT on disk, so we strip the prefix before joining — otherwise
// we'd resolve to <UPLOAD_ROOT>/uploads/products/<file>, a directory
// that doesn't exist, and readForServe would 404 with ENOENT. Returns
// null for any input that tries to escape UPLOAD_ROOT (path traversal
// guard).
const resolveSafe = (stored) => {
  if (!stored) return null;
  // Normalize separators so we can match regardless of OS.
  let rel = String(stored).replace(/\\/g, "/");
  const prefix = "uploads/products/";
  if (rel.startsWith(prefix)) rel = rel.slice(prefix.length);
  const abs = path.isAbsolute(rel) ? rel : path.join(UPLOAD_ROOT, rel);
  const normalized = path.resolve(abs);
  const root = path.resolve(UPLOAD_ROOT);
  if (!normalized.startsWith(root + path.sep) && normalized !== root) {
    return null;
  }
  return normalized;
};

// unlinkIfExists: best-effort delete. Logs but doesn't throw — the
// caller already saved the new state to the DB, and a stale file
// shouldn't block the request.
const unlinkIfExists = async (storedPath) => {
  if (!storedPath) return;
  const abs = resolveSafe(storedPath);
  if (!abs) return;
  try {
    await fsp.unlink(abs);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.warn(`[product-images] unlink failed for ${abs}:`, err.message);
    }
  }
};

// save: write the uploaded buffer to disk and return the relative path
// (the part we store in MySQL). Rejects on bad mime / oversize.
const save = async ({ productId, buffer, mime }) => {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty upload");
  }
  if (!ALLOWED_MIME.has(String(mime || "").toLowerCase())) {
    throw new Error(`Unsupported image type: ${mime}`);
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error(`Image too large (max ${MAX_BYTES / 1024 / 1024} MB)`);
  }
  await ensureUploadDir();
  const filename = makeFilename(productId, mime);
  const abs = path.join(UPLOAD_ROOT, filename);
  await fsp.writeFile(abs, buffer);
  // Stored as a relative path so server restarts / re-paths don't break
  // the link. resolveSafe() resolves it back to an absolute path.
  return {
    imagePath: `uploads/products/${filename}`,
    imageMime: mime,
  };
};

// streamFile: returns a Buffer + mime for a stored path. Used by
// /api/products/:id/image.
const readForServe = async (storedPath) => {
  const abs = resolveSafe(storedPath);
  if (!abs) return null;
  try {
    const buffer = await fsp.readFile(abs);
    const stat = await fsp.stat(abs);
    return { buffer, size: stat.size };
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
};

module.exports = {
  UPLOAD_ROOT,
  ALLOWED_MIME,
  MAX_BYTES,
  save,
  readForServe,
  unlinkIfExists,
  resolveSafe,
};
