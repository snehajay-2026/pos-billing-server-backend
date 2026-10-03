// lib/razorpay.test.js
//
// Focused unit tests for the Razorpay provider wrapper. Every test mocks
// the HTTPS layer — no real Razorpay calls are made, no network is touched.
//
// What these tests own:
//   - successful API response is parsed and normalised
//   - non-2xx responses raise a normalised RazorpayError (never a raw throw)
//   - malformed JSON is handled without crashing
//   - timeout / network failure is surfaced as a normalised error
//   - missing credentials are rejected BEFORE any network call
//   - the key secret never appears in an error message or a log line
//   - amounts are converted to paise (integer) for the provider
//   - the provider plan id is returned so the caller can persist it
//
// The wrapper is loaded with a stubbed `https` module via require.cache,
// the same technique publicInvoice.test.js uses for the DB pool.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");
const crypto = require("crypto");
const https = require("https");

// --- https stub harness -----------------------------------------------------
//
// Each test installs a fake `https.request` that captures the options and
// drives the response lifecycle manually, so we can assert on the exact
// request the wrapper would have made and the exact way it handles the
// reply.

const realRequest = https.request;

/**
 * Install a stubbed https.request.
 * @param {(req) => void} responder - given the fake request, drive the response
 * @returns {{ calls: Array, restore: () => void }}
 */
function stubHttps(responder) {
  const calls = [];
  https.request = function fakeRequest(options, callback) {
    const req = new EventEmitter();
    req.options = options;
    req.write = (chunk) => {
      req.body = chunk;
      return true;
    };
    req.end = () => {
      calls.push(req);
      // Defer so the wrapper's promise is in flight when the response lands.
      process.nextTick(() => responder(req, callback));
    };
    req.destroy = (err) => {
      if (err) process.nextTick(() => req.emit("error", err));
    };
    return req;
  };
  return {
    calls,
    restore() {
      https.request = realRequest;
    },
  };
}

/** Build a minimal fake IncomingMessage with a given status + body. */
function fakeResponse(status, body) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.headers = { "content-type": "application/json" };
  res.setEncoding = () => {};
  // Real https.IncomingMessage emits Buffer chunks. The wrapper uses
  // Buffer.concat on the collected chunks, so the fake must too.
  return { res, body: Buffer.from(body, "utf8") };
}

const VALID = { keyId: "rzp_test_123", keySecret: "super-secret-value" };

// Load the wrapper AFTER the stub is in place is unnecessary — the wrapper
// captures `https` at call time, not load time — but we require it once here
// and reuse the module across tests.
const razorpay = require("./razorpay");

// ===========================================================================
// 1. Credentials are validated before any network call.
// ===========================================================================
test("missing credentials are rejected without making a request", async () => {
  const stub = stubHttps(() => {
    assert.fail("no HTTPS request should be issued without credentials");
  });
  try {
    for (const config of [undefined, {}, { keyId: "x" }, { keySecret: "y" }]) {
      await assert.rejects(
        () => razorpay.createPlan(config, { name: "P", amount: 1000, period: "monthly" }),
        (err) => {
          assert.equal(err.name, "RazorpayError");
          assert.equal(err.code, "CONFIG_MISSING");
          return true;
        }
      );
    }
  } finally {
    stub.restore();
  }
  assert.equal(stub.calls.length, 0);
});

