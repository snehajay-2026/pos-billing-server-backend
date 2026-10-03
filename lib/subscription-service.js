// lib/subscription-service.js
//
// Pure subscription service layer — no HTTP, no process.env, no direct DB
// access. All external dependencies are injected so the service is fully
// testable with fakes and so a future provider swap touches one file.
//
// SaaS billing ONLY. Deliberately separate from the POS customer-sale
// payment flow (payment_intents). The two must never share a table, a
// status enum, or a code path.
//
// Three price concepts, never blurred:
//   A. plans.monthly_price / yearly_price  — the catalogue price
//   B. subscriptions.subscribed_price      — the snapshot at subscribe time
//   C. payment_records.amount              — the actual money that moved
//
// Authorization model (PER TENANT — never per branch):
//   SUPER_OWNER  — unrestricted (may subscribe any tenant)
//   ADMIN        — one ADMIN is one tenant; manages that tenant's single
//                  subscription, which every branch of that ADMIN shares
//   STORE_ADMIN  — belongs to one branch of an ADMIN tenant; may VIEW the
//                  parent tenant's subscription but must NOT create, cancel,
//                  change plan, or pay
//   CASHIER      — read-only entitlement; must NOT manage
//
// A subscription is owned by tenant_email (subscriptions.tenant_email,
// UNIQUE uq_sub_tenant). There is deliberately no store_type / store_id on a
// subscription: a branch is a (store_type, store_id) pair on a user row, not
// a billing entity. Branch selection must never create or fork a
// subscription.
//
// The service NEVER trusts amount, currency, provider plan ID, or tenant
// email from the caller's payload. All values are derived from the database
// or from the authenticated session context.
//
// Recurring term: subscriptions recur every billing cycle until cancelled.
// No total_count is sent to the provider, so neither monthly nor yearly has a
// hard-coded prepaid term.

const BILLING_CYCLES = new Set(["monthly", "yearly"]);

// Roles that may MUTATE the subscription lifecycle. STORE_ADMIN is
// deliberately excluded: it belongs to a branch and inherits the parent
// ADMIN tenant's subscription, but has no independent management rights.
// CASHIER is excluded outright.
const SUBSCRIPTION_MANAGE_ROLES = new Set(["SUPER_OWNER", "ADMIN"]);

/**
 * Resolve the tenant email for a subscription action.
 * SUPER_OWNER may act on behalf of any tenant (passed explicitly).
 * ADMIN / STORE_ADMIN may only act on their own tenant — derived from
 * the session, never from the request payload.
 */
function resolveTenantEmail(session, requestedTenantEmail) {
  const role = String(session?.role || "").toUpperCase();
  if (role === "SUPER_OWNER") {
    // SUPER_OWNER may target any tenant; default to their own email.
    return requestedTenantEmail || session?.email || session?.rootOwnerEmail || "";
  }
  // Non-SUPER_OWNER: always use the session-derived tenant email.
  // The requestedTenantEmail parameter is ignored entirely.
  return session?.rootOwnerEmail || session?.ownerEmail || session?.email || "";
}

/**
 * Check whether the given role may mutate subscriptions (create / cancel /
 * change plan / pay). STORE_ADMIN and CASHIER are denied: a STORE_ADMIN
 * inherits the parent tenant's subscription rather than managing it.
 */
function canManageSubscription(role) {
  return SUBSCRIPTION_MANAGE_ROLES.has(String(role || "").toUpperCase());
}

/**
 * Check whether the given role may view a tenant subscription. Every
 * authenticated role may read entitlement/status for its own tenant; the
 * service derives the tenant from the session, so a caller can only ever see
 * its own tenant's record through this path.
 */
function canViewSubscription(role) {
  return String(role || "").toUpperCase() !== "";
}

/**
 * Select the correct Razorpay provider plan ID based on billing cycle.
 * Returns null if the plan has no provider plan ID for the selected cycle.
 */
function selectProviderPlanId(plan, billingCycle) {
  if (!plan) return null;
  if (billingCycle === "monthly") {
    return plan.providerPlanId || plan.provider_plan_id || null;
  }
  if (billingCycle === "yearly") {
    return plan.providerPlanIdYearly || plan.provider_plan_id_yearly || null;
  }
  return null;
}

