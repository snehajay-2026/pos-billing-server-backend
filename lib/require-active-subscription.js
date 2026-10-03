// lib/require-active-subscription.js
//
// Centralised tenant-subscription entitlement middleware. Adds a single
// new check to the request lifecycle — between ensureAuth and the route
// handler — and never replaces the role, store-scope, or ownership
// checks those handlers already perform.
//
// What this middleware owns:
//   - "is the calling tenant entitled to use the SaaS at this moment"
//   - the access policy for each subscription status, derived from the
//     existing state-machine writes (see below)
//
// What this middleware does NOT own:
//   - login, registration, password reset, public endpoints
//   - subscription management (subscription, plan, my, cancel, get-by-id)
//   - the Razorpay webhook
//   - hotel module locks (a separate feature with its own access rules)
//   - role / store-scope / ownership authorization
//
// ===========================================================================
// State machine — source of truth
// ===========================================================================
//
// The state machine writes live in two files:
//
//   lib/subscription-service.js
//     createSubscription(...)              → status = 'trialing'
//     cancelSubscription(...)               → status = 'cancelled'
//
//   lib/subscription-webhook.js (POST /api/subscriptions/webhook)
//     event 'payment.captured'             → status = 'active'
//                                            expires_at = payload.captured_at
//                                            (record-only on cancelled/expired)
//     event 'subscription.charged'         → renewal: record payment,
//                                            monotonic expiry, past_due→active
//     event 'payment.failed'               → no status change, never starts
//                                            grace (past_due_since untouched)
//     event 'subscription.cancelled'       → status = 'cancelled'
//
// `expired` is in the subscriptions.status ENUM but has no writer yet —
// honoured here as a forward-compatible deny signal.
//
// ===========================================================================
// Access policy (per status) — Task 10 approved rules
// ===========================================================================
//
//   active        allow  — subscription is live
//   trialing      allow  — subscription exists; first payment not yet
//                 captured. The webhook is the only path to 'active'.
//   past_due      allow only while now < past_due_since + 7 days
//                 (GRACE_MS in lib/subscription-dates.js). At or past the
//                 boundary → deny. A NULL past_due_since on a past_due row
//                 is a legacy anomaly → legacy allow (flagged in reason),
//                 never a fresh grace window. Failed payments never start
//                 grace: only the single approved past_due writer sets
//                 past_due_since, exactly once.
//   cancelled     deny   — must re-subscribe
//   expired       deny   — must re-subscribe
//
//   Missing row   deny, unless the canonical tenant key
//                 (rootOwnerEmail || ownerEmail || email, lowercased) is
//                 explicitly present in the SUPER_OWNER-approved legacy
//                 allowlist. Allowlist lookup failure fails closed.
//                 The legacy `legacyAllowMissing` flag is retained for
//                 backward compatibility in unit tests only: when no
//                 allowlist module is injected, it preserves the old
//                 allow/deny switch. Production wiring (index.js) injects
//                 the real allowlist with legacyAllowMissing=false.
// ===========================================================================

const {
  GRACE_MS,
  canonicalizeTenantKey,
  graceAllows,
} = require("./subscription-dates");

/**
 * Statuses that grant entitlement (before grace/allowlist refinement).
 * Single source of truth for the middleware.
 */
const ACCESS_GRANTING_STATUSES = new Set(["active", "trialing", "past_due"]);

/**
 * Resolve the tenant email from the authenticated session. The middleware
 * deliberately does NOT read query, body, header, or path parameters —
 * a tenant's subscription is owned by their tenant_email, and a forged
 * tenantEmail in the request must never widen or redirect entitlement.
 *
 * Order matches the existing helper used in the service:
 *   rootOwnerEmail || ownerEmail || email
 */
function resolveTenantEmail(session) {
  if (!session) return null;
  return session.rootOwnerEmail || session.ownerEmail || session.email || null;
}

/**
 * Subscription access decision. Pure function — given the user and the
 * subscription (which may be null for the missing-row case), returns:
 *   { allow: true,  reason: "..." }
 *   { allow: false, reason: "...", status, code: "SUBSCRIPTION_REQUIRED" }
 *
 * Used both by the express middleware (with a tiny request shim) and by
 * the unit tests.
 *
 * @param {object} opts
 * @param {Function} [opts.now] - clock, defaults to Date.now (injectable)
 * @param {object} [opts.legacyAllowlist] - { isAllowlisted(canonicalKey) }
 *   NOTE: the synchronous evaluator only supports synchronous allowlists
 *   (e.g. the in-memory test fake). An async allowlist (the production
 *   persistent lookup) returns a Promise, which can never `=== true` — the
 *   sync path then fails closed (deny). Production code MUST use
 *   evaluateSubscriptionAccessAsync below, which awaits the lookup.
 */
