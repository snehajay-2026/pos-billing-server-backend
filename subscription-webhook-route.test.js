// subscription-webhook-route.test.js
//
// Route-level regression test for the Finding 1 raw-body fix: drives REAL
// HTTP POSTs with RAW JSON BYTES through the REAL middleware stack — the
// shared mountBodyParsers() wiring from lib/webhook-middleware.js plus the
// REAL createWebhookHandler() from lib/subscription-webhook-route.js (the
// same two modules index.js uses in production).
//
// What failed before the fix: with express.json() mounted first, body-parser
// had already consumed the stream (req._body set), so the per-route
// express.raw was a no-op — req.body arrived as a parsed object, HMAC
// verification threw ERR_INVALID_ARG_TYPE, and EVERY delivery 500'd.
//
// What this proves now (no MySQL, no Razorpay network — fakes only):
//   1. a correctly signed POST reaches event processing (activation path
//      runs, HMAC verified against the exact raw bytes on the wire);
//   2. a forged signature is rejected 400 WITHOUT touching any query module;
//   3. a missing signature header is rejected 400 without processing;
//   4. the sibling JSON route still parses normally (global JSON behavior
//      preserved for all non-webhook routes).
//
// The webhook secret here is a throwaway test-only value. It is never a
// real credential, never printed, and never leaves this process.

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const express = require("express");
const http = require("http");

const { WEBHOOK_PATH, mountBodyParsers } = require("./lib/webhook-middleware");
const {
  createWebhookHandler,
} = require("./lib/subscription-webhook-route");

const TEST_SECRET = "whsec_route_test_only_not_a_real_secret";

function signRawBytes(rawBytes) {
  return crypto.createHmac("sha256", TEST_SECRET).update(rawBytes).digest("hex");
}

// Minimal fakes: enough for the payment.captured activation path.
// `touched` records whether event processing ran at all.
function makeFakes() {
  const touched = { queries: 0, updates: 0 };
  const deps = {
    paymentRecordsQueries: {
      findByProviderPaymentId: async () => {
        touched.queries += 1;
        return null;
      },
      create: async (row) => {
        touched.queries += 1;
        return { id: 1, ...row };
      },
    },
    subscriptionsQueries: {
      findByRazorpayId: async () => {
        touched.queries += 1;
        return { id: 7, status: "trialing", startedAt: null, expiresAt: null };
      },
      update: async (id, patch) => {
        touched.updates += 1;
        return { id, ...patch };
      },
    },
    subscriptionEventsQueries: {
      append: async (evt) => {
        touched.queries += 1;
        return { id: 2, ...evt };
      },
    },
    withTransaction: async (fn) => fn({}),
  };
  return { deps, touched };
}

function buildApp(deps) {
  const app = express();
  // THE production wiring, shared — not a copy of it.
  mountBodyParsers(app);
  app.post(WEBHOOK_PATH, createWebhookHandler(deps));
  // Sibling route proving global JSON behavior is preserved.
  app.post("/api/other", (req, res) => {
    res.json({ parsed: req.body });
  });
  return app;
}

function postRaw(port, path, rawBytes, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": rawBytes.length,
          ...headers,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.end(rawBytes);
  });
}

function capturedPayload() {
  return {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: "pay_ROUTE1",
          amount: 49900,
          currency: "INR",
          method: "upi",
          subscription_id: "sub_X",
          captured_at: 1727740800,
        },
      },
    },
  };
}

describe("webhook route through the real middleware stack", () => {
  let server;
  let port;
  let deps;
  let touched;

  before(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = TEST_SECRET;
    ({ deps, touched } = makeFakes());
    const app = buildApp(deps);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
  });

  after(async () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    await new Promise((resolve) => server.close(resolve));
  });

  it("valid signature over the exact wire bytes reaches event processing", async () => {
    // NOTE: signature is computed over the raw Buffer actually sent —
    // byte-identical to what Razorpay signs (no re-serialization).
    const raw = Buffer.from(JSON.stringify(capturedPayload()), "utf8");
    const { status, body } = await postRaw(port, WEBHOOK_PATH, raw, {
      "X-Razorpay-Signature": signRawBytes(raw),
    });
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { received: true });
    // Event processing ran: activation write happened.
    assert.equal(touched.updates, 1);
    assert.ok(touched.queries > 0);
  });

  it("forged signature is rejected 400 without touching any query", async () => {
    const before = { ...touched };
    const raw = Buffer.from(JSON.stringify(capturedPayload()), "utf8");
    const { status, body } = await postRaw(port, WEBHOOK_PATH, raw, {
      "X-Razorpay-Signature": "0".repeat(64),
    });
    assert.equal(status, 400);
    assert.deepEqual(JSON.parse(body), { error: "Invalid signature" });
    assert.deepEqual(touched, before);
  });

  it("missing signature header is rejected 400 without processing", async () => {
    const before = { ...touched };
    const raw = Buffer.from(JSON.stringify(capturedPayload()), "utf8");
    const { status, body } = await postRaw(port, WEBHOOK_PATH, raw);
    assert.equal(status, 400);
    assert.deepEqual(JSON.parse(body), { error: "Missing signature" });
    assert.deepEqual(touched, before);
  });

  it("non-webhook routes still get parsed JSON bodies", async () => {
    const raw = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    const { status, body } = await postRaw(port, "/api/other", raw);
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(body), { parsed: { hello: "world" } });
  });
});