/**
 * Select the correct local price based on billing cycle.
 * Returns the price in rupees (number).
 */
function selectLocalPrice(plan, billingCycle) {
  if (!plan) return 0;
  if (billingCycle === "monthly") {
    return plan.monthlyPrice ?? plan.monthly_price ?? 0;
  }
  if (billingCycle === "yearly") {
    return plan.yearlyPrice ?? plan.yearly_price ?? 0;
  }
  return 0;
}

/**
 * Create a subscription for a tenant.
 *
 * @param {object} deps - injected dependencies
 * @param {object} deps.plansQueries - plan query module (findById)
 * @param {object} deps.subscriptionsQueries - subscription query module
 * @param {object} deps.subscriptionEventsQueries - event log module
 * @param {object} deps.razorpay - Razorpay wrapper (lib/razorpay.js)
 * @param {object} deps.razorpayConfig - { keyId, keySecret } for the wrapper
 * @param {Function} [deps.withTransaction] - optional transaction helper
 * @param {object} params
 * @param {number} params.planId - local plan ID (from the route, not the frontend payload)
 * @param {string} params.billingCycle - "monthly" | "yearly"
 * @param {object} params.session - authenticated user session { role, email, rootOwnerEmail, ownerEmail }
 * @param {string} [params.requestedTenantEmail] - tenant email (SUPER_OWNER only)
 * @returns {Promise<{ subscription: object, providerSubscription: object }>}
 * @throws {Error} on authorization failure, validation failure, or provider error
 */
async function createSubscription(deps, params) {
  const {
    plansQueries,
    subscriptionsQueries,
    subscriptionEventsQueries,
    razorpay,
    razorpayConfig,
    withTransaction,
  } = deps;

  const { planId, billingCycle, session, requestedTenantEmail } = params;

  // --- Authorization -------------------------------------------------------

  const role = String(session?.role || "").toUpperCase();
  if (!canManageSubscription(role)) {
    const err = new Error(
      role === "STORE_ADMIN"
        ? "STORE_ADMIN cannot manage subscriptions — the parent ADMIN tenant owns the subscription"
        : "CASHIER cannot manage subscriptions"
    );
    err.code = "FORBIDDEN";
    err.status = 403;
    throw err;
  }

  // --- Validation ----------------------------------------------------------

  if (!planId) {
    const err = new Error("planId is required");
    err.code = "VALIDATION";
    err.status = 400;
    throw err;
  }

  if (!BILLING_CYCLES.has(billingCycle)) {
    const err = new Error("billingCycle must be 'monthly' or 'yearly'");
    err.code = "VALIDATION";
    err.status = 400;
    throw err;
  }

  // --- Load plan from database --------------------------------------------

  const plan = await plansQueries.findById(planId);
  if (!plan) {
    const err = new Error("Plan not found");
    err.code = "NOT_FOUND";
    err.status = 404;
    throw err;
  }

  // --- Select provider plan ID and local price -----------------------------

  const providerPlanId = selectProviderPlanId(plan, billingCycle);
  if (!providerPlanId) {
    const err = new Error(
      `No Razorpay provider plan ID configured for ${billingCycle} billing on this plan`
    );
    err.code = "PROVIDER_PLAN_MISSING";
    err.status = 500;
    throw err;
  }

  const localPrice = selectLocalPrice(plan, billingCycle);
  if (!localPrice || localPrice <= 0) {
    const err = new Error(
      `No ${billingCycle} price configured for this plan`
    );
    err.code = "VALIDATION";
    err.status = 400;
    throw err;
  }

  // --- Resolve tenant email ------------------------------------------------

  const tenantEmail = resolveTenantEmail(session, requestedTenantEmail);
  if (!tenantEmail) {
    const err = new Error("Unable to resolve tenant email");
    err.code = "VALIDATION";
    err.status = 400;
    throw err;
  }

  // --- Create Razorpay subscription ----------------------------------------

  // No totalCount: the subscription recurs every billing cycle until it is
  // cancelled. Cancelling is the only stop control.
  const providerSubscription = await razorpay.createSubscription(razorpayConfig, {
    providerPlanId,
    customerEmail: tenantEmail,
  });

  if (!providerSubscription || !providerSubscription.id) {
    const err = new Error("Razorpay did not return a subscription ID");
    err.code = "PROVIDER_ERROR";
    err.status = 502;
    throw err;
  }

  // --- Persist local subscription ------------------------------------------

  const now = new Date().toISOString();
  // Sticky billing anchor: the original day-of-month, persisted once and
  // never mutated by renewal. Uses UTC day for determinism.
  const billingAnchorDay = new Date(now).getUTCDate();
  const subscriptionData = {
    tenantEmail,
    planId: plan.id,
    planName: plan.name,
    billingCycle,
    subscribedPrice: localPrice,
    status: "trialing", // NOT active — activation depends on verified webhook
    startedAt: now,
    expiresAt: null,
    razorpaySubscriptionId: providerSubscription.id,
    pastDueSince: null,
    billingAnchorDay,
  };

  let subscription;
  if (withTransaction) {
    subscription = await withTransaction(async (conn) => {
      const created = await subscriptionsQueries.create(subscriptionData);
      await subscriptionEventsQueries.append({
        subscriptionId: created.id,
        eventType: "created",
        payload: {
          planId: plan.id,
          billingCycle,
          subscribedPrice: localPrice,
          providerPlanId,
          razorpaySubscriptionId: providerSubscription.id,
        },
      });
      return created;
    });
  } else {
    subscription = await subscriptionsQueries.create(subscriptionData);
    await subscriptionEventsQueries.append({
      subscriptionId: subscription.id,
      eventType: "created",
      payload: {
        planId: plan.id,
        billingCycle,
        subscribedPrice: localPrice,
        providerPlanId,
        razorpaySubscriptionId: providerSubscription.id,
      },
    });
  }

  return { subscription, providerSubscription };
}

