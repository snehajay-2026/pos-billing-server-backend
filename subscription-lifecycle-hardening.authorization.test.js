// subscription-lifecycle-hardening.authorization.test.js
//
// Task 10: lifecycle hardening — grace boundary, anchors, dedup, allowlist.
//
// Focused coverage for the Task 10 rules, using fakes only (no MySQL, no
// Razorpay network). Deterministic clocks via injected `now`.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  evaluateSubscriptionAccess,
} = require("./lib/require-active-subscription");
const { processWebhookEvent } = require("./lib/subscription-webhook");
const {
  GRACE_MS,
  addCalendarCycle,
  applyMonotonicExpiry,
  canonicalizeTenantKey,
  resolveAnchorDay,
} = require("./lib/subscription-dates");
const { makeMemoryAllowlist } = require("./lib/legacy-allowlist");
const {
  createSubscription,
} = require("./lib/subscription-service");

const ADMIN = { role: "ADMIN", email: "admin@example.com" };
const PLAN = {
  id: 3,
  name: "Growth",
  providerPlanId: "plan_monthly",
  providerPlanIdYearly: "plan_yearly",
  monthlyPrice: 499,
  yearlyPrice: 4999,
};

function makeWorld() {
  const rows = new Map();
  const payments = new Map();
  const events = [];
  const seenEvents = new Set();
  let nextId = 1;
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
    update: async (id, patch) => {
      const row = { ...rows.get(id), ...patch };
      rows.set(id, row);
      return row;
    },
  };
  const deps = {
    plansQueries: { findById: async () => PLAN },
    subscriptionsQueries,
    subscriptionEventsQueries: {
      append: async (evt, conn) => {
        events.push(evt);
        return { id: events.length, ...evt };
      },
    },
    paymentRecordsQueries: {
      findByProviderPaymentId: async (pid) => payments.get(pid) || null,
      create: async (row, conn) => {
        if ([...payments.values()].some((p) => p.providerPaymentId === row.providerPaymentId)) {
          const err = new Error("Duplicate entry");
          err.code = "ER_DUP_ENTRY";
          throw err;
        }
        payments.set(row.providerPaymentId, { id: payments.size + 1, ...row });
        return payments.get(row.providerPaymentId);
      },
    },
    webhookEventsQueries: {
      hasSeen: async (eid) => seenEvents.has(String(eid)),
      claimEventId: async (eid, conn) => {
        const k = String(eid);
        if (seenEvents.has(k)) return false;
        seenEvents.add(k);
        return true;
      },
    },
    razorpay: {
      createSubscription: async () => ({ id: "sub_X", short_url: null }),
      cancelSubscription: async () => ({ ok: true }),
    },
    razorpayConfig: { keyId: "rzp_test", keySecret: "s" },
    withTransaction: async (fn) => fn({ __conn: true }),
  };
  return { deps, rows, payments, events, seenEvents };
}

const charged = ({ paymentId = "pay_h1", currentEnd = 1772323200 } = {}) => ({
  event: "subscription.charged",
  __eventId: `evt-${paymentId}`,
  payload: {
    subscription: { entity: { id: "sub_X", status: "active", current_start: 1769644800, current_end: currentEnd } },
    payment: { entity: { id: paymentId, amount: 49900, currency: "INR", status: "captured" } },
  },
  created_at: 1769644800,
});

// --- Grace boundary ----------------------------------------------------------

test("past_due allows before +7d, denies at and after the boundary", () => {
  const since = new Date("2026-01-01T00:00:00.000Z").getTime();
  const sub = { status: "past_due", tenantEmail: ADMIN.email, pastDueSince: new Date(since).toISOString() };
  assert.equal(
    evaluateSubscriptionAccess({ user: ADMIN, subscription: sub, legacyAllowMissing: false, now: new Date(since + GRACE_MS - 1000) }).allow,
    true
  );
  assert.equal(
    evaluateSubscriptionAccess({ user: ADMIN, subscription: sub, legacyAllowMissing: false, now: new Date(since + GRACE_MS) }).allow,
    false,
    "deny exactly at now >= past_due_since + 7 days"
  );
  assert.equal(
    evaluateSubscriptionAccess({ user: ADMIN, subscription: sub, legacyAllowMissing: false, now: new Date(since + GRACE_MS + 1000) }).allow,
    false
  );
});

test("failed payment never sets past_due_since (no grace writer in failed path)", async () => {
  const { deps, rows } = makeWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  const r = await processWebhookEvent(
    {
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_F1", amount: 49900, subscription_id: "sub_X" } } },
    },
    deps
  );
  assert.equal(r.httpStatus, 200);
  const row = rows.get(subscription.id);
  assert.equal(row.status, "trialing");
  assert.ok(row.pastDueSince == null && row.past_due_since == null);
});

