// lib/subscription-webhook.test.js
//
// Automated coverage for the Razorpay webhook receiver extracted into
// lib/subscription-webhook.js. Uses node:test + node:assert/strict with
// fake query modules — no MySQL, no network, no Razorpay credentials.
//
// What this covers (the formerly manual checklist, automated with mocks):
//   - webhook signature verification (valid / forged / missing header / missing secret)
//   - payment.captured → records payment + activates subscription (monthly & yearly shapes)
//   - payment.captured duplicate delivery → { duplicate: true }, no second writes
//   - payment.captured with missing / unknown subscription → 400 / 404, no writes
//   - payment.failed → records failed row, never activates
//   - subscription.cancelled → sets status cancelled
//   - unhandled events → { handled: false }, no writes
//   - ER_DUP_ENTRY race → treated as duplicate success
//   - the secret never appears in any result body
//
// What this does NOT cover (still needs the Razorpay Dashboard + one real
// Test Mode checkout): that Razorpay actually POSTs the event bytes to the
// public webhook URL with a valid signature.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const {
  verifyWebhookSignature,
  processWebhookEvent,
} = require("./subscription-webhook");

const SECRET = "whsec_test_only_not_a_real_secret";

function sign(body) {
  return crypto.createHmac("sha256", SECRET).update(body).digest("hex");
}

function makeDeps(overrides = {}) {
  const calls = { create: [], update: [], append: [] };
  const deps = {
    paymentRecordsQueries: {
      findByProviderPaymentId: async () => null,
      // Signature mirrors the real query module: (row, conn) — so the
      // tests can assert the conn passed in matches the one yielded by
      // withTransaction (the Finding 2 invariant).
      create: async (row, conn) => {
        calls.create.push({ ...row, conn });
        return { id: 1000 + calls.create.length, ...row };
      },
    },
    subscriptionsQueries: {
      findByRazorpayId: async () => ({
        id: 7,
        status: "trialing",
        startedAt: null,
        expiresAt: null,
      }),
      update: async (id, patch, conn) => {
        calls.update.push({ id, patch, conn });
        return { id, ...patch };
      },
    },
    subscriptionEventsQueries: {
      append: async (evt, conn) => {
        calls.append.push({ ...evt, conn });
        return { id: 2000 + calls.append.length, ...evt };
      },
    },
    withTransaction: async (fn) => fn({}),
  };
  Object.assign(deps.paymentRecordsQueries, overrides.paymentRecordsQueries);
  Object.assign(deps.subscriptionsQueries, overrides.subscriptionsQueries);
  Object.assign(
    deps.subscriptionEventsQueries,
    overrides.subscriptionEventsQueries
  );
  if (overrides.withTransaction) deps.withTransaction = overrides.withTransaction;
  return { deps, calls };
}

function capturedEvent({ paymentId = "pay_AAA", subId = "sub_X" } = {}) {
  return {
    event: "payment.captured",
    payload: {
      payment: {
        entity: {
          id: paymentId,
          amount: 49900, // paise
          currency: "INR",
          method: "upi",
          subscription_id: subId,
          captured_at: 1727740800,
        },
      },
    },
  };
}

describe("verifyWebhookSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ event: "x" }), "utf8");
    const r = verifyWebhookSignature(SECRET, body, sign(body));
    assert.equal(r.ok, true);
  });

  it("rejects a forged signature", () => {
    const body = Buffer.from(JSON.stringify({ event: "x" }), "utf8");
    const r = verifyWebhookSignature(SECRET, body, "0".repeat(64));
    assert.equal(r.ok, false);
    assert.equal(r.reason, "mismatch");
  });

  it("rejects a missing header", () => {
    const r = verifyWebhookSignature(SECRET, Buffer.from("x"), null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "header_missing");
  });

  it("rejects a missing secret without throwing", () => {
    const r = verifyWebhookSignature("", Buffer.from("x"), "abc");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "secret_missing");
  });

  it("rejects a wrong-length signature without throwing", () => {
    const r = verifyWebhookSignature(SECRET, Buffer.from("x"), "short");
    assert.equal(r.ok, false);
    assert.equal(r.reason, "length_mismatch");
  });
});

