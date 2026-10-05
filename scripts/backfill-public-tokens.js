#!/usr/bin/env node
/**
 * backfill-public-tokens.js
 *
 * One-time backfill: generates cryptographically random public_token values
 * for all existing invoices that have NULL public_token.
 *
 * Usage:
 *   node scripts/backfill-public-tokens.js
 *
 * This script is idempotent — it only updates rows where public_token IS NULL.
 * Safe to run multiple times.
 *
 * Uses crypto.randomBytes(32).toString("hex") — 64 hex chars, 256 bits entropy.
 * Does NOT use timestamps, invoice numbers, IDs, or any predictable value.
 */

const crypto = require("crypto");
const { query, pool } = require("../db/pool");

const BATCH_SIZE = 500;

async function backfill() {
  console.log("[backfill-public-tokens] Starting backfill...");

  let totalUpdated = 0;
  let hasMore = true;

  while (hasMore) {
    // Find a batch of invoices without a public_token
    const [rows] = await query(
      `SELECT id FROM invoices WHERE public_token IS NULL LIMIT ${BATCH_SIZE}`
    );

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    for (const row of rows) {
      const token = crypto.randomBytes(32).toString("hex");
      await query("UPDATE invoices SET public_token = ? WHERE id = ?", [
        token,
        row.id,
      ]);
      totalUpdated++;
    }

    console.log(
      `[backfill-public-tokens] Updated ${totalUpdated} invoices so far...`
    );

    if (rows.length < BATCH_SIZE) {
      hasMore = false;
    }
  }

  console.log(
    `[backfill-public-tokens] Done. Total invoices updated: ${totalUpdated}`
  );
}

backfill()
  .then(() => {
    pool.end();
    process.exit(0);
  })
  .catch((err) => {
    console.error("[backfill-public-tokens] Error:", err);
    pool.end();
    process.exit(1);
  });
