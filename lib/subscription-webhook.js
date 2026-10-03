// lib/subscription-webhook.js
//
// Pure logic for the Razorpay webhook receiver. Split out from index.js so
// the event-routing, signature-check, idempotency, and DB-mutation rules can
// be unit-tested without booting the server or touching MySQL.
//
// Architecture (unchanged from when this code lived inline in index.js):
//
//   - The HTTP layer (raw body + header) stays in lib/subscription-webhook-route.js.
//     It mounts express.raw, reads the X-Razorpay-Signature header, computes
//     the expected HMAC, extracts x-razorpay-event-id, and only then calls
//     `processWebhookEvent`.
//
//   - `processWebhookEvent(event, deps)` is the pure side: it dispatches
//     on event.event and runs the right branch. Branches:
//       payment.captured (first activation; record-only on cancelled/expired),
//       subscription.charged (verified renewal: record + monotonic expiry +
//         past_due→active with past_due_since clearing),
//       payment.failed (record-only, never starts grace),
//       subscription.cancelled (record-only). Unhandled events return
//     { received: true, handled: false } so Razorpay stops retrying.
//
//   - Activation is the webhook's exclusive job: the verify endpoint
//     (lib/subscription-routes.js) never writes status='active'. Renewal
//     is likewise webhook-exclusive: no other writer sets past_due→active.
//
// Idempotency (two layers):
//   1. Event id: deps.webhookEventsQueries.claimEventId(eventId, conn) inside
//      the transaction. A redelivered event id is a no-op (duplicate: true).
//      Concurrent duplicates converge on the UNIQUE(event_id) constraint
//      (ER_DUP_ENTRY → duplicate). When no event id is supplied (older
//      tests, header absent), this layer is skipped and layer 2 governs.
//   2. Payment id: payment_records.provider_payment_id UNIQUE. A replayed
//      provider payment hits the duplicate key and is a no-op.
//
// Renewal expiry (Task 10 approved rule):
//   - Candidate = payload.subscription.entity.current_end when present and
//     valid (seconds or ms epoch). No skew tolerance is invented.
//   - The expiry write applies only when the candidate is strictly later
//     than the current expiry — stale/out-of-order events never move
//     expiry backwards (payment still recorded idempotently).
//   - Missing/invalid current_end → calendar fallback: max(currentExpiry,
//     eventTime) + one billing cycle on the sticky persisted anchor
//     (lib/subscription-dates.js). Event time prefers the charged payload
//     timestamp, then top-level created_at, then now.
//   - The subscription.entity.status must be 'active' and the payment
//     entity status must be 'captured' before access is granted/restored;
//     otherwise the payment is recorded but status/expiry are untouched.
//   - Cancelled/expired rows: captured payments recorded idempotently,
//     status and expiry never change (no reactivation).
//   - Unknown association: zero subscription-linked writes; the caller
//     maps the 404 to a retryable non-2xx. Structured identifiers are
//     logged without secrets.

const crypto = require("crypto");

const {
  resolveAnchorDay,
  applyMonotonicExpiry,
  fallbackCycleExpiry,
  toDate,
} = require("./subscription-dates");

/**
 * Verify the X-Razorpay-Signature header against the raw request body.
 *
 * Returns { ok: true } on a valid signature, { ok: false, reason } when
 * the secret is missing, the header is missing, or the bytes don't match.
 * Never throws and never echoes the secret.
 *
 * @param {string|null|undefined} secret
 * @param {Buffer|string} rawBody - the exact bytes of the request body
 * @param {string|null|undefined} headerSignature
 */
function verifyWebhookSignature(secret, rawBody, headerSignature) {
  if (!secret) {
    return { ok: false, reason: "secret_missing" };
  }
  if (!headerSignature) {
    return { ok: false, reason: "header_missing" };
  }
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(String(headerSignature), "utf8");
  if (expectedBuf.length !== givenBuf.length) {
    return { ok: false, reason: "length_mismatch" };
  }
  const ok = crypto.timingSafeEqual(expectedBuf, givenBuf);
  return { ok, reason: ok ? "ok" : "mismatch" };
}

/**
 * Parse a provider timestamp that may be epoch seconds, epoch ms, an ISO
 * string, or a Date. Returns a Date or null (never epoch-0 for missing).
 */
