// subscription-lifecycle.authorization.test.js
//
// Task 7: subscription lifecycle audit — test-only, no production behavior
// changes. Ties the lifecycle together end-to-end with fakes (no MySQL, no
// Razorpay network) by exercising the real service, webhook processor, and
// entitlement decision function in sequence.
//
// Lifecycle under test (statuses are exactly those written by current code;
// past_due/expired are ENUM members never written by any writer — see
// require-active-subscription.js state-machine comment):
//   (no row) → create → trialing → payment.captured → active
//            → payment.failed → unchanged → subscription.cancelled → cancelled
//   subscription.charged → acknowledged unhandled, no writes (verified below)
//   payment.captured after cancelled → CURRENTLY reactivates (documents actual
//            behavior; flagged as a product decision, NOT changed here)
//
// Legend used in assertions: LEGACY = current allow is a documented
// backward-compatibility rule (past_due grace, missing-row allow), kept
// verbatim; any tightening needs explicit product approval.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateSubscriptionAccess,
} = require("./lib/require-active-subscription");
const {
  createSubscription,
  cancelSubscription,
  canManageSubscription,
} = require("./lib/subscription-service");
const { processWebhookEvent } = require("./lib/subscription-webhook");

// --- Fakes ------------------------------------------------------------------

const PLAN = {
  id: 3,
  name: "Growth",
  providerPlanId: "plan_monthly",
  providerPlanIdYearly: "plan_yearly",
  monthlyPrice: 499,
  yearlyPrice: 4999,
};

// In-memory subscription row store keyed by local id, mimicking the
// UNIQUE(tenant_email) + status writes the real modules perform.
function makeLifecycleWorld() {
  const rows = new Map(); // id -> row
  const payments = new Map(); // providerPaymentId -> row
  const events = [];
  let nextId = 1;
  const calls = { paymentCreate: 0, subUpdate: 0 };

  const subscriptionsQueries = {
    findById: async (id) => rows.get(id) || null,
    findByRazorpayId: async (rzpId) =>
      [...rows.values()].find((r) => r.razorpaySubscriptionId === rzpId) || null,
    findByTenant: async (tenantEmail) =>
      [...rows.values()].find((r) => r.tenantEmail === tenantEmail) || null,
    create: async (data) => {
      const row = { id: nextId++, ...data };
      rows.set(row.id, row);
      return row;
    },
    update: async (id, patch, conn) => {
      calls.subUpdate++;
      const row = { ...rows.get(id), ...patch };
      rows.set(id, row);
      return row;
    },
  };
  const paymentRecordsQueries = {
    findByProviderPaymentId: async (pid) => payments.get(pid) || null,
    create: async (row, conn) => {
      calls.paymentCreate++;
      payments.set(row.providerPaymentId, { id: payments.size + 1, ...row });
      return payments.get(row.providerPaymentId);
    },
  };
  const subscriptionEventsQueries = {
    append: async (evt, conn) => {
      events.push(evt);
      return { id: events.length, ...evt };
    },
  };
  const razorpay = {
    createSubscription: async () => ({ id: "sub_X", short_url: null }),
    cancelSubscription: async () => ({ ok: true }),
  };
  const deps = {
    plansQueries: { findById: async () => PLAN },
    subscriptionsQueries,
    subscriptionEventsQueries,
    paymentRecordsQueries,
    razorpay,
    razorpayConfig: { keyId: "rzp_test", keySecret: "s" },
    withTransaction: async (fn) => fn({ __conn: true }),
  };
  return { deps, rows, payments, events, calls };
}

const capturedEvent = (paymentId = "pay_1") => ({
  event: "payment.captured",
  payload: {
    payment: {
      entity: {
        id: paymentId,
        amount: 49900,
        currency: "INR",
        method: "card",
        subscription_id: "sub_X",
        captured_at: 1767225600,
      },
    },
  },
});

const ADMIN = { role: "ADMIN", email: "admin@example.com" };

// --- A. Entitlement matrix across the whole lifecycle --------------------------