/**
 * Cancel a subscription.
 *
 * @param {object} deps - same as createSubscription
 * @param {object} params
 * @param {number} params.subscriptionId - local subscription ID
 * @param {object} params.session - authenticated user session
 * @returns {Promise<object>} updated subscription
 */
async function cancelSubscription(deps, params) {
  const { subscriptionsQueries, subscriptionEventsQueries, razorpay, razorpayConfig } = deps;
  const { subscriptionId, session } = params;

  const role = String(session?.role || "").toUpperCase();
  if (!canManageSubscription(role)) {
    const err = new Error(
      role === "STORE_ADMIN"
        ? "STORE_ADMIN cannot manage subscriptions — the parent ADMIN tenant owns the subscription"
        : "CASHIER cannot manage subscriptions"
    );
    err.code = "FORBIDDEN";
    err.status = 403;
    throw err;
  }

  const subscription = await subscriptionsQueries.findById(subscriptionId);
  if (!subscription) {
    const err = new Error("Subscription not found");
    err.code = "NOT_FOUND";
    err.status = 404;
    throw err;
  }

  // Non-SUPER_OWNER can only cancel their own tenant's subscription.
  if (role !== "SUPER_OWNER") {
    const tenantEmail = session?.rootOwnerEmail || session?.ownerEmail || session?.email || "";
    if (subscription.tenantEmail !== tenantEmail) {
      const err = new Error("Access denied");
      err.code = "FORBIDDEN";
      err.status = 403;
      throw err;
    }
  }

  // Cancel with Razorpay if we have a provider subscription ID.
  if (subscription.razorpaySubscriptionId && razorpay && razorpayConfig) {
    await razorpay.cancelSubscription(razorpayConfig, subscription.razorpaySubscriptionId);
  }

  const updated = await subscriptionsQueries.update(subscription.id, {
    status: "cancelled",
  });

  await subscriptionEventsQueries.append({
    subscriptionId: subscription.id,
    eventType: "cancelled",
    payload: { razorpaySubscriptionId: subscription.razorpaySubscriptionId },
  });

  return updated;
}

module.exports = {
  BILLING_CYCLES,
  SUBSCRIPTION_MANAGE_ROLES,
  canManageSubscription,
  canViewSubscription,
  resolveTenantEmail,
  selectProviderPlanId,
  selectLocalPrice,
  createSubscription,
  cancelSubscription,
};
