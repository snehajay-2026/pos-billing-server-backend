// db/queries/webhook-events.js
//
// Durable webhook event-ID deduplication (Task 10). Complements the
// UNIQUE(provider_payment_id) payment-level idempotency with an
// event-level guard keyed by the `x-razorpay-event-id` header, so a
// redelivered event never repeats business effects even when its payment
// id differs. Table definition in db/runtime-migrations.js (code only).
//
// Retention: NOT defined here — deployment/product decision (see manual
// migration checklist). Rows must be retained at least as long as the
// provider retry window plus margin.

const { query } = require("../pool");
const TABLE = "webhook_events";

/**
 * Claim an event id inside the caller's transaction. Returns true when
 * this delivery is the first (row inserted), false when a duplicate.
 * Relies on the UNIQUE(event_id) constraint for concurrent deliveries:
 * the loser gets ER_DUP_ENTRY → false.
 */
async function claimEventId(eventId, conn = null) {
  if (!eventId) return true; // no id supplied → fall through to payment idempotency
  const exec = conn ? (sql, params) => conn.query(sql, params) : query;
  try {
    await exec(
      `INSERT INTO ${TABLE} (event_id) VALUES (?)`,
      [String(eventId)]
    );
    return true;
  } catch (err) {
    if (err && err.code === "ER_DUP_ENTRY") return false;
    throw err;
  }
}

async function hasSeen(eventId) {
  if (!eventId) return false;
  const [rows] = await query(
    `SELECT event_id FROM ${TABLE} WHERE event_id = ? LIMIT 1`,
    [String(eventId)]
  );
  return !!(rows && rows.length);
}

module.exports = { TABLE, claimEventId, hasSeen };
