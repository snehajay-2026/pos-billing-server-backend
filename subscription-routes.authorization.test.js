// subscription-routes.authorization.test.js
//
// Tests for the HTTP route handlers in lib/subscription-routes.js. The
// service is fully faked, so this suite owns ONLY the contract between
// the route and the service:
//
//   - the route forwards planId, billingCycle, session, requestedTenantEmail
//     to subscriptionService.createSubscription / cancelSubscription
//   - the route maps service error codes to HTTP status:
//        FORBIDDEN → 403
//        VALIDATION → 400
//        NOT_FOUND → 404
//        PROVIDER_PLAN_MISSING → 500 with the code echoed back
//        anything else → 500 with a generic message
//   - the response body for create is the local subscription only, not
//     the provider object
//   - the route does NOT pre-filter tenantEmail itself; the service is
//     the single source of truth
//   - planId is coerced to Number
//
// We also verify buildSubscriptionDeps passes the expected shape into the
// service so future maintenance of the wiring has a regression guard.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSubscriptionDeps,
  buildSubscriptionRouteHandlers,
  subscriptionErrorToHttp,
} = require("./lib/subscription-routes");

// --- Fakes ------------------------------------------------------------------

function makeServiceFake() {
  return {
    createCalls: [],
    cancelCalls: [],
    nextCreateError: null,
    nextCancelError: null,
    nextCreateResult: {
      subscription: { id: 99, tenantEmail: "x", status: "trialing" },
      providerSubscription: { id: "sub_x", status: "created" },
    },
    nextCancelResult: { id: 99, status: "cancelled" },
    createSubscription: async function (deps, params) {
      this.createCalls.push({ deps, params });
      if (this.nextCreateError) throw this.nextCreateError;
      return this.nextCreateResult;
    },
    cancelSubscription: async function (deps, params) {
      this.cancelCalls.push({ deps, params });
      if (this.nextCancelError) throw this.nextCancelError;
      return this.nextCancelResult;
    },
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: undefined,
    headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) {
      // Express's res.json defaults to 200 when no explicit status was set.
      if (this.statusCode == null) this.statusCode = 200;
      this.body = b;
      return this;
    },
    set(k, v) { this.headers[k] = v; return this; },
  };
  return res;
}

function makeLogger() {
  return { errors: [], error: (...args) => this.errors.push(args.join(" ")) };
}

const fakeQueries = {
  plans: { findById: () => null },
  subscriptions: { findById: () => null, findByRazorpayId: () => null, create: () => null, update: () => null },
  events: { append: () => null },
};
const fakeRazorpay = {
  createSubscription: () => {},
  cancelSubscription: () => {},
};
// Forward to the real wrapper so the route handler's signature check
// actually exercises the real HMAC. The fake above is a defensive pad —
// the route's create/cancel paths hit the service fake, never this fake.
// Importing the wrapper also pins the API the route relies on.
const realRazorpay = require("./lib/razorpay");
fakeRazorpay.verifySubscriptionSignature = (...args) =>
  realRazorpay.verifySubscriptionSignature(...args);
const fakeRazorpayConfig = { keyId: "rzp_test_123", keySecret: "secret" };

// ===========================================================================
// 1. buildSubscriptionDeps wiring
// ===========================================================================

test("buildSubscriptionDeps exposes plans, subscriptions, events, razorpay, config, withTransaction", () => {
  const withTransaction = async (fn) => fn({});
  const deps = buildSubscriptionDeps({
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
    withTransaction,
  });
  assert.equal(deps.plansQueries, fakeQueries.plans);
  assert.equal(deps.subscriptionsQueries, fakeQueries.subscriptions);
  assert.equal(deps.subscriptionEventsQueries, fakeQueries.events);
  assert.equal(deps.razorpay, fakeRazorpay);
  assert.equal(deps.razorpayConfig, fakeRazorpayConfig);
  assert.equal(deps.withTransaction, withTransaction);
});

// ===========================================================================
// 2. subscriptionErrorToHttp mapping
// ===========================================================================

test("subscriptionErrorToHttp maps FORBIDDEN → 403", () => {
  const res = makeRes();
  subscriptionErrorToHttp(
    Object.assign(new Error("denied"), { code: "FORBIDDEN", status: 403 }),
    res,
    "fallback"
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "denied");
});