// --- Anchors ------------------------------------------------------------------

test("sticky monthly anchors: 29/30/31 clamp then restore", () => {
  assert.equal(addCalendarCycle("2026-01-31T00:00:00.000Z", "monthly", 31).toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(addCalendarCycle("2026-02-28T00:00:00.000Z", "monthly", 31).toISOString(), "2026-03-31T00:00:00.000Z");
  assert.equal(addCalendarCycle("2026-01-30T00:00:00.000Z", "monthly", 30).toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(addCalendarCycle("2026-01-29T00:00:00.000Z", "monthly", 29).toISOString(), "2026-02-28T00:00:00.000Z");
});

test("yearly leap anchor: Feb 29 → Feb 28 non-leap, restored in leap years", () => {
  assert.equal(addCalendarCycle("2024-02-29T00:00:00.000Z", "yearly", 29).toISOString(), "2025-02-28T00:00:00.000Z");
  // Anchor preserved across the non-leap year: 2028 is a leap year again.
  assert.equal(addCalendarCycle("2027-02-28T00:00:00.000Z", "yearly", 29).toISOString(), "2028-02-29T00:00:00.000Z");
});

test("creation persists billingAnchorDay; renewal never mutates it", async () => {
  const { deps, rows } = makeWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  const anchor = rows.get(subscription.id).billingAnchorDay;
  assert.ok(anchor >= 1 && anchor <= 31);
  await processWebhookEvent(
    {
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_A1", amount: 49900, subscription_id: "sub_X", captured_at: 1767225600 } } },
    },
    deps
  );
  await processWebhookEvent(charged({ paymentId: "pay_h_anchor" }), deps);
  assert.equal(rows.get(subscription.id).billingAnchorDay, anchor);
});

test("resolveAnchorDay falls back to startedAt day (documented, flagged as shifted-unsafe)", () => {
  assert.equal(resolveAnchorDay({ startedAt: "2026-01-31T00:00:00.000Z" }), 31);
  assert.equal(resolveAnchorDay({ billingAnchorDay: 15, startedAt: "2026-01-31T00:00:00.000Z" }), 15);
});

// --- Monotonic expiry ----------------------------------------------------------

test("applyMonotonicExpiry ignores stale candidates, accepts forward ones", () => {
  const cur = "2026-06-30T00:00:00.000Z";
  const stale = applyMonotonicExpiry(cur, Date.parse("2026-05-01T00:00:00.000Z") / 1000);
  assert.equal(stale.moved, false);
  assert.equal(stale.expiresAt.toISOString(), cur);
  const fwd = applyMonotonicExpiry(cur, Date.parse("2026-07-31T00:00:00.000Z") / 1000);
  assert.equal(fwd.moved, true);
});

// --- Event-id + payment-id dedup ------------------------------------------------

test("duplicate event id is a no-op without repeating effects", async () => {
  const { deps, rows, payments } = makeWorld();
  await createSubscription(deps, { planId: PLAN.id, billingCycle: "monthly", session: ADMIN });
  const evt = charged({ paymentId: "pay_dup" });
  const first = await processWebhookEvent(evt, deps);
  assert.equal(first.httpStatus, 200);
  const countAfterFirst = payments.size;
  const second = await processWebhookEvent({ ...evt }, deps);
  assert.deepEqual(second.body, { received: true, duplicate: true });
  assert.equal(payments.size, countAfterFirst);
  assert.ok(rows.size > 0);
});

test("same payment id under a different event id is still a duplicate", async () => {
  const { deps, payments } = makeWorld();
  await createSubscription(deps, { planId: PLAN.id, billingCycle: "monthly", session: ADMIN });
  await processWebhookEvent(charged({ paymentId: "pay_same" }), deps);
  const r = await processWebhookEvent(
    { ...charged({ paymentId: "pay_same" }), __eventId: "evt-other" },
    deps
  );
  assert.deepEqual(r.body, { received: true, duplicate: true });
  assert.equal(payments.size, 1);
});

test("concurrent duplicate delivery converges via ER_DUP_ENTRY", async () => {
  const { deps, payments } = makeWorld();
  await createSubscription(deps, { planId: PLAN.id, billingCycle: "monthly", session: ADMIN });
  // Two deliveries race: the second claim loses inside one shared tx view.
  // Simulate by pre-seeding the payment row between pre-check and create.
  const evt = charged({ paymentId: "pay_race" });
  const origCreate = deps.paymentRecordsQueries.create;
  let raced = false;
  deps.paymentRecordsQueries.create = async (row, conn) => {
    if (!raced) {
      raced = true;
      payments.set(row.providerPaymentId, { id: 999, ...row }); // concurrent winner
    }
    return origCreate(row, conn);
  };
  const r = await processWebhookEvent(evt, deps);
  assert.equal(r.httpStatus, 200);
  assert.deepEqual(r.body, { received: true, duplicate: true });
});

test("rollback: failed batch leaves zero partial rows", async () => {
  const { deps, payments, events } = makeWorld();
  await createSubscription(deps, { planId: PLAN.id, billingCycle: "monthly", session: ADMIN });
  const eventsBefore = events.length; // 'created' audit from setup
  const failing = {
    ...deps,
    withTransaction: async () => {
      throw new Error("conn lost");
    },
  };
  const r = await processWebhookEvent(charged({ paymentId: "pay_rb" }), failing);
  assert.equal(r.httpStatus, 500);
  assert.equal(payments.size, 0);
  assert.equal(events.length, eventsBefore);
});

// --- Missing/invalid current_end fallback ---------------------------------------

test("missing current_end uses calendar fallback with persisted anchor", async () => {
  const { deps, rows } = makeWorld();
  const { subscription } = await createSubscription(deps, {
    planId: PLAN.id,
    billingCycle: "monthly",
    session: ADMIN,
  });
  rows.get(subscription.id).status = "active";
  rows.get(subscription.id).expiresAt = "2026-03-31T00:00:00.000Z";
  rows.get(subscription.id).billingAnchorDay = 31;
  const r = await processWebhookEvent(
    {
      event: "subscription.charged",
      __eventId: "evt-nocurrend",
      payload: {
        subscription: { entity: { id: "sub_X", status: "active" } }, // no current_end
        payment: { entity: { id: "pay_fb1", amount: 49900, currency: "INR", status: "captured" } },
      },
      created_at: Date.parse("2026-03-31T00:00:00.000Z") / 1000,
    },
    deps
  );
  assert.equal(r.httpStatus, 200);
  // Anchor 31 from March 31 → April 30 (April has 30 days).
  assert.equal(rows.get(subscription.id).expiresAt, "2026-04-30T00:00:00.000Z");
});

// --- Allowlist -------------------------------------------------------------------

test("missing row: allowlisted tenant allowed, others denied, lookup failure closed", () => {
  const allowlist = makeMemoryAllowlist(["admin@example.com"]);
  assert.equal(
    evaluateSubscriptionAccess({ user: ADMIN, subscription: null, legacyAllowMissing: false, legacyAllowlist: allowlist }).allow,
    true
  );
  assert.equal(
    evaluateSubscriptionAccess({
      user: { role: "ADMIN", email: "other@example.com" },
      subscription: null,
      legacyAllowMissing: false,
      legacyAllowlist: allowlist,
    }).allow,
    false
  );
  const broken = { isAllowlisted: () => { throw new Error("db down"); } };
  assert.equal(
    evaluateSubscriptionAccess({ user: ADMIN, subscription: null, legacyAllowMissing: false, legacyAllowlist: broken }).allow,
    false
  );
});

test("canonicalizeTenantKey folds branch users and lowercases", () => {
  assert.equal(canonicalizeTenantKey({ email: "B@Branch.Example.COM", rootOwnerEmail: "Admin@A.Example.COM" }), "admin@a.example.com");
  assert.equal(canonicalizeTenantKey("  X@Example.COM "), "x@example.com");
  assert.equal(canonicalizeTenantKey(null), null);
});

test("SUPER_OWNER bypass holds across every status including past_due/cancelled/null", () => {
  const owner = { role: "SUPER_OWNER", email: "owner@example.com" };
  for (const sub of [null, { status: "active" }, { status: "past_due", pastDueSince: new Date().toISOString() }, { status: "cancelled" }, { status: "expired" }]) {
    assert.equal(evaluateSubscriptionAccess({ user: owner, subscription: sub }).allow, true);
  }
});

test("branch roles inherit the parent decision exactly (past_due in-grace allow, expired deny)", () => {
  const since = new Date(Date.now() - 1000).toISOString();
  const branch = (role) => ({ role, email: `${role}@branch.example.com`, rootOwnerEmail: ADMIN.email });
  assert.equal(
    evaluateSubscriptionAccess({ user: branch("STORE_ADMIN"), subscription: { status: "past_due", pastDueSince: since }, legacyAllowMissing: false }).allow,
    true
  );
  assert.equal(
    evaluateSubscriptionAccess({ user: branch("CASHIER"), subscription: { status: "expired" } }).allow,
    false
  );
});
