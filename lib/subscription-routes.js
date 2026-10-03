// lib/subscription-routes.js
//
// Thin HTTP layer for subscription lifecycle. The business logic — tenant
// resolution, role authorization, provider-plan selection, persistence,
// event logging, Razorpay call — lives in lib/subscription-service.js.
//
// The handlers here:
//   1. read body fields that are actually used (planId, billingCycle,
//      and, for SUPER_OWNER only, tenantEmail)
//   2. build the dependency injection object for the service
//   3. map service errors to HTTP status codes
//
// Anything else would duplicate business logic and drift from the service.
// In particular, tenant resolution is delegated to the service via
// resolveTenantEmail so a forged tenantEmail in the body is ignored for
// every non-SUPER_OWNER role (the service enforces that contract).

/**
 * Build the dependency object for the service from the runtime context.
 * Centralised so create and cancel share the same wiring.
 */
function buildSubscriptionDeps({
  plansQueries,
  subscriptionsQueries,
  subscriptionEventsQueries,
  razorpay,
  razorpayConfig,
  withTransaction,
}) {
  return {
    plansQueries,
    subscriptionsQueries,
    subscriptionEventsQueries,
    razorpay,
    razorpayConfig,
    withTransaction,
  };
}

/**
 * Map a service-layer error to its HTTP response. The service uses the
 * following codes:
 *   FORBIDDEN            → 403
 *   VALIDATION           → 400
 *   NOT_FOUND            → 404
 *   PROVIDER_PLAN_MISSING → 500 (no provider call was made; this is a
 *                          configuration error rather than a runtime one)
 *   anything else        → 500
 */
function subscriptionErrorToHttp(err, res, fallbackMessage) {
  if (err?.code === "FORBIDDEN") {
    return res.status(403).json({ error: err.message });
  }
  if (err?.code === "VALIDATION") {
    return res.status(400).json({ error: err.message });
  }
  if (err?.code === "NOT_FOUND") {
    return res.status(404).json({ error: err.message });
  }
  if (err?.code === "PROVIDER_PLAN_MISSING") {
    return res.status(500).json({ error: err.message, code: err.code });
  }
  return res.status(500).json({ error: fallbackMessage });
}

/**
 * Project the public Razorpay provider subscription down to the ONLY
 * fields the frontend is allowed to see. Everything else (internal
 * timestamps, plan_id, customer fields, has_scheduled_changes, etc.) is
 * dropped at the route layer so it never reaches the browser.
 *
 * Today the only checkout-relevant field is `short_url` — Razorpay's
 * hosted Checkout / hosted subscription page URL. We forward it as
 * `shortUrl` (camelCase) so the UI does not leak the snake_case provider
 * convention.
 *
 * Returns `{ shortUrl }`. `shortUrl` is null when the provider response
 * did not carry a short_url (older test fixtures, mocks). The UI must
 * handle null safely — see SubscriptionPage.jsx.
 */
function toCheckoutInfo(providerSubscription) {
  if (!providerSubscription || typeof providerSubscription !== "object") {
    return { shortUrl: null };
  }
  const url = providerSubscription.short_url || providerSubscription.shortUrl || null;
  return { shortUrl: url };
}

/**
 * Build the route handlers for subscription lifecycle.
 * Returned shape: { createHandler, cancelHandler, configHandler, verifyHandler }.
 *
 * Each handler takes (req, res) and delegates to the service or to a small
 * piece of glue code. The handlers are intentionally thin so the service
 * remains the single source of truth for authorization, tenant resolution,
 * plan selection, and persistence.
 *
 * configHandler returns ONLY the public Razorpay keyId. The keySecret
 * NEVER appears in the response, in logs, or in any field attached to a
 * route reply.
 *
 * verifyHandler is the post-redirect signature check. It does NOT mark a
 * subscription active — only the verified webhook (payment.captured) does
 * that. The verify check confirms the redirect genuinely came from Razorpay
 * and records an audit event so the UI can refresh to the backend status.
 */
