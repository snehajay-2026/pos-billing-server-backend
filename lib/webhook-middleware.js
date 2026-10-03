// lib/webhook-middleware.js
//
// Body-parser wiring shared by index.js and the route-level regression test
// (subscription-webhook-route.test.js). Kept in one place so the ORDER —
// raw-before-JSON — cannot silently regress in one consumer and not the other.
//
// Why this exists: Razorpay's HMAC signature is computed over the exact raw
// request bytes. A global express.json() mounted first consumes the stream
// and leaves a parsed object on req.body; a later per-route express.raw is
// then a no-op (body-parser skips when req._body is set) and HMAC
// verification throws ERR_INVALID_ARG_TYPE on every delivery. Mounting the
// raw parser for the webhook path FIRST fixes it: body-parser marks the
// request handled, the global JSON parser skips webhook deliveries, and
// every other route keeps normal JSON behavior.

const express = require("express");

const WEBHOOK_PATH = "/api/subscriptions/webhook";

/**
 * Mount body parsers on `app` in the order the webhook requires:
 * raw bytes for the webhook path, JSON for everything else.
 */
function mountBodyParsers(app) {
  app.use(WEBHOOK_PATH, express.raw({ type: "application/json" }));
  app.use(express.json());
}

module.exports = {
  WEBHOOK_PATH,
  mountBodyParsers,
};