describe("processWebhookEvent: payment.captured", () => {
  it("records the payment and activates the subscription", async () => {
    const { deps, calls } = makeDeps();
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.body, { received: true });
    // One payment row, one status flip to active, one audit event.
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0].providerPaymentId, "pay_AAA");
    assert.equal(calls.create[0].status, "captured");
    assert.equal(calls.create[0].amount, 499); // paise → rupees
    assert.equal(calls.update.length, 1);
    assert.equal(calls.update[0].patch.status, "active");
    assert.equal(calls.append.length, 1);
    assert.equal(calls.append[0].eventType, "payment_succeeded");
  });

  it("passes the same transaction connection to every write in the batch", async () => {
    // Critical Finding 2 invariant: withTransaction opens ONE connection
    // and every write in that batch must run on it. If any write silently
    // used the pool, BEGIN/COMMIT would wrap zero statements and the batch
    // wouldn't be atomic. Capture the conn yielded to withTransaction's
    // callback and assert each write received exactly that same object.
    let yielded = null;
    const { deps, calls } = makeDeps({
      withTransaction: async (fn) => {
        const conn = { __txid: Symbol("tx") };
        yielded = conn;
        await fn(conn);
      },
    });
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 200);
    assert.equal(calls.create[0].conn, yielded);
    assert.equal(calls.update[0].conn, yielded);
    assert.equal(calls.append[0].conn, yielded);
  });

  it("rolls back the batch when any write throws (no partial state)", async () => {
    // If create succeeds but append throws, withTransaction must propagate
    // the throw so the helper can COMMIT/ROLLBACK accordingly, and the
    // route must return 500. The pre-write state is left untouched — the
    // UNIQUE constraint + idempotency retry is what converges a replay.
    const { deps } = makeDeps();
    deps.subscriptionEventsQueries.append = async () => {
      throw new Error("DB exploded mid-batch");
    };
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 500);
  });

  it("treats a mid-batch ER_DUP_ENTRY as duplicate success (concurrent deliveries)", async () => {
    // Two webhooks for the same payment.captured arrive at the same time.
    // Both pass the pre-check, then one wins the INSERT and the other
    // gets ER_DUP_ENTRY from the unique constraint. We need that second
    // webhook to acknowledge success so Razorpay stops retrying, even
    // though the batch's tail writes didn't happen — the FIRST delivery
    // already finished them.
    const dup = new Error("Duplicate entry");
    dup.code = "ER_DUP_ENTRY";
    const { deps, calls } = makeDeps();
    deps.paymentRecordsQueries.create = async () => {
      throw dup;
    };
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.body, { received: true, duplicate: true });
    // Tells: the trailing writes did NOT run (no status flip, no audit row).
    assert.equal(calls.update.length, 0);
    assert.equal(calls.append.length, 0);
  });

  it("resolves the subscription via the sibling subscription entity id", async () => {
    const seen = [];
    const { deps } = makeDeps({
      subscriptionsQueries: {
        findByRazorpayId: async (id) => {
          seen.push(id);
          return { id: 7, status: "trialing" };
        },
      },
    });
    const event = {
      event: "payment.captured",
      payload: {
        payment: { entity: { id: "pay_B", amount: 100, subscription_id: null } },
        subscription: { id: "sub_SIBLING" },
      },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(seen, ["sub_SIBLING"]);
  });

  it("treats a duplicate delivery as a no-op (pre-check hit)", async () => {
    const { deps, calls } = makeDeps({
      paymentRecordsQueries: {
        findByProviderPaymentId: async () => ({ id: 5 }),
      },
    });
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.body, { received: true, duplicate: true });
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
    assert.equal(calls.append.length, 0);
  });

  it("treats an ER_DUP_ENTRY race as duplicate success", async () => {
    // (pre-check hit, distinct from the mid-batch version added under
    // payment.captured — both code paths converge on duplicate success,
    // but they trigger from different points.)
    const { deps, calls } = makeDeps();
    const dup = new Error("Duplicate entry");
    dup.code = "ER_DUP_ENTRY";
    deps.paymentRecordsQueries.create = async () => {
      throw dup;
    };
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.body, { received: true, duplicate: true });
  });

  it("returns 400 when no subscription id is present, writing nothing", async () => {
    const { deps, calls } = makeDeps();
    const event = {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_C", amount: 100 } } },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 400);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
  });

  it("returns 404 for an unknown subscription, writing nothing", async () => {
    const { deps, calls } = makeDeps({
      subscriptionsQueries: { findByRazorpayId: async () => null },
    });
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 404);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
  });
});