test("subscriptionErrorToHttp maps VALIDATION → 400", () => {
  const res = makeRes();
  subscriptionErrorToHttp(
    Object.assign(new Error("bad"), { code: "VALIDATION", status: 400 }),
    res,
    "fallback"
  );
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "bad");
});

test("subscriptionErrorToHttp maps NOT_FOUND → 404", () => {
  const res = makeRes();
  subscriptionErrorToHttp(
    Object.assign(new Error("missing"), { code: "NOT_FOUND", status: 404 }),
    res,
    "fallback"
  );
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.error, "missing");
});

test("subscriptionErrorToHttp maps PROVIDER_PLAN_MISSING → 500 with code echoed", () => {
  const res = makeRes();
  subscriptionErrorToHttp(
    Object.assign(new Error("missing provider plan"), { code: "PROVIDER_PLAN_MISSING" }),
    res,
    "fallback"
  );
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "PROVIDER_PLAN_MISSING");
});

test("subscriptionErrorToHttp maps unknown code to 500 with fallback", () => {
  const res = makeRes();
  subscriptionErrorToHttp(new Error("boom"), res, "fallback message");
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error, "fallback message");
});

// ===========================================================================
// 3. createHandler — delegates to service, forwards request data
// ===========================================================================

test("createHandler forwards planId, billingCycle, session, requestedTenantEmail to the service", async () => {
  const service = makeServiceFake();
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
    withTransaction: async (fn) => fn({}),
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { planId: "5", billingCycle: "monthly", tenantEmail: "attacker@example.com" },
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(service.createCalls.length, 1);
  const call = service.createCalls[0];
  assert.equal(call.params.planId, 5); // coerced to Number
  assert.equal(call.params.billingCycle, "monthly");
  assert.equal(call.params.session.role, "ADMIN");
  // The route does NOT pre-filter tenantEmail — that is the service's job.
  assert.equal(call.params.requestedTenantEmail, "attacker@example.com");
});

test("createHandler response is { subscription, checkout: { shortUrl } }", async () => {
  const service = makeServiceFake();
  service.nextCreateResult = {
    subscription: { id: 99, tenantEmail: "x", status: "trialing" },
    providerSubscription: {
      id: "sub_X",
      status: "created",
      plan_id: "plan_Y",
      short_url: "https://rzp.io/i/test",
      current_start: 1700000000,
      has_scheduled_changes: false,
    },
  };
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "SUPER_OWNER", email: "super@example.com" },
    body: { planId: 5, billingCycle: "yearly" },
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(res.statusCode, 201);
  // Local row is visible
  assert.deepEqual(res.body.subscription, {
    id: 99,
    tenantEmail: "x",
    status: "trialing",
  });
  // Only shortUrl is forwarded — every other provider field is dropped.
  assert.deepEqual(res.body.checkout, { shortUrl: "https://rzp.io/i/test" });
  assert.equal(res.body.providerSubscription, undefined);
  for (const leaked of ["id", "status", "plan_id", "current_start", "has_scheduled_changes"]) {
    assert.equal(res.body.checkout[leaked], undefined, `${leaked} must not be forwarded`);
  }
});

test("createHandler handles missing short_url safely (checkout.shortUrl is null)", async () => {
  const service = makeServiceFake();
  service.nextCreateResult = {
    subscription: { id: 99, status: "trialing" },
    providerSubscription: { id: "sub_X", status: "created" }, // no short_url
  };
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com" },
    body: { planId: 5, billingCycle: "monthly" },
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.checkout.shortUrl, null);
});

test("createHandler never returns keySecret inside the response body", async () => {
  const service = makeServiceFake();
  service.nextCreateResult = {
    subscription: { id: 99, status: "trialing" },
    providerSubscription: {
      id: "sub_X",
      short_url: "https://rzp.io/i/test",
      secret: "this-should-never-leak", // a malicious provider response
    },
  };
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com" },
    body: { planId: 5, billingCycle: "monthly" },
  };
  const res = makeRes();
  await createHandler(req, res);
  // No key from razorpayConfig.keySecret, no field named "secret" or
  // "keySecret" or "authorization" anywhere in the response.
  const json = JSON.stringify(res.body);
  assert.equal(json.includes("secret"), false, "response must not mention 'secret'");
  assert.equal(json.includes(fakeRazorpayConfig.keySecret), false, "keySecret leaked");
});