function evaluateSubscriptionAccess({ user, subscription, legacyAllowMissing = true, legacyAllowlist = null, now = null } = {}) {
  if (!user) {
    return { allow: false, reason: "Unauthenticated", code: "UNAUTHENTICATED" };
  }

  const role = String(user.role || "").toUpperCase();
  // SUPER_OWNER bypasses subscription enforcement by design. They may
  // continue to inspect tenants even after a subscription lapses.
  if (role === "SUPER_OWNER") {
    return { allow: true, reason: "SUPER_OWNER bypass" };
  }

  const tenantEmail = resolveTenantEmail(user);
  if (!tenantEmail) {
    return { allow: false, reason: "Tenant email could not be resolved", code: "TENANT_UNRESOLVED" };
  }

  // Missing subscription row → deny unless explicitly allowlisted.
  if (!subscription) {
    const canonicalKey = canonicalizeTenantKey(user);
    if (legacyAllowlist && typeof legacyAllowlist.isAllowlisted === "function") {
      let listed = false;
      try {
        listed = legacyAllowlist.isAllowlisted(canonicalKey) === true;
      } catch {
        listed = false; // lookup failure fails closed
      }
      if (listed) {
        return { allow: true, reason: "Legacy allowlist: tenant explicitly approved", tenantEmail };
      }
      return {
        allow: false,
        reason: "No subscription row exists for this tenant",
        code: "SUBSCRIPTION_REQUIRED",
        status: null,
        tenantEmail,
      };
    }
    if (legacyAllowMissing) {
      return { allow: true, reason: "Legacy: no subscription row yet", tenantEmail };
    }
    return {
      allow: false,
      reason: "No subscription row exists for this tenant",
      code: "SUBSCRIPTION_REQUIRED",
      status: null,
      tenantEmail,
    };
  }

  const status = String(subscription.status || "").toLowerCase();
  if (status === "past_due") {
    const pastDueSince = subscription.pastDueSince ?? subscription.past_due_since ?? null;
    if (pastDueSince == null) {
      // Legacy anomaly: past_due row predating the past_due_since column.
      // Preserve the historical allow; never mint a fresh grace window.
      return { allow: true, reason: "Legacy: past_due without past_due_since", tenantEmail };
    }
    const t = now instanceof Date ? now.getTime() : now != null ? new Date(now).getTime() : Date.now();
    const { allowed } = graceAllows({ now: t, pastDueSince });
    if (allowed) {
      return { allow: true, reason: "Status 'past_due' within grace period", tenantEmail };
    }
    return {
      allow: false,
      reason: "Subscription grace period expired",
      code: "SUBSCRIPTION_REQUIRED",
      status,
      tenantEmail,
    };
  }
  if (ACCESS_GRANTING_STATUSES.has(status)) {
    return { allow: true, reason: `Status '${status}' grants access`, tenantEmail };
  }

  // cancelled / expired / anything else → deny.
  return {
    allow: false,
    reason: `Subscription status '${status}' does not grant access`,
    code: "SUBSCRIPTION_REQUIRED",
    status,
    tenantEmail,
  };
}

/**
 * Async missing-row allowlist check. Awaits the persistent lookup so the
 * production path (db/queries/legacy-allowlist.js, async isAllowlisted)
 * works correctly. Sync fakes are awaited transparently (await of a
 * non-Promise resolves to the value), so unit tests using the in-memory
 * allowlist keep passing unchanged. Lookup failure fails closed.
 *
 * @param {object} legacyAllowlist - { isAllowlisted(canonicalKey) }
 * @param {string|null} canonicalKey
 * @returns {Promise<boolean>}
 */
async function checkLegacyAllowlistAsync(legacyAllowlist, canonicalKey) {
  if (!legacyAllowlist || typeof legacyAllowlist.isAllowlisted !== "function") {
    return false;
  }
  try {
    return (await legacyAllowlist.isAllowlisted(canonicalKey)) === true;
  } catch {
    return false; // lookup failure fails closed
  }
}

/**
 * Async subscription access decision. Identical to
 * evaluateSubscriptionAccess except the missing-row allowlist lookup is
 * awaited. Production middleware MUST use this function whenever a
 * persistent (async) allowlist is injected. All date/grace logic is
 * delegated to the sync evaluator so both paths stay in lockstep.
 *
 * @param {object} opts - same options as evaluateSubscriptionAccess
 * @returns {Promise<{allow:boolean,reason:string,...}>}
 */
