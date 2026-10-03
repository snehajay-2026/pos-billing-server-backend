// lib/subscription-webhook-route.js
//
// The Express route handler for POST /api/subscriptions/webhook, extracted
// from index.js so the route-level regression test
// (subscription-webhook-route.test.js) can mount the REAL handler — with the
// REAL body-parser wiring from lib/webhook-middleware.js — on a throwaway
// app and drive it with real HTTP POSTs. No MySQL, no Razorpay network.
//
// index.js wires this with the production query modules; the test wires it
// with fakes and asserts on HTTP status/body. The handler body is identical
// in both cases: Buffer guard → HMAC verify over raw bytes → JSON.parse →
// event-id attach → processWebhookEvent. Response formats are unchanged.
//
// Event id: the `x-razorpay-event-id` header (if present) is attached to the
// parsed event as `__eventId` for durable deduplication in
// processWebhookEvent. It is a routing hint, never trusted identity —
// signature verification already passed before it is read.
//
// Unknown association (subscription not found for a well-formed event):
// zero subscription-linked writes happened; the 404 from the processor is
// mapped to a retryable non-2xx (409 with retryable:true) so the provider
// retries a possibly-early delivery. Structured identifiers are logged
// without secrets. Validation failures (400) stay 4xx non-retryable.

const {
  verifyWebhookSignature,
  processWebhookEvent,
} = require("./subscription-webhook");

/**
 * Build the webhook handler with injected dependencies.
 *
 * @param {object} deps - paymentRecordsQueries, subscriptionsQueries,
 *   subscriptionEventsQueries, webhookEventsQueries (optional),
 *   withTransaction (same shape as processWebhookEvent expects)
 * @param {object} [opts] - { logger } (defaults to console)
 */
function createWebhookHandler(deps, opts = {}) {
  const logger = opts.logger || console;
  return async (req, res) => {
    // req.body must be a Buffer: the raw-body parser is mounted globally
    // ahead of express.json() for this exact path (lib/webhook-middleware.js).
    if (!Buffer.isBuffer(req.body)) {
      return res
        .status(500)
        .json({ error: "Webhook body parser misconfigured" });
    }
    // Verify webhook signature (pure helper; logs nothing secret).
    const check = verifyWebhookSignature(
      process.env.RAZORPAY_WEBHOOK_SECRET,
      req.body,
      req.headers["x-razorpay-signature"]
    );
    if (!check.ok) {
      if (check.reason === "secret_missing") {
        console.error(
          "RAZORPAY_WEBHOOK_SECRET is not set — webhook rejected"
        );
        return res
          .status(500)
          .json({ error: "Webhook secret not configured" });
      }
      if (check.reason === "header_missing") {
        return res.status(400).json({ error: "Missing signature" });
      }
      return res.status(400).json({ error: "Invalid signature" });
    }

    let event;
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    const headerEventId = req.headers["x-razorpay-event-id"];
    if (event && typeof event === "object" && headerEventId != null && headerEventId !== "") {
      event.__eventId = String(headerEventId);
    }

    // Pure event processor (status mutations, idempotency, audit rows).
    const result = await processWebhookEvent(event, deps).catch((err) => {
      console.error(
        "Webhook processing error:",
        err && err.code ? err.code : err
      );
      return { httpStatus: 500, body: { error: "Webhook processing failed" } };
    });
    if (result && result.httpStatus === 404 && result.body && result.body.retryable) {
      // Retryable: log structured identifiers only (no secrets, no bodies).
      try {
        logger.warn?.("[webhook] unknown subscription association", {
          event: event && event.event,
          eventId: headerEventId || null,
        });
      } catch {
        // logging must never break the response
      }
      return res.status(409).json({ error: result.body.error || "Unknown subscription", retryable: true });
    }
    return res.status(result.httpStatus).json(result.body);
  };
}

module.exports = {
  createWebhookHandler,
};