test("lifecycle entitlement matrix: gate decisions per status and role", () => {
  const allow = (user, subscription) =>
    evaluateSubscriptionAccess({ user, subscription }).allow;

  const active = { status: "active", tenantEmail: ADMIN.email };
  // (1) No subscription record — LEGACY allow, flagged for product decision.
  assert.equal(allow(ADMIN, null), true, "missing row currently allows (LEGACY)");
  // (2) Created but payment pending (trialing) — allowed.
  assert.equal(allow(ADMIN, { ...active, status: "trialing" }), true);
  // (3) Payment succeeded (active) — allowed.
  assert.equal(allow(ADMIN, active), true);
  // (4) Payment failed — failed is record-only, status stays trialing → allowed.
  assert.equal(allow(ADMIN, { ...active, status: "trialing" }), true);
  // (5) Past due — LEGACY grace allow, flagged for product decision.
  assert.equal(allow(ADMIN, { ...active, status: "past_due" }), true, "past_due grace (LEGACY)");
  // (6) Expired — denied.
  assert.equal(allow(ADMIN, { ...active, status: "expired" }), false);
  // (7) Cancelled — denied.
  assert.equal(allow(ADMIN, { ...active, status: "cancelled" }), false);
  // Unknown status — denied forward-compatible.
  assert.equal(allow(ADMIN, { ...active, status: "weird" }), false);

  // (13) SUPER_OWNER bypasses in every state, including cancelled/expired/null.
  for (const sub of [null, active, { ...active, status: "cancelled" }, { ...active, status: "expired" }]) {
    assert.equal(
      allow({ role: "SUPER_OWNER", email: "owner@example.com" }, sub),
      true
    );
  }

  // (7b) STORE_ADMIN/CASHIER inherit the parent tenant's decision exactly.
  const branch = (role) => ({
    role,
    email: `${role.toLowerCase()}@branch.example.com`,
    rootOwnerEmail: ADMIN.email,
  });
  assert.equal(allow(branch("STORE_ADMIN"), active), true);
  assert.equal(allow(branch("CASHIER"), active), true);
  assert.equal(allow(branch("STORE_ADMIN"), { ...active, status: "cancelled" }), false);
  assert.equal(allow(branch("CASHIER"), { ...active, status: "expired" }), false);
});

// --- B. Full webhook lifecycle in sequence -------------------------------------

test("lifecycle sequence: trialing → active → failed(record-only) → cancelled", async () => {
  const { deps, rows } = makeLifecycleWorld();

  // Create → trialing, never active straight from the service.
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  assert.equal(subscription.status, "trialing");

  // payment.captured is the authoritative activation.
  let r = await processWebhookEvent(capturedEvent("pay_1"), deps);
  assert.equal(r.httpStatus, 200);
  assert.equal(rows.get(subscription.id).status, "active");
  assert.ok(rows.get(subscription.id).expiresAt);

  // (8) Duplicate delivery → no-op, single payment row, no second transition.
  r = await processWebhookEvent(capturedEvent("pay_1"), deps);
  assert.deepEqual(r.body, { received: true, duplicate: true });

  // (4) payment.failed → failed row, status untouched (stays active here;
  // on a trialing row it likewise never activates — asserted below).
  r = await processWebhookEvent(
    {
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_2",
            amount: 49900,
            subscription_id: "sub_X",
            error_description: "declined",
          },
        },
      },
    },
    deps
  );
  assert.equal(r.httpStatus, 200);
  assert.equal(rows.get(subscription.id).status, "active");

  // subscription.cancelled → cancelled.
  r = await processWebhookEvent(
    { event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_X" } } } },
    deps
  );
  assert.equal(r.httpStatus, 200);
  assert.equal(rows.get(subscription.id).status, "cancelled");

  // Gate now denies the tenant.
  assert.equal(
    evaluateSubscriptionAccess({ user: ADMIN, subscription: rows.get(subscription.id) }).allow,
    false
  );
});

test("payment.failed on a trialing row never activates", async () => {
  const { deps, rows } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  const r = await processWebhookEvent(
    {
      event: "payment.failed",
      payload: {
        payment: { entity: { id: "pay_F", amount: 49900, subscription_id: "sub_X" } },
      },
    },
    deps
  );
  assert.equal(r.httpStatus, 200);
  assert.equal(rows.get(subscription.id).status, "trialing");
});

// --- subscription.charged (recurring billing) -----------------------------------
//
// Task 10: subscription.charged is now the verified renewal path (was
// acknowledged-unhandled before Task 10). Renewal requires a captured
// payment entity + active provider subscription status; expiry follows
// the monotonic current_end rule with calendar fallback.