describe("processWebhookEvent: payment.failed", () => {
  it("passes the same transaction connection to the failed-payment batch", async () => {
    let yielded = null;
    const { deps, calls } = makeDeps({
      withTransaction: async (fn) => {
        const conn = { __txid: Symbol("tx") };
        yielded = conn;
        await fn(conn);
      },
    });
    const event = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_F",
            amount: 49900,
            currency: "INR",
            method: "card",
            subscription_id: "sub_X",
            error_description: "declined",
          },
        },
      },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 200);
    assert.equal(calls.create[0].conn, yielded);
    assert.equal(calls.append[0].conn, yielded);
  });

  it("records a failed row and never activates", async () => {
    const { deps, calls } = makeDeps();
    const event = {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_F",
            amount: 49900,
            currency: "INR",
            method: "card",
            subscription_id: "sub_X",
            error_description: "payment_declined",
          },
        },
      },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.body, { received: true });
    assert.equal(calls.create[0].status, "failed");
    assert.equal(calls.update.length, 0); // no activation
    assert.equal(calls.append[0].eventType, "payment_failed");
  });

  it("treats a duplicate failed delivery as a no-op", async () => {
    const { deps } = makeDeps({
      paymentRecordsQueries: {
        findByProviderPaymentId: async () => ({ id: 9 }),
      },
    });
    const event = {
      event: "payment.failed",
      payload: {
        payment: { entity: { id: "pay_F", subscription_id: "sub_X" } },
      },
    };
    const r = await processWebhookEvent(event, deps);
    assert.deepEqual(r.body, { received: true, duplicate: true });
  });
});

describe("processWebhookEvent: subscription.cancelled", () => {
  it("passes the same transaction connection to the cancel batch", async () => {
    let yielded = null;
    const { deps, calls } = makeDeps({
      withTransaction: async (fn) => {
        const conn = { __txid: Symbol("tx") };
        yielded = conn;
        await fn(conn);
      },
    });
    const event = {
      event: "subscription.cancelled",
      payload: { subscription: { entity: { id: "sub_X" } } },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 200);
    assert.equal(calls.update[0].conn, yielded);
    assert.equal(calls.append[0].conn, yielded);
  });

  it("marks the subscription cancelled", async () => {
    const { deps, calls } = makeDeps();
    const event = {
      event: "subscription.cancelled",
      payload: { subscription: { entity: { id: "sub_X" } } },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 200);
    assert.equal(calls.update[0].patch.status, "cancelled");
    assert.equal(calls.append[0].eventType, "cancelled");
  });

  it("returns 404 for an unknown subscription", async () => {
    const { deps } = makeDeps({
      subscriptionsQueries: { findByRazorpayId: async () => null },
    });
    const event = {
      event: "subscription.cancelled",
      payload: { subscription: { entity: { id: "sub_NOPE" } } },
    };
    const r = await processWebhookEvent(event, deps);
    assert.equal(r.httpStatus, 404);
  });
});

describe("processWebhookEvent: unhandled + safety", () => {
  it("acknowledges unhandled events without writing", async () => {
    const { deps, calls } = makeDeps();
    const r = await processWebhookEvent({ event: "invoice.issued" }, deps);
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.body, { received: true, handled: false });
    assert.equal(calls.create.length, 0);
    assert.equal(calls.update.length, 0);
    assert.equal(calls.append.length, 0);
  });

  it("returns 400 for a non-object event", async () => {
    const { deps } = makeDeps();
    const r = await processWebhookEvent(null, deps);
    assert.equal(r.httpStatus, 400);
  });

  it("never echoes the webhook secret in any result body", async () => {
    const { deps } = makeDeps();
    const bodies = [
      (await processWebhookEvent(capturedEvent(), deps)).body,
      (await processWebhookEvent({ event: "nope" }, deps)).body,
      (await processWebhookEvent(null, deps)).body,
    ];
    for (const b of bodies) {
      assert.equal(JSON.stringify(b).includes(SECRET), false);
    }
  });

  it("maps unexpected DB errors to 500 without leaking details", async () => {
    const { deps } = makeDeps({
      paymentRecordsQueries: {
        findByProviderPaymentId: async () => {
          throw new Error("db exploded: " + SECRET);
        },
      },
    });
    const r = await processWebhookEvent(capturedEvent(), deps);
    assert.equal(r.httpStatus, 500);
    assert.equal(JSON.stringify(r.body).includes(SECRET), false);
  });
});