async function evaluateSubscriptionAccessAsync(opts = {}) {
  const { user, subscription, legacyAllowlist } = opts;
  if (!user) {
    return { allow: false, reason: "Unauthenticated", code: "UNAUTHENTICATED" };
  }
  const role = String(user.role || "").toUpperCase();
  if (role === "SUPER_OWNER") {
    return { allow: true, reason: "SUPER_OWNER bypass" };
  }
  const tenantEmail = resolveTenantEmail(user);
  if (!tenantEmail) {
    return { allow: false, reason: "Tenant email could not be resolved", code: "TENANT_UNRESOLVED" };
  }
  if (!subscription && legacyAllowlist && typeof legacyAllowlist.isAllowlisted === "function") {
    const canonicalKey = canonicalizeTenantKey(user);
    const listed = await checkLegacyAllowlistAsync(legacyAllowlist, canonicalKey);
    if (listed) {
      return { allow: true, reason: "Legacy allowlist: tenant explicitly approved", tenantEmail };
    }
    return {
      allow: false,
      reason: "No subscription row exists for this tenant",
      code: "SUBSCRIPTION_REQUIRED",
      status: null,
      tenantEmail,
    };
  }
  // All non-missing-row decisions (active/trialing/past_due grace,
  // cancelled/expired deny) are purely synchronous — delegate so the two
  // evaluators can never drift apart.
  return evaluateSubscriptionAccess(opts);
}

/**
 * Express middleware factory.
 *
 * @param {object} deps
 * @param {object} deps.subscriptionsQueries - module exposing findByTenant
 * @param {boolean} [deps.legacyAllowMissing=true] - unit-test fallback when
 *        no allowlist module is injected (production passes false + allowlist)
 * @param {object} [deps.legacyAllowlist] - { isAllowlisted(canonicalKey) }
 * @param {Function} [deps.logger] - console.error by default
 */
function requireActiveSubscription({
  subscriptionsQueries,
  legacyAllowMissing = true,
  legacyAllowlist = null,
  logger = console,
} = {}) {
  if (!subscriptionsQueries || typeof subscriptionsQueries.findByTenant !== "function") {
    throw new TypeError(
      "requireActiveSubscription requires subscriptionsQueries with findByTenant()"
    );
  }

  return async function checkSubscription(req, res, next) {
    // Without ensureAuth in the chain the user object is absent; this
    // is a misconfiguration rather than a runtime rejection, so we
    // forward the error to the central handler.
    if (!req.user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // SUPER_OWNER bypasses before any DB lookup — they need no
    // subscription row and should not cost a query per request.
    if (String(req.user.role || "").toUpperCase() === "SUPER_OWNER") {
      req.subscriptionEntitlement = {
        tenantEmail: resolveTenantEmail(req.user),
        status: null,
        reason: "SUPER_OWNER bypass",
      };
      return next();
    }

    let tenantEmail;
    try {
      tenantEmail = resolveTenantEmail(req.user);
      const subscription = tenantEmail
        ? await subscriptionsQueries.findByTenant(tenantEmail)
        : null;

      const decision = await evaluateSubscriptionAccessAsync({
        user: req.user,
        subscription,
        legacyAllowMissing,
        legacyAllowlist,
      });

      if (decision.allow) {
        // Forward the resolved tenant + decision so handlers can read them
        // without re-querying or re-resolving.
        req.subscriptionEntitlement = {
          tenantEmail: decision.tenantEmail || tenantEmail,
          status: subscription ? subscription.status : null,
          reason: decision.reason,
        };
        return next();
      }

      logger.error?.("[requireActiveSubscription]", decision.code, decision.status || "(missing)");
      return res.status(402).json({
        error: "An active subscription is required to access this resource",
        code: decision.code,
        subscriptionStatus: decision.status,
        tenantEmail: decision.tenantEmail || tenantEmail,
      });
    } catch (err) {
      logger.error?.("[requireActiveSubscription] failed:", err);
      // Fail closed on entitlement-check exceptions: do not grant access
      // by accident if the lookup itself blows up. The response is
      // deliberately identical to a denied-subscription so a client
      // cannot probe DB health from this endpoint.
      return res.status(402).json({
        error: "Subscription entitlement check failed",
        code: "SUBSCRIPTION_REQUIRED",
        subscriptionStatus: null,
        tenantEmail: tenantEmail || null,
      });
    }
  };
}

module.exports = {
  ACCESS_GRANTING_STATUSES,
  GRACE_MS,
  resolveTenantEmail,
  evaluateSubscriptionAccess,
  evaluateSubscriptionAccessAsync,
  checkLegacyAllowlistAsync,
  requireActiveSubscription,
};