function buildSubscriptionRouteHandlers({
  subscriptionService,
  plansQueries,
  subscriptionsQueries,
  subscriptionEventsQueries,
  razorpay,
  razorpayConfig,
  withTransaction,
  logger = console,
}) {
  const deps = buildSubscriptionDeps({
    plansQueries,
    subscriptionsQueries,
    subscriptionEventsQueries,
    razorpay,
    razorpayConfig,
    withTransaction,
  });

  async function createHandler(req, res) {
    const { planId, billingCycle, tenantEmail: requestedTenantEmail } = req.body || {};
    try {
      const { subscription, providerSubscription } =
        await subscriptionService.createSubscription(deps, {
          planId: Number(planId),
          billingCycle,
          session: req.user,
          requestedTenantEmail,
        });
      return res.status(201).json({
        subscription,
        // The ONLY provider field the UI is allowed to see. Everything
        // else from `providerSubscription` is dropped at this layer.
        checkout: toCheckoutInfo(providerSubscription),
      });
    } catch (err) {
      logger.error("Failed to create subscription:", err);
      return subscriptionErrorToHttp(err, res, "Failed to create subscription");
    }
  }

  async function cancelHandler(req, res) {
    const { id } = req.params;
    try {
      const subscription = await subscriptionService.cancelSubscription(deps, {
        subscriptionId: Number(id),
        session: req.user,
      });
      return res.json(subscription);
    } catch (err) {
      logger.error("Failed to cancel subscription:", err);
      return subscriptionErrorToHttp(err, res, "Failed to cancel subscription");
    }
  }

  // --- GET /api/subscriptions/config ----------------------------------------
  //
  // Returns the public Razorpay keyId so the frontend can launch Checkout.
  // NEVER returns keySecret, never logs it, never lets it leak through an
  // error message. The handler does not consult the session-derived tenant;
  // the keyId is the same for every tenant in this environment.
  //
  // Access: ADMIN or SUPER_OWNER. STORE_ADMIN/CASHIER cannot start checkout.
  function configHandler(req, res) {
    const role = String(req.user?.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "SUPER_OWNER") {
      return res.status(403).json({ error: "Only ADMIN or Super Owner can read subscription config" });
    }
    const keyId = razorpayConfig && razorpayConfig.keyId ? String(razorpayConfig.keyId) : null;
    if (!keyId) {
      return res.status(503).json({ error: "Razorpay is not configured" });
    }
    // Intentionally a flat object. The secret is not present here, nor in
    // any sibling field, nor in any error string the handler might emit.
    return res.json({ keyId });
  }

  // --- POST /api/subscriptions/verify ---------------------------------------
  //
  // Server-side signature check after a Razorpay Checkout redirect. The
  // frontend posts ONLY what survives the external redirect:
  //   { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
  //
  // A full-page redirect to Razorpay unloads the React app, so the local
  // subscription id is deliberately NOT required — the local row is
  // resolved server-side via subscriptionsQueries.findByRazorpayId using
  // the provider subscription id from the redirect. That id already
  // survives the redirect (Razorpay puts it in the callback params), so
  // no client-side persistence (state, storage, query echo) is needed.
  //
  // A legacy `subscriptionId` may still be supplied; when present it is
  // treated as a binding assertion and must match the resolved row.
  //
  // This endpoint:
  //   - rejects STORE_ADMIN / CASHIER (cannot manage payments)
  //   - resolves the local row by provider id, then rejects requests
  //     whose row does not belong to the caller's tenant (ADMIN) or
  //     whose tenant cannot be resolved — a caller can never select
  //     another tenant's subscription because tenant comes only from
  //     the authenticated session, never the request body
  //   - rejects forged signatures
  //
  // On success it records a `payment_verified` audit entry and returns
  // the current backend status. It does NOT mark the subscription active.
  // Activation is the webhook's job.
  async function verifyHandler(req, res) {
    const role = String(req.user?.role || "").toUpperCase();
    if (role !== "ADMIN" && role !== "SUPER_OWNER") {
      return res
        .status(403)
        .json({ error: "Only ADMIN or Super Owner can verify subscription payments" });
    }

    const body = req.body || {};
    const {
      subscriptionId: legacySubscriptionId,
      razorpay_payment_id,
      razorpay_subscription_id,
      razorpay_signature,
    } = body;

    if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
      return res.status(400).json({
        error:
          "razorpay_payment_id, razorpay_subscription_id, razorpay_signature are required",
      });
    }

    // Resolve the local row server-side by provider subscription id.
    // findByRazorpayId is NOT tenant-scoped by itself — the tenant
    // ownership check below is what makes this safe.
    let localSubscription = null;
    if (typeof subscriptionsQueries.findByRazorpayId === "function") {
      localSubscription = await subscriptionsQueries.findByRazorpayId(
        razorpay_subscription_id
      );
    }
    if (!localSubscription) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    // Legacy binding assertion: when the caller also supplies the local
    // id it must identify the same row we just resolved. This keeps the
    // old contract safe without relying on it for correlation.
    if (
      legacySubscriptionId !== undefined &&
      legacySubscriptionId !== null &&
      legacySubscriptionId !== "" &&
      Number(legacySubscriptionId) !== localSubscription.id
    ) {
      return res.status(400).json({ error: "Razorpay subscription id mismatch" });
    }

    // Tenant ownership: ADMIN may verify only their own tenant's subscription.
    // SUPER_OWNER bypasses.
    if (role !== "SUPER_OWNER") {
      const tenantEmail = req.user?.rootOwnerEmail || req.user?.ownerEmail || req.user?.email;
      if (!tenantEmail || localSubscription.tenantEmail !== tenantEmail) {
        return res.status(403).json({ error: "Access denied" });
      }
    }

    let signatureOk = false;
    try {
      signatureOk = razorpay.verifySubscriptionSignature(razorpayConfig, {
        razorpay_payment_id,
        razorpay_subscription_id,
        razorpay_signature,
      });
    } catch (err) {
      // CONFIG_MISSING surfaces here if RAZORPAY_KEY_SECRET is unset.
      // The handler never echoes the secret and never echoes the error
      // message that could have carried it — we only log a code.
      logger.error("[subscription.verify] signature check failed:", err?.code || "UNKNOWN");
      return res.status(503).json({ error: "Razorpay is not configured" });
    }
    if (!signatureOk) {
      // Audit-log the failed attempt so a tampered redirect is visible
      // without leaking the secret. We log the local subscription id and
      // the role — never the razorpay_signature.
      try {
        await subscriptionEventsQueries.append({
          subscriptionId: localSubscription.id,
          eventType: "payment_verification_failed",
          payload: { role },
        });
      } catch (e) {
        // Best-effort; don't let audit logging break the response.
      }
      return res.status(400).json({ error: "Invalid payment signature" });
    }

    // Signature OK. Record the verification event. The webhook remains the
    // authoritative path that marks it active.
    try {
      await subscriptionEventsQueries.append({
        subscriptionId: localSubscription.id,
        eventType: "payment_verified",
        payload: { razorpayPaymentId: razorpay_payment_id, role },
      });
    } catch (e) {
      // Best-effort; the verification itself succeeded.
    }

    return res.json({
      verified: true,
      status: localSubscription.status,
      // The UI uses this to know that an activation event from the
      // webhook may or may not have arrived. The UI MUST NOT treat this
      // as confirmation of activation — it must re-read /api/subscriptions/my.
      subscription: localSubscription,
    });
  }

  return { createHandler, cancelHandler, configHandler, verifyHandler };
}

module.exports = {
  buildSubscriptionDeps,
  buildSubscriptionRouteHandlers,
  subscriptionErrorToHttp,
  toCheckoutInfo,
};