test("createHandler maps STORE_ADMIN FORBIDDEN → 403", async () => {
  const service = makeServiceFake();
  service.nextCreateError = Object.assign(
    new Error("STORE_ADMIN cannot manage subscriptions — the parent ADMIN tenant owns the subscription"),
    { code: "FORBIDDEN", status: 403 }
  );
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "STORE_ADMIN", email: "store@example.com", rootOwnerEmail: "admin@example.com" },
    body: { planId: 5, billingCycle: "monthly" },
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /STORE_ADMIN/);
});

test("createHandler maps CASHIER FORBIDDEN → 403", async () => {
  const service = makeServiceFake();
  service.nextCreateError = Object.assign(new Error("CASHIER cannot manage subscriptions"), {
    code: "FORBIDDEN", status: 403,
  });
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "CASHIER", email: "cashier@example.com", rootOwnerEmail: "admin@example.com" },
    body: { planId: 5, billingCycle: "monthly" },
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test("createHandler maps VALIDATION → 400", async () => {
  const service = makeServiceFake();
  service.nextCreateError = Object.assign(new Error("planId is required"), {
    code: "VALIDATION", status: 400,
  });
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "SUPER_OWNER", email: "super@example.com" },
    body: {},
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, "planId is required");
});

test("createHandler maps PROVIDER_PLAN_MISSING → 500 with code echoed", async () => {
  const service = makeServiceFake();
  service.nextCreateError = Object.assign(new Error("No Razorpay provider plan ID"), {
    code: "PROVIDER_PLAN_MISSING",
  });
  const { createHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "SUPER_OWNER", email: "super@example.com" },
    body: { planId: 1, billingCycle: "monthly" },
  };
  const res = makeRes();
  await createHandler(req, res);
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.code, "PROVIDER_PLAN_MISSING");
});

// ===========================================================================
// 4. cancelHandler — delegates to service
// ===========================================================================

test("cancelHandler forwards subscriptionId and session to the service", async () => {
  const service = makeServiceFake();
  const { cancelHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    params: { id: "42" },
  };
  const res = makeRes();
  await cancelHandler(req, res);
  assert.equal(service.cancelCalls.length, 1);
  assert.equal(service.cancelCalls[0].params.subscriptionId, 42);
  assert.equal(service.cancelCalls[0].params.session.email, "admin@example.com");
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "cancelled");
});

test("cancelHandler maps FORBIDDEN → 403 (CASHIER)", async () => {
  const service = makeServiceFake();
  service.nextCancelError = Object.assign(new Error("CASHIER cannot manage subscriptions"), {
    code: "FORBIDDEN", status: 403,
  });
  const { cancelHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "CASHIER", email: "cashier@example.com" },
    params: { id: "1" },
  };
  const res = makeRes();
  await cancelHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test("cancelHandler maps NOT_FOUND → 404", async () => {
  const service = makeServiceFake();
  service.nextCancelError = Object.assign(new Error("Subscription not found"), {
    code: "NOT_FOUND", status: 404,
  });
  const { cancelHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    params: { id: "9999" },
  };
  const res = makeRes();
  await cancelHandler(req, res);
  assert.equal(res.statusCode, 404);
});// ===========================================================================
// 5. configHandler — GET /api/subscriptions/config
//
// Returns ONLY the public Razorpay keyId. The keySecret MUST NEVER be
// present in any field of the response, in any error message, or anywhere
// the route layer emits.
// ===========================================================================

function buildHandlersWithService(service, overrides = {}) {
  return buildSubscriptionRouteHandlers({
    subscriptionService: service,
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeQueries.subscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
    ...overrides,
  });
}

test("configHandler returns { keyId } for ADMIN", async () => {
  const { configHandler } = buildHandlersWithService(makeServiceFake());
  const req = { user: { role: "ADMIN", email: "admin@example.com" } };
  const res = makeRes();
  await configHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { keyId: "rzp_test_123" });
});