const chargedEvent = ({ paymentId = "pay_chg_1", amount = 49900, payStatus = "captured", subStatus = "active", currentEnd = 1772323200 } = {}) => ({
  event: "subscription.charged",
  payload: {
    subscription: { entity: { id: "sub_X", status: subStatus, current_start: 1769644800, current_end: currentEnd, charge_at: 1772323200 } },
    payment: { entity: { id: paymentId, amount, currency: "INR", status: payStatus, method: "card" } },
  },
  created_at: 1769644800,
});

test("subscription.charged renews an active subscription (monotonic expiry, renewed audit)", async () => {
  const { deps, rows, events } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await processWebhookEvent(capturedEvent("pay_1"), deps);
  const eventsBefore = events.length;

  const r = await processWebhookEvent(chargedEvent(), deps);
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.body, { received: true });
  assert.equal(rows.get(subscription.id).status, "active");
  assert.equal(
    rows.get(subscription.id).expiresAt,
    new Date(1772323200 * 1000).toISOString(),
    "expiry set from provider current_end"
  );
  assert.equal(events[events.length - 1].eventType, "renewed");
  assert.ok(events.length > eventsBefore);
});

test("subscription.charged moves past_due to active and clears past_due_since (prior value in audit)", async () => {
  const { deps, rows, events } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await processWebhookEvent(capturedEvent("pay_1"), deps);
  rows.get(subscription.id).status = "past_due";
  rows.get(subscription.id).pastDueSince = "2026-01-01T00:00:00.000Z";

  const r = await processWebhookEvent(chargedEvent({ paymentId: "pay_chg_2" }), deps);
  assert.equal(r.httpStatus, 200);
  const row = rows.get(subscription.id);
  assert.equal(row.status, "active");
  assert.equal(row.pastDueSince, null);
  assert.equal(row.past_due_since, null);
  const audit = events[events.length - 1];
  assert.equal(audit.eventType, "renewed");
  assert.equal(audit.payload.previousPastDueSince, "2026-01-01T00:00:00.000Z");
});

test("subscription.charged with unverified payment is record-only (no status/expiry change)", async () => {
  const { deps, rows } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await processWebhookEvent(capturedEvent("pay_1"), deps);
  const before = { ...rows.get(subscription.id) };
  const r = await processWebhookEvent(
    chargedEvent({ paymentId: "pay_chg_3", payStatus: "failed" }),
    deps
  );
  assert.equal(r.httpStatus, 200);
  assert.equal(rows.get(subscription.id).status, before.status);
  assert.equal(rows.get(subscription.id).expiresAt, before.expiresAt);
});

test("subscription.charged on cancelled/expired is record-only (no reactivation)", async () => {
  const { deps, rows } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await processWebhookEvent(capturedEvent("pay_1"), deps);
  for (const status of ["cancelled", "expired"]) {
    rows.get(subscription.id).status = status;
    const before = { ...rows.get(subscription.id) };
    const r = await processWebhookEvent(
      chargedEvent({ paymentId: `pay_chg_${status}` }),
      deps
    );
    assert.equal(r.httpStatus, 200);
    assert.equal(rows.get(subscription.id).status, status);
    assert.equal(rows.get(subscription.id).expiresAt, before.expiresAt);
  }
});

test("subscription.charged with stale current_end never moves expiry backwards", async () => {
  const { deps, rows } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await processWebhookEvent(capturedEvent("pay_1"), deps);
  // Newer renewal first (June), then a stale April event arrives late.
  await processWebhookEvent(chargedEvent({ paymentId: "pay_new", currentEnd: 1782864000 }), deps);
  const highWater = rows.get(subscription.id).expiresAt;
  const r = await processWebhookEvent(chargedEvent({ paymentId: "pay_stale", currentEnd: 1775000000 }), deps);
  assert.equal(r.httpStatus, 200);
  assert.equal(rows.get(subscription.id).expiresAt, highWater);
});

test("subscription.charged unknown association writes nothing (retryable)", async () => {
  const { deps, calls, rows } = makeLifecycleWorld();
  const writesBefore = calls.paymentCreate + calls.subUpdate;
  const rowsBefore = rows.size;
  const r = await processWebhookEvent(
    {
      event: "subscription.charged",
      payload: {
        subscription: { entity: { id: "sub_UNKNOWN", status: "active", current_end: 1772323200 } },
        payment: { entity: { id: "pay_orphan", amount: 49900, currency: "INR", status: "captured" } },
      },
    },
    deps
  );
  assert.equal(r.httpStatus, 404);
  assert.equal(r.body.retryable, true);
  assert.equal(calls.paymentCreate + calls.subUpdate, writesBefore);
  assert.equal(rows.size, rowsBefore);
});