function parseEventTime(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const n = Number(v);
  if (Number.isFinite(n)) {
    if (n <= 0) return null;
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return toDate(v);
}
function eventIdOf(event) {
  const v = event?.__eventId;
  if (v == null || v === "") return null;
  return String(v);
}

async function claimEvent(deps, eventId, conn) {
  const q = deps.webhookEventsQueries;
  if (!q || typeof q.claimEventId !== "function") return true; // layer absent → payment idempotency governs
  return q.claimEventId(eventId, conn);
}

/**
 * Process a verified Razorpay webhook event. Pure dependency-injected:
 * every database-touching module is passed in `deps`, so the test can
 * assert on the exact queries issued without booting MySQL.
 *
 * Returns a result object shaped for an Express handler:
 *   { httpStatus: 200, body: { received: true, duplicate?: true } }        success
 *   { httpStatus: 200, body: { received: true, handled: false } }          unhandled event
 *   { httpStatus: 4xx|5xx, body: { error: string } }                       failure
 *   (404 subscription-unknown maps to a retryable non-2xx at the route
 *   layer via retryable:true hint — body stays stable for tests.)
 *
 * Never echoes the webhook secret. Never logs it. Audit-event payloads
 * carry only the fields Razorpay gives us, never the signature.
 *
 * @param {object} event - the parsed JSON body of the webhook
 * @param {object} deps
 * @param {object} deps.paymentRecordsQueries - { findByProviderPaymentId, create }
 * @param {object} deps.subscriptionsQueries - { findByRazorpayId, update }
 * @param {object} deps.subscriptionEventsQueries - { append }
 * @param {object} [deps.webhookEventsQueries] - { claimEventId } (optional)
 * @param {Function} deps.withTransaction - transaction helper (conn => Promise);
 *   the same `conn` it yields must be passed as the 2nd argument to every
 *   write in the batch so the writes share one connection.
 */
async function processWebhookEvent(event, deps) {
  const {
    paymentRecordsQueries,
    subscriptionsQueries,
    subscriptionEventsQueries,
    withTransaction,
  } = deps;

  if (!event || typeof event !== "object") {
    return { httpStatus: 400, body: { error: "Invalid event" } };
  }

  const eventType = event.event;
  const payload =
    event.payload?.payment?.entity || event.payload?.subscription?.entity || {};
  const eventId = eventIdOf(event);

  // Pre-transaction event-id check (fast path for redelivery; the
  // in-transaction claim remains authoritative for races).
  if (eventId && deps.webhookEventsQueries && typeof deps.webhookEventsQueries.hasSeen === "function") {
    try {
      if (await deps.webhookEventsQueries.hasSeen(eventId)) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }
    } catch {
      // Lookup failure → proceed; the in-transaction claim still guards.
    }
  }

  try {
    if (eventType === "payment.captured") {
      const providerPaymentId = payload.id;
      if (!providerPaymentId) {
        return { httpStatus: 400, body: { error: "Missing payment id" } };
      }
      const amount = payload.amount / 100; // Razorpay sends paise
      const currency = payload.currency || "INR";
      const method = payload.method || null;

      // Idempotency check: has this payment already been recorded?
      const existing = await paymentRecordsQueries.findByProviderPaymentId(
        providerPaymentId
      );
      if (existing) {
        return {
          httpStatus: 200,
          body: { received: true, duplicate: true },
        };
      }

      // Find the local subscription. The provider sends the subscription
      // id on the payment entity OR in a sibling subscription entity —
      // both paths are supported so this is robust to Razorpay envelope
      // shape changes.
      const razorpaySubId =
        payload.subscription_id || event.payload?.subscription?.id;
      if (!razorpaySubId) {
        return {
          httpStatus: 400,
          body: { error: "No subscription_id in payment.captured payload" },
        };
      }
      const subscription = await subscriptionsQueries.findByRazorpayId(
        razorpaySubId
      );
      if (!subscription) {
        // Unknown association: zero subscription-linked writes. The route
        // layer maps this to a retryable non-2xx; identifiers logged
        // there without secrets.
        return {
          httpStatus: 404,
          body: { error: "Subscription not found for this payment", retryable: true },
        };
      }

      const terminal = String(subscription.status || "").toLowerCase();
      const recordOnly = terminal === "cancelled" || terminal === "expired";

      // Record the payment and (unless terminal) activate the subscription
      // atomically. Every write runs on the transaction's connection (2nd
      // positional arg, per the shifts.js / coupons.js / invoices.js
      // convention), so a mid-batch failure rolls back the whole event.
      const outcome = await withTransaction(async (conn) => {
        const first = await claimEvent(deps, eventId, conn);
        if (first === false) return { duplicate: true };
        await paymentRecordsQueries.create(
          {
            subscriptionId: subscription.id,
            providerPaymentId,
            amount,
            currency,
            status: "captured",
            method,
          },
          conn
        );
        if (recordOnly) {
          // Late capture on a cancelled/expired row: payment recorded,
          // status and expiry untouched — never reactivates.
          await subscriptionEventsQueries.append(
            {
              subscriptionId: subscription.id,
              eventType: "payment_succeeded",
              payload: { providerPaymentId, amount, currency, method, recordOnly: true },
            },
            conn
          );
          return { recordOnly: true };
        }
        await subscriptionsQueries.update(
          subscription.id,
          {
            status: "active",
            startedAt: subscription.startedAt || new Date().toISOString(),
            expiresAt: payload.captured_at
              ? new Date(payload.captured_at * 1000).toISOString()
              : subscription.expiresAt,
          },
          conn
        );
        await subscriptionEventsQueries.append(
          {
            subscriptionId: subscription.id,
            eventType: "payment_succeeded",
            payload: { providerPaymentId, amount, currency, method },
          },
          conn
        );
        return { recordOnly: false };
      });
      if (outcome && outcome.duplicate) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }

      return { httpStatus: 200, body: { received: true } };
    }

    if (eventType === "subscription.charged") {
      // Verified renewal shape (per supplied sample structure):
      //   payload.subscription.entity.{id,status,current_start,current_end,charge_at}
      //   payload.payment.entity.{id,amount,currency,status,...}
      //   top-level created_at
      const subEntity = event.payload?.subscription?.entity || {};
      const payEntity = event.payload?.payment?.entity || {};
      const razorpaySubId = subEntity.id || event.payload?.subscription?.id;
      const providerPaymentId = payEntity.id;
      if (!razorpaySubId) {
        return { httpStatus: 400, body: { error: "Missing subscription id in subscription.charged payload" } };
      }
      if (!providerPaymentId) {
        return { httpStatus: 400, body: { error: "Missing payment id in subscription.charged payload" } };
      }
      const existing = await paymentRecordsQueries.findByProviderPaymentId(
        providerPaymentId
      );
      if (existing) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }
      const subscription = await subscriptionsQueries.findByRazorpayId(razorpaySubId);
      if (!subscription) {
        return {
          httpStatus: 404,
          body: { error: "Subscription not found for subscription.charged", retryable: true },
        };
      }

      const amount = (payEntity.amount || 0) / 100;
      const currency = payEntity.currency || "INR";
      const method = payEntity.method || null;
      const paymentCaptured = String(payEntity.status || "").toLowerCase() === "captured";
      const subActive = String(subEntity.status || "").toLowerCase() === "active";
      const terminal = ["cancelled", "expired"].includes(
        String(subscription.status || "").toLowerCase()
      );
      const verified = paymentCaptured && subActive;

      // Candidate expiry: provider current_end when present + valid.
      const { expiresAt: monotonicExpiry, moved, candidate } = applyMonotonicExpiry(
        subscription.expiresAt,
        subEntity.current_end
      );
      let nextExpiresAt = moved ? monotonicExpiry : null;
      let fallbackUsed = false;
      // Fallback runs ONLY when the provider sent no usable current_end.
      // A valid-but-stale current_end must never trigger calendar math —
      // that would extend expiry from a stale/out-of-order event.
      if (candidate == null && verified && !terminal) {
        // Calendar fallback: max(currentExpiry, eventTime) + one cycle.
        const evtTime =
          parseEventTime(payEntity.created_at) ||
          parseEventTime(event.created_at) ||
          new Date();
        const anchor = resolveAnchorDay(subscription);
        const fb = fallbackCycleExpiry({
          currentExpiresAt: subscription.expiresAt,
          eventTime: evtTime,
          billingCycle: subscription.billingCycle || subscription.billing_cycle,
          anchorDay: anchor,
        });
        if (fb && (!toDate(subscription.expiresAt) || fb.getTime() > toDate(subscription.expiresAt).getTime())) {
          nextExpiresAt = fb;
          fallbackUsed = true;
        }
      }

      const outcome = await withTransaction(async (conn) => {
        const first = await claimEvent(deps, eventId, conn);
        if (first === false) return { duplicate: true };
        await paymentRecordsQueries.create(
          {
            subscriptionId: subscription.id,
            providerPaymentId,
            amount,
            currency,
            status: paymentCaptured ? "captured" : "failed",
            method,
          },
          conn
        );
        if (!verified || terminal) {
          // Record-only: unverified renewal, or renewal for a
          // cancelled/expired row — never changes status or expiry.
          await subscriptionEventsQueries.append(
            {
              subscriptionId: subscription.id,
              eventType: paymentCaptured ? "payment_succeeded" : "payment_failed",
              payload: {
                providerPaymentId,
                amount,
                currency,
                recordOnly: true,
                reason: terminal ? `subscription ${subscription.status}` : "unverified renewal",
              },
            },
            conn
          );
          return { recordOnly: true };
        }
        const patch = {
          status: "active",
          startedAt: subscription.startedAt || new Date().toISOString(),
        };
        if (nextExpiresAt) patch.expiresAt = nextExpiresAt.toISOString();
        // Clear grace on successful renewal; preserve prior value in audit.
        const prevPastDueSince =
          subscription.pastDueSince ?? subscription.past_due_since ?? null;
        if (String(subscription.status || "").toLowerCase() === "past_due") {
          patch.pastDueSince = null;
          patch.past_due_since = null;
        }
        await subscriptionsQueries.update(subscription.id, patch, conn);
        await subscriptionEventsQueries.append(
          {
            subscriptionId: subscription.id,
            eventType: "renewed",
            payload: {
              providerPaymentId,
              amount,
              currency,
              previousStatus: subscription.status,
              previousPastDueSince: prevPastDueSince,
              expiresAt: nextExpiresAt ? nextExpiresAt.toISOString() : subscription.expiresAt,
              fallbackUsed,
            },
          },
          conn
        );
        return { renewed: true };
      });
      if (outcome && outcome.duplicate) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }
      return { httpStatus: 200, body: { received: true } };
    }

    if (eventType === "payment.failed") {
      const providerPaymentId = payload.id;
      if (!providerPaymentId) {
        return { httpStatus: 400, body: { error: "Missing payment id" } };
      }
      const existing = await paymentRecordsQueries.findByProviderPaymentId(
        providerPaymentId
      );
      if (existing) {
        return {
          httpStatus: 200,
          body: { received: true, duplicate: true },
        };
      }
      const razorpaySubId =
        payload.subscription_id || event.payload?.subscription?.id;
      if (!razorpaySubId) {
        return {
          httpStatus: 400,
          body: { error: "No subscription_id in payment.failed payload" },
        };
      }
      const subscription = await subscriptionsQueries.findByRazorpayId(
        razorpaySubId
      );
      if (!subscription) {
        return { httpStatus: 404, body: { error: "Subscription not found", retryable: true } };
      }
      // Record-only by design: a failed payment never activates and never
      // starts the grace clock (past_due_since untouched — no writer here).
      const outcome = await withTransaction(async (conn) => {
        const first = await claimEvent(deps, eventId, conn);
        if (first === false) return { duplicate: true };
        await paymentRecordsQueries.create(
          {
            subscriptionId: subscription.id,
            providerPaymentId,
            amount: (payload.amount || 0) / 100,
            currency: payload.currency || "INR",
            status: "failed",
            method: payload.method || null,
          },
          conn
        );
        await subscriptionEventsQueries.append(
          {
            subscriptionId: subscription.id,
            eventType: "payment_failed",
            payload: {
              providerPaymentId,
              reason: payload.error_description || "unknown",
            },
          },
          conn
        );
        return { ok: true };
      });
      if (outcome && outcome.duplicate) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }
      return { httpStatus: 200, body: { received: true } };
    }

    if (eventType === "subscription.cancelled") {
      const razorpaySubId = payload.id;
      if (!razorpaySubId) {
        return { httpStatus: 400, body: { error: "Missing subscription id" } };
      }
      const subscription = await subscriptionsQueries.findByRazorpayId(
        razorpaySubId
      );
      if (!subscription) {
        return { httpStatus: 404, body: { error: "Subscription not found", retryable: true } };
      }
      const outcome = await withTransaction(async (conn) => {
        const first = await claimEvent(deps, eventId, conn);
        if (first === false) return { duplicate: true };
        await subscriptionsQueries.update(
          subscription.id,
          {
            status: "cancelled",
          },
          conn
        );
        await subscriptionEventsQueries.append(
          {
            subscriptionId: subscription.id,
            eventType: "cancelled",
            payload: { razorpaySubId },
          },
          conn
        );
        return { ok: true };
      });
      if (outcome && outcome.duplicate) {
        return { httpStatus: 200, body: { received: true, duplicate: true } };
      }
      return { httpStatus: 200, body: { received: true } };
    }

    // Unhandled event type — acknowledge so Razorpay doesn't retry.
    return { httpStatus: 200, body: { received: true, handled: false } };
  } catch (err) {
    // A duplicate-key error means another delivery beat us to it.
    // Treat as success so Razorpay stops retrying. The UNIQUE constraints
    // on payment_records.provider_payment_id and webhook_events.event_id
    // are the enforcement.
    if (err && err.code === "ER_DUP_ENTRY") {
      return { httpStatus: 200, body: { received: true, duplicate: true } };
    }
    return { httpStatus: 500, body: { error: "Webhook processing failed" } };
  }
}

module.exports = {
  verifyWebhookSignature,
  processWebhookEvent,
};