test("configHandler returns { keyId } for SUPER_OWNER", async () => {
  const { configHandler } = buildHandlersWithService(makeServiceFake());
  const req = { user: { role: "SUPER_OWNER", email: "super@example.com" } };
  const res = makeRes();
  await configHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { keyId: "rzp_test_123" });
});

test("configHandler returns 403 for STORE_ADMIN", async () => {
  const { configHandler } = buildHandlersWithService(makeServiceFake());
  const req = { user: { role: "STORE_ADMIN", email: "store@example.com" } };
  const res = makeRes();
  await configHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.keyId, undefined);
});

test("configHandler returns 403 for CASHIER", async () => {
  const { configHandler } = buildHandlersWithService(makeServiceFake());
  const req = { user: { role: "CASHIER", email: "cashier@example.com" } };
  const res = makeRes();
  await configHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test("configHandler never returns the keySecret in any field", async () => {
  const { configHandler } = buildHandlersWithService(makeServiceFake());
  const req = { user: { role: "ADMIN", email: "admin@example.com" } };
  const res = makeRes();
  await configHandler(req, res);
  const json = JSON.stringify(res.body);
  assert.equal(json.includes(fakeRazorpayConfig.keySecret), false, "keySecret leaked");
  assert.equal("keySecret" in res.body, false, "keySecret key present");
  assert.equal("secret" in res.body, false, "secret key present");
});

test("configHandler returns 503 when keyId is not configured", async () => {
  const { configHandler } = buildHandlersWithService(makeServiceFake(), {
    razorpayConfig: { keyId: "", keySecret: "" },
  });
  const req = { user: { role: "ADMIN", email: "admin@example.com" } };
  const res = makeRes();
  await configHandler(req, res);
  assert.equal(res.statusCode, 503);
});

// ===========================================================================
// 6. verifyHandler — POST /api/subscriptions/verify
//
// Verifies the Razorpay redirect signature. Three security invariants:
//   (a) forged signatures are rejected with 400,
//   (b) wrong-tenant subscriptions are rejected with 403,
//   (c) razorpay_subscription_id mismatch between the redirect and the
//       local subscription row is rejected with 400.
// Three role invariants:
//   (d) STORE_ADMIN and CASHIER cannot verify -> 403,
//   (e) ADMIN can verify own tenant only,
//   (f) SUPER_OWNER can verify any.
// Plus: verified responses MUST NOT mark the subscription active —
// activation is the webhook's job, never the verify endpoint's.
// ===========================================================================

const crypto = require("crypto");

function signedParams({ secret = fakeRazorpayConfig.keySecret, paymentId = "pay_AAA", subscriptionId = "sub_X" } = {}) {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest("hex");
  return { razorpay_payment_id: paymentId, razorpay_subscription_id: subscriptionId, razorpay_signature: signature };
}

function makeSubscriptionsQueriesFake(row) {
  return {
    async findById(id) {
      return row && row.id === id ? row : null;
    },
    async findByRazorpayId(providerId) {
      return row && row.razorpaySubscriptionId === providerId ? row : null;
    },
  };
}

test("verifyHandler: ADMIN can verify own tenant when signature is correct", async () => {
  const events = [];
  const fakeEvents = {
    append: async (e) => { events.push(e); return e; },
  };
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeEvents,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verified, true);
  // Status MUST be the current local status, not flipped to "active".
  assert.equal(res.body.status, "trialing");
  assert.equal(res.body.subscription.id, 42);
  // A payment_verified audit event was recorded.
  assert.equal(events.some((e) => e.eventType === "payment_verified"), true);
  // The signature was never logged or echoed back.
  const json = JSON.stringify(res.body);
  assert.equal(json.includes(req.body.razorpay_signature), false, "signature leaked in response");
});

test("verifyHandler: SUPER_OWNER can verify any tenant", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "other@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "active",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "SUPER_OWNER", email: "super@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verified, true);
});