test("Task 10: payment.captured after cancelled is record-only (no reactivation)", async () => {
  // Task 10 approved rule: late capture on a cancelled row is recorded
  // idempotently; status and expiry never change (no reactivation).
  const { deps, rows } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await processWebhookEvent(
    { event: "subscription.cancelled", payload: { subscription: { entity: { id: "sub_X" } } } },
    deps
  );
  assert.equal(rows.get(subscription.id).status, "cancelled");
  const r = await processWebhookEvent(capturedEvent("pay_late"), deps);
  assert.equal(r.httpStatus, 200);
  assert.equal(
    rows.get(subscription.id).status,
    "cancelled",
    "late capture must not reactivate a cancelled subscription"
  );
});

// --- C. Failure scenarios -------------------------------------------------------

test("transaction failure during webhook processing surfaces 500, no silent partial success", async () => {
  const { deps } = makeLifecycleWorld();
  await createSubscription(deps, { planId: PLAN.id, billingCycle: "monthly", session: ADMIN });
  const failing = { ...deps, withTransaction: async () => { throw new Error("conn lost"); } };
  const r = await processWebhookEvent(capturedEvent("pay_9"), failing);
  assert.equal(r.httpStatus, 500);
  assert.deepEqual(r.body, { error: "Webhook processing failed" });
});

// --- D. Management access while expired/missing + role gates ---------------------

test("cancel works on an expired/cancelled row (no status precondition; renewal path open)", async () => {
  const { deps, rows } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  rows.get(subscription.id).status = "expired";
  const updated = await cancelSubscription(deps, { subscriptionId: subscription.id, session: ADMIN });
  assert.equal(updated.status, "cancelled");
});

test("STORE_ADMIN and CASHIER cannot manage subscriptions (create or cancel)", async () => {
  assert.equal(canManageSubscription("STORE_ADMIN"), false);
  assert.equal(canManageSubscription("CASHIER"), false);
  const { deps } = makeLifecycleWorld();
  const branch = (role) => ({ role, email: "b@branch.example.com", rootOwnerEmail: ADMIN.email });
  for (const role of ["STORE_ADMIN", "CASHIER"]) {
    await assert.rejects(
      createSubscription(deps, { planId: PLAN.id, billingCycle: "monthly", session: branch(role) }),
      (err) => err.code === "FORBIDDEN" && err.status === 403
    );
    await assert.rejects(
      cancelSubscription(deps, { subscriptionId: 1, session: branch(role) }),
      (err) => err.code === "FORBIDDEN" && err.status === 403
    );
  }
});

test("cross-tenant cancel is denied even for ADMIN", async () => {
  const { deps } = makeLifecycleWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  await assert.rejects(
    cancelSubscription(deps, {
      subscriptionId: subscription.id,
      session: { role: "ADMIN", email: "other@example.com" },
    }),
    (err) => err.code === "FORBIDDEN" && err.status === 403
  );
});

test("monthly/yearly select the matching provider plan; missing provider plan fails before any provider call", async () => {
  const { deps } = makeLifecycleWorld();
  let providerCalls = 0;
  const noCall = { ...deps, razorpay: { createSubscription: async () => { providerCalls++; return { id: "sub_X" }; } } };
  // Yearly plan lacking a yearly provider id.
  const monthlyOnly = { ...deps, plansQueries: { findById: async () => ({ ...PLAN, providerPlanIdYearly: null }) } };
  await assert.rejects(
    createSubscription(monthlyOnly, { planId: PLAN.id, billingCycle: "yearly", session: ADMIN }),
    (err) => err.code === "PROVIDER_PLAN_MISSING"
  );
  assert.equal(providerCalls, 0);
  // Both cycles succeed when configured.
  for (const billingCycle of ["monthly", "yearly"]) {
    const { subscription } = await createSubscription(noCall, {
      planId: PLAN.id,
      billingCycle,
      session: ADMIN,
      requestedTenantEmail: undefined,
    });
    assert.equal(subscription.billingCycle, billingCycle);
  }
});