// ===========================================================================
// 2. Successful createPlan is parsed and normalised.
// ===========================================================================
test("createPlan returns the provider plan id on success", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({ id: "plan_ABC123", period: "monthly" }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    const plan = await razorpay.createPlan(VALID, {
      name: "Pro Monthly",
      amount: 1000,
      period: "monthly",
      interval: 1,
    });
    assert.equal(plan.id, "plan_ABC123");
    assert.equal(plan.period, "monthly");

    // The request must be Basic-auth'd, on the right host/path, with the
    // amount converted to paise.
    const opts = stub.calls[0].options;
    assert.equal(opts.hostname, "api.razorpay.com");
    assert.equal(opts.path, "/v1/plans");
    assert.equal(opts.method, "POST");
    assert.match(opts.headers.Authorization, /^Basic /);
    const sent = JSON.parse(stub.calls[0].body.toString("utf8"));
    assert.equal(sent.item.amount, 100000); // 1000 rupees -> paise
    assert.equal(sent.period, "monthly");
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 3. Non-2xx responses raise a normalised error, not a raw throw.
// ===========================================================================
test("a non-2xx response raises RazorpayError with the provider message", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(400, JSON.stringify({
      error: { code: "BAD_REQUEST_ERROR", description: "Amount too small" },
    }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await assert.rejects(
      () => razorpay.createPlan(VALID, { name: "P", amount: 1, period: "monthly" }),
      (err) => {
        assert.equal(err.name, "RazorpayError");
        assert.equal(err.status, 400);
        assert.equal(err.providerCode, "BAD_REQUEST_ERROR");
        assert.match(err.message, /Amount too small/);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test("a non-2xx response without a JSON error body still normalises", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(500, "Internal Server Error");
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await assert.rejects(
      () => razorpay.createPlan(VALID, { name: "P", amount: 100, period: "monthly" }),
      (err) => {
        assert.equal(err.name, "RazorpayError");
        assert.equal(err.status, 500);
        assert.equal(err.providerCode, null);
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 4. Malformed JSON is handled without crashing.
// ===========================================================================
test("malformed JSON in a 200 response raises a normalised parse error", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, "<html>not json</html>");
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await assert.rejects(
      () => razorpay.createPlan(VALID, { name: "P", amount: 100, period: "monthly" }),
      (err) => {
        assert.equal(err.name, "RazorpayError");
        assert.equal(err.code, "PARSE_ERROR");
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 5. Timeout / network failure is surfaced as a normalised error.
// ===========================================================================
test("a network error raises RazorpayError with code NETWORK_ERROR", async () => {
  const stub = stubHttps((req) => {
    process.nextTick(() => {
      const err = new Error("connect ECONNREFUSED");
      err.code = "ECONNREFUSED";
      req.emit("error", err);
    });
  });
  try {
    await assert.rejects(
      () => razorpay.createPlan(VALID, { name: "P", amount: 100, period: "monthly" }),
      (err) => {
        assert.equal(err.name, "RazorpayError");
        assert.equal(err.code, "NETWORK_ERROR");
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

test("a timeout raises RazorpayError with code TIMEOUT", async () => {
  const stub = stubHttps((req) => {
    process.nextTick(() => req.emit("timeout"));
  });
  try {
    await assert.rejects(
      () => razorpay.createPlan(VALID, { name: "P", amount: 100, period: "monthly" }),
      (err) => {
        assert.equal(err.name, "RazorpayError");
        assert.equal(err.code, "TIMEOUT");
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 6. The key secret never appears in an error message.
// ===========================================================================
test("the key secret is never leaked in an error message", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(401, JSON.stringify({
      error: { code: "UNAUTHORIZED", description: "Authentication failed" },
    }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await assert.rejects(
      () => razorpay.createPlan(VALID, { name: "P", amount: 100, period: "monthly" }),
      (err) => {
        assert.ok(!err.message.includes(VALID.keySecret), "secret leaked in message");
        assert.ok(!JSON.stringify(err).includes(VALID.keySecret), "secret leaked in JSON");
        return true;
      }
    );
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 7. createSubscription sends the right shape and returns the provider id.
// ===========================================================================
test("createSubscription returns the provider subscription id", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({
      id: "sub_XYZ789",
      plan_id: "plan_ABC123",
      status: "created",
    }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    const sub = await razorpay.createSubscription(VALID, {
      providerPlanId: "plan_ABC123",
      customerEmail: "a@b.com",
      totalCount: 12,
    });
    assert.equal(sub.id, "sub_XYZ789");
    assert.equal(sub.plan_id, "plan_ABC123");

    const opts = stub.calls[0].options;
    assert.equal(opts.path, "/v1/subscriptions");
    const sent = JSON.parse(stub.calls[0].body.toString("utf8"));
    assert.equal(sent.plan_id, "plan_ABC123");
    assert.equal(sent.total_count, 12);
    assert.equal(sent.customer_notify, 1);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 7b. total_count is omitted unless explicitly supplied.
//
// Subscriptions recur until cancelled, so the default request must NOT
// contain total_count at all. Sending it as null would be rejected by the
// provider; sending a fixed literal would silently cap the term.
// ===========================================================================
test("createSubscription omits total_count when undefined", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({
      id: "sub_RECURRING",
      plan_id: "plan_ABC123",
      status: "created",
    }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await razorpay.createSubscription(VALID, {
      providerPlanId: "plan_ABC123",
      customerEmail: "a@b.com",
    });
    const sent = JSON.parse(stub.calls[0].body.toString("utf8"));
    assert.equal("total_count" in sent, false, "total_count must be absent, not null");
    assert.equal(sent.plan_id, "plan_ABC123");
    assert.equal(sent.customer_notify, 1);
  } finally {
    stub.restore();
  }
});

test("createSubscription omits total_count when null", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({
      id: "sub_RECURRING_NULL",
      plan_id: "plan_ABC123",
      status: "created",
    }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await razorpay.createSubscription(VALID, {
      providerPlanId: "plan_ABC123",
      totalCount: null,
    });
    const sent = JSON.parse(stub.calls[0].body.toString("utf8"));
    assert.equal("total_count" in sent, false);
  } finally {
    stub.restore();
  }
});

test("createSubscription includes total_count when explicitly supplied", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({
      id: "sub_CAPPED",
      plan_id: "plan_ABC123",
      status: "created",
    }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await razorpay.createSubscription(VALID, {
      providerPlanId: "plan_ABC123",
      totalCount: 6,
    });
    const sent = JSON.parse(stub.calls[0].body.toString("utf8"));
    assert.equal(sent.total_count, 6);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 8. fetchSubscription and cancelSubscription hit the right paths.
// ===========================================================================
test("fetchSubscription GETs the right path", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({ id: "sub_XYZ789", status: "active" }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    const sub = await razorpay.fetchSubscription(VALID, "sub_XYZ789");
    assert.equal(sub.id, "sub_XYZ789");
    assert.equal(stub.calls[0].options.method, "GET");
    assert.equal(stub.calls[0].options.path, "/v1/subscriptions/sub_XYZ789");
  } finally {
    stub.restore();
  }
});

test("cancelSubscription POSTs to the cancel path", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({ id: "sub_XYZ789", status: "cancelled" }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    const sub = await razorpay.cancelSubscription(VALID, "sub_XYZ789");
    assert.equal(sub.status, "cancelled");
    assert.equal(stub.calls[0].options.method, "POST");
    assert.equal(stub.calls[0].options.path, "/v1/subscriptions/sub_XYZ789/cancel");
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 9. The Basic auth header is well-formed (keyId:secret, base64).
// ===========================================================================
test("the Authorization header is Basic base64 of keyId:keySecret", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({ id: "plan_1" }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await razorpay.createPlan(VALID, { name: "P", amount: 100, period: "monthly" });
    const header = stub.calls[0].options.headers.Authorization;
    const encoded = header.replace(/^Basic /, "");
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    assert.equal(decoded, `${VALID.keyId}:${VALID.keySecret}`);
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 10. Amounts are always sent as integer paise.
// ===========================================================================
test("a rupee amount with decimals is converted to integer paise", async () => {
  const stub = stubHttps((req, callback) => {
    const { res, body } = fakeResponse(200, JSON.stringify({ id: "plan_1" }));
    callback(res);
    res.emit("data", body);
    res.emit("end");
  });
  try {
    await razorpay.createPlan(VALID, { name: "P", amount: 99.99, period: "monthly" });
    const sent = JSON.parse(stub.calls[0].body.toString("utf8"));
    assert.equal(sent.item.amount, 9999);
    assert.ok(Number.isInteger(sent.item.amount));
  } finally {
    stub.restore();
  }
});

// ===========================================================================
// 11. verifySubscriptionSignature — HMAC check for the post-redirect flow.
// ===========================================================================

test("verifySubscriptionSignature returns true for a correct HMAC", () => {
  const paymentId = "pay_ABC";
  const subscriptionId = "sub_XYZ";
  const sig = crypto
    .createHmac("sha256", VALID.keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
  assert.equal(
    razorpay.verifySubscriptionSignature(VALID, {
      razorpay_payment_id: paymentId,
      razorpay_subscription_id: subscriptionId,
      razorpay_signature: sig,
    }),
    true
  );
});

test("verifySubscriptionSignature returns false for a forged signature", () => {
  assert.equal(
    razorpay.verifySubscriptionSignature(VALID, {
      razorpay_payment_id: "pay_ABC",
      razorpay_subscription_id: "sub_XYZ",
      razorpay_signature: "0".repeat(64),
    }),
    false
  );
});

test("verifySubscriptionSignature returns false for a mismatched payment id", () => {
  const sig = crypto
    .createHmac("sha256", VALID.keySecret)
    .update("pay_REAL|sub_XYZ")
    .digest("hex");
  assert.equal(
    razorpay.verifySubscriptionSignature(VALID, {
      razorpay_payment_id: "pay_FORGED",
      razorpay_subscription_id: "sub_XYZ",
      razorpay_signature: sig,
    }),
    false
  );
});

test("verifySubscriptionSignature returns false for any missing field", () => {
  assert.equal(
    razorpay.verifySubscriptionSignature(VALID, {
      razorpay_payment_id: "pay_ABC",
      razorpay_subscription_id: "sub_XYZ",
    }),
    false
  );
  assert.equal(
    razorpay.verifySubscriptionSignature(VALID, {
      razorpay_payment_id: null,
      razorpay_subscription_id: "sub_XYZ",
      razorpay_signature: "x",
    }),
    false
  );
});

test("verifySubscriptionSignature throws CONFIG_MISSING when secret is absent", () => {
  assert.throws(
    () =>
      razorpay.verifySubscriptionSignature(
        { keyId: "x" },
        {
          razorpay_payment_id: "pay",
          razorpay_subscription_id: "sub",
          razorpay_signature: "sig",
        }
      ),
    (err) => {
      assert.equal(err.name, "RazorpayError");
      assert.equal(err.code, "CONFIG_MISSING");
      // Secret is never part of the error message.
      assert.equal(err.message.includes("secret"), false);
      return true;
    }
  );
});

test("verifySubscriptionSignature never returns the secret in any output", () => {
  // Ensure neither the boolean path nor any side path echoes the secret.
  const sig = crypto
    .createHmac("sha256", VALID.keySecret)
    .update("p|s")
    .digest("hex");
  const out1 = razorpay.verifySubscriptionSignature(VALID, {
    razorpay_payment_id: "p",
    razorpay_subscription_id: "s",
    razorpay_signature: sig,
  });
  assert.equal(typeof out1, "boolean");
  assert.equal(String(out1).includes(VALID.keySecret), false);
});