test("verifyHandler: STORE_ADMIN -> 403", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "STORE_ADMIN", email: "store@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test("verifyHandler: CASHIER -> 403", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "CASHIER", email: "cashier@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test("verifyHandler: forged signature -> 400", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const events = [];
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: {
      append: async (e) => { events.push(e); return e; },
    },
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const good = signedParams();
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: {
      subscriptionId: 42,
      razorpay_payment_id: good.razorpay_payment_id,
      razorpay_subscription_id: good.razorpay_subscription_id,
      razorpay_signature: "0".repeat(64), // forged
    },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.verified, undefined);
  // A failed-verification audit event was recorded (without the forged sig).
  const failed = events.find((e) => e.eventType === "payment_verification_failed");
  assert.ok(failed, "expected a payment_verification_failed audit event");
  assert.equal(JSON.stringify(failed).includes("0".repeat(64)), false, "forged sig was logged");
});

test("verifyHandler: wrong tenant (ADMIN) -> 403", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "other@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 403);
});

test("verifyHandler: forged redirect resolves to no row -> 404", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_REAL",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    // sub_FORGED matches no local row, so the forged redirect resolves to
    // nothing (404) instead of being paired with subscription 42.
    body: { ...signedParams({ subscriptionId: "sub_FORGED" }) },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 404);
  assert.match(res.body.error, /not found/i);
});

test("verifyHandler: legacy subscriptionId that disagrees with resolved row -> 400", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_REAL",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 7, ...signedParams({ subscriptionId: "sub_REAL" }) },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /mismatch/);
});

test("verifyHandler: missing fields -> 400", async () => {
  const { verifyHandler } = buildHandlersWithService(makeServiceFake());
  for (const body of [
    {},
    { razorpay_payment_id: "pay_AAA" },
    { razorpay_payment_id: "pay_AAA", razorpay_subscription_id: "sub_X" },
  ]) {
    const req = {
      user: { role: "ADMIN", email: "admin@example.com" },
      body,
    };
    const res = makeRes();
    await verifyHandler(req, res);
    assert.equal(res.statusCode, 400);
  }
});

test("verifyHandler: no local subscriptionId needed — resolves by provider id", async () => {
  // Regression guard for the external-redirect correlation: the request
  // carries ONLY what survives the Razorpay redirect (the three
  // razorpay_* params) and the handler still resolves the local row.
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { ...signedParams() },
  };
  assert.ok(!("subscriptionId" in req.body), "test must not send a local id");
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.verified, true);
  assert.equal(res.body.subscription.id, 42);
});

test("verifyHandler: subscription not found -> 404", async () => {
  const { verifyHandler } = buildHandlersWithService(makeServiceFake());
  const req = {
    user: { role: "ADMIN", email: "admin@example.com" },
    body: { ...signedParams({ subscriptionId: "sub_UNKNOWN" }) },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 404);
});

test("verifyHandler: misconfigured secret -> 503 (no secret in error)", async () => {
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: fakeSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: { keyId: "rzp_test_123", keySecret: "" },
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.stringify(res.body).includes("secret"), false);
});

test("verifyHandler: success never sets subscription status to active", async () => {
  // The local row reports `trialing`. Even if the signature is perfect,
  // the verify endpoint MUST NOT mutate the row to active — that is the
  // webhook's job. We assert the response echoes the LOCAL status and
  // that subscriptionsQueries.update is never called.
  const fakeSubscriptions = makeSubscriptionsQueriesFake({
    id: 42,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_X",
    status: "trialing",
  });
  let updateCalls = 0;
  const wrappedSubscriptions = {
    async findById(id) {
      return id === 42 ? fakeSubscriptions.findById(id) : null;
    },
    async findByRazorpayId(providerId) {
      return fakeSubscriptions.findByRazorpayId(providerId);
    },
    async update() {
      updateCalls++;
      throw new Error("update MUST NOT be called by verifyHandler");
    },
  };
  const { verifyHandler } = buildSubscriptionRouteHandlers({
    subscriptionService: makeServiceFake(),
    plansQueries: fakeQueries.plans,
    subscriptionsQueries: wrappedSubscriptions,
    subscriptionEventsQueries: fakeQueries.events,
    razorpay: fakeRazorpay,
    razorpayConfig: fakeRazorpayConfig,
  });
  const req = {
    user: { role: "ADMIN", email: "admin@example.com", rootOwnerEmail: "admin@example.com" },
    body: { subscriptionId: 42, ...signedParams() },
  };
  const res = makeRes();
  await verifyHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "trialing");
  assert.equal(updateCalls, 0);
});