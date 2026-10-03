// lib/razorpay.js
//
// Razorpay Subscriptions provider wrapper. Isolated behind this module so the
// provider can be mocked independently of the route layer and so a future
// provider swap touches one file.
//
// SaaS billing ONLY. This is deliberately kept separate from the existing
// POS customer-sale payment flow (db/queries/payments.js → payment_intents).
// The two must never share a table, a status enum, or a code path.
//
// Transport: Node's built-in https module. No new npm dependency.
//
// Auth: HTTP Basic, `RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET`. Credentials are
// injected by the caller as the first argument to every method — the wrapper
// NEVER reads process.env itself. This keeps the secret out of the module's
// reach entirely and makes the wrapper trivially testable without mutating
// process state. The route layer is responsible for pulling the credentials
// from the environment and passing them in; the secret is never returned in
// an error, logged, or attached to a result object.
//
// Money: callers pass RUPEES (number or numeric string). The wrapper converts
// to integer PAISE before sending, because Razorpay's API expects paise and
// silently truncates fractional values. The conversion happens here so no
// caller can forget it.
//
// ---------------------------------------------------------------------------
// RAZORPAY API ASSUMPTIONS — NOT YET VERIFIED AGAINST LIVE TEST MODE
// ---------------------------------------------------------------------------
// Web access was unavailable while this module was written, so the following
// could not be confirmed against the live docs. They reflect the long-standing
// Razorpay Subscriptions v1 contract but MUST be re-verified in Test Mode
// before any real money moves:
//
//   1. Base URL `https://api.razorpay.com/v1` and the `/plans` and
//      `/subscriptions` resource paths.
//   2. Plan creation payload: `{ period, interval, item: { name, amount,
//      currency, description? }, notes? }` with `period` = "monthly" |
//      "yearly" and `amount` in PAISE.
//   3. Subscription creation payload: `{ plan_id, total_count, quantity?,
//      start_at?, expire_by?, customer_notify?, addons?, notes? }` and that
//      the response carries `id`, `status`, `plan_id`, `start_at`,
//      `end_at`, `paid_count`, `total_count`, `current_start`,
//      `current_end`, `charge_at`, `short_url`.
//   4. `status` values returned by the provider: `created`, `authenticated`,
//      `active`, `pending`, `halted`, `cancelled`, `completed`, `expired`.
//   5. Cancel is a POST to `/subscriptions/:id/cancel` with an empty JSON
//      body `{}` (not a DELETE, and not a query flag).
//   6. Fetch is a plain GET on `/subscriptions/:id`.
//   7. Error envelope shape `{ error: { code, description, field? } }` and
//      that HTTP 4xx/5xx is how the provider signals failure.
//   8. That a subscription created with a future `start_at` returns status
//      `created`/`authenticated` and does NOT become `active` until the
//      first payment is captured — which is exactly why this wrapper never
//      marks a local subscription active on create-subscription success.
//
// Do NOT treat any of this as production-verified until a Test Mode E2E has
// been run.
// ---------------------------------------------------------------------------

const https = require("https");
const crypto = require("crypto");

const DEFAULT_BASE_URL = "https://api.razorpay.com/v1";
const DEFAULT_TIMEOUT_MS = 15000;

// Provider subscription statuses, per assumption (4). Kept as a Set so the
// route layer can branch on provider state without hard-coding strings.
const PROVIDER_SUBSCRIPTION_STATUSES = new Set([
  "created",
  "authenticated",
  "active",
  "pending",
  "halted",
  "cancelled",
  "completed",
  "expired",
]);

// Normalized error shape returned by every method in this module. `status`
// is the HTTP status code when one was received, null for transport-level
// failures (timeout, DNS, socket). `code` is a LOCAL classification
// (CONFIG_MISSING, PARSE_ERROR, NETWORK_ERROR, TIMEOUT, VALIDATION);
// `providerCode` is the provider's own error code when the response carried
// one. `providerId` is the provider's own entity id when the response
// carried one — useful for reconciling a failed create-subscription call
// that actually succeeded server-side.
//
// The secret is never stored on the error.
class RazorpayError extends Error {
  constructor({ message, status = null, code = null, providerCode = null, providerId = null }) {
    super(message);
    this.name = "RazorpayError";
    this.status = status;
    this.code = code;
    this.providerCode = providerCode;
    this.providerId = providerId;
  }
}

const isRazorpayError = (err) => err instanceof RazorpayError;

// Validate an injected credentials object. Throws CONFIG_MISSING (never a
// leak of the secret) when either half is absent.
function requireCredentials(config) {
  const keyId = config && config.keyId;
  const keySecret = config && config.keySecret;
  if (!keyId || !keySecret) {
    throw new RazorpayError({
      message: "Razorpay credentials are not configured",
      code: "CONFIG_MISSING",
    });
  }
  return { keyId: String(keyId), keySecret: String(keySecret) };
}

// Build the Basic auth header value. `Buffer.from` keeps the secret out of
// any string interpolation that could end up in a log.
function basicAuthHeader(keyId, keySecret) {
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`, "utf8").toString("base64");
}

// Convert a rupee amount (number or numeric string) to integer paise.
// Throws VALIDATION when the input is not a positive finite number.
function toPaise(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    throw new RazorpayError({
      message: "Amount must be a positive number (rupees)",
      code: "VALIDATION",
    });
  }
  return Math.round(n * 100);
}

// Perform one HTTPS request and resolve with `{ status, body }`, where body
// is the parsed JSON (or null for an empty body). Rejects with a
// RazorpayError on timeout, socket error, or unparseable JSON.
function request(config, { method, path: urlPath, body = null, baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let keyId;
    let keySecret;
    try {
      ({ keyId, keySecret } = requireCredentials(config));
    } catch (err) {
      reject(err);
      return;
    }

    const payload = body == null ? null : JSON.stringify(body);
    const url = new URL(baseUrl + urlPath);

    const headers = {
      Authorization: basicAuthHeader(keyId, keySecret),
      Accept: "application/json",
    };
    if (payload != null) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method,
        headers,
        // Never follow a redirect off the provider host.
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (rawBody) {
            try {
              parsed = JSON.parse(rawBody);
            } catch {
              reject(
                new RazorpayError({
                  message: "Razorpay returned a non-JSON response",
                  status: res.statusCode,
                  code: "PARSE_ERROR",
                })
              );
              return;
            }
          }
          resolve({ status: res.statusCode, body: parsed, rawBody });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(
        new RazorpayError({
          message: `Razorpay request timed out after ${timeoutMs}ms`,
          code: "TIMEOUT",
        })
      );
    });

    req.on("error", (err) => {
      // A timeout destroys the request with the RazorpayError built above;
      // pass it through untouched so the caller sees TIMEOUT, not NETWORK_ERROR.
      // Anything else is a transport-level failure: no HTTP status to report.
      if (isRazorpayError(err)) {
        reject(err);
        return;
      }
      reject(
        new RazorpayError({
          message: `Razorpay request failed: ${err.message}`,
          code: "NETWORK_ERROR",
        })
      );
    });

    if (payload != null) req.write(payload);
    req.end();
  });
}

// Throw a normalized RazorpayError for a non-2xx response. Extracts the
// provider's own error code/description and entity id when present, so the
// route layer can distinguish "already exists" from "bad request" without
// re-parsing.
function assertOk(res, fallbackMessage) {
  if (res.status >= 200 && res.status < 300) return res;
  const envelope = res.body && res.body.error;
  throw new RazorpayError({
    message: envelope?.description || fallbackMessage || `Razorpay error (${res.status})`,
    status: res.status,
    code: `HTTP_${res.status}`,
    providerCode: envelope?.code || null,
    providerId: res.body?.id || null,
  });
}

// --- Plans ------------------------------------------------------------------

// Create a Razorpay plan. `amount` is in RUPEES and MUST be derived from the
// local plans catalogue by the caller — this wrapper never invents a price.
// The wrapper converts it to integer paise before sending.
//
// Returns the provider plan entity. The caller is responsible for persisting
// `providerPlanId` — see the migration note at the bottom of this file.
async function createPlan(config, { name, amount, currency = "INR", period, interval, description = null }) {
  if (!name) throw new RazorpayError({ message: "Plan name is required", code: "VALIDATION" });
  const paise = toPaise(amount);
  const item = { name, amount: paise, currency };
  if (description) item.description = description;

  const res = await request(config, {
    method: "POST",
    path: "/plans",
    body: { period, interval, item },
  });
  assertOk(res, "Failed to create Razorpay plan");
  return res.body;
}

// Fetch a provider plan by id. Used to confirm a plan exists before creating
// a subscription against it.
async function fetchPlan(config, providerPlanId) {
  const res = await request(config, { method: "GET", path: `/plans/${encodeURIComponent(providerPlanId)}` });
  assertOk(res, "Failed to fetch Razorpay plan");
  return res.body;
}

// --- Subscriptions ----------------------------------------------------------

// Create a Razorpay subscription against an existing provider plan.
//
// `totalCount` is the number of billing cycles to charge before the
// subscription stops. It is OPTIONAL and defaults to undefined on purpose:
// omitting `total_count` makes the subscription recur every cycle until it
// is cancelled, which is the intended SaaS behaviour for both monthly and
// yearly plans. A fixed literal here would silently turn a monthly plan into
// a 12-month prepaid term and a yearly plan into a 12-year one.
//
// `startAt` is an ISO string for a future-dated start (used for trials).
// The caller must have already validated the plan, price, and tenant
// authorization — this wrapper does not re-check any of that.
//
// IMPORTANT: a successful create-subscription response does NOT mean the
// subscription is active. The provider returns `created` or `authenticated`
// until the first payment is captured. The route layer must wait for the
// verified webhook before marking the local subscription active.
async function createSubscription(config, { providerPlanId, totalCount, startAt = null, customerEmail = null, notes = null }) {
  if (!providerPlanId) {
    throw new RazorpayError({ message: "providerPlanId is required", code: "VALIDATION" });
  }
  const body = { plan_id: providerPlanId };
  // Only send total_count when the caller explicitly capped the term. A null
  // or undefined value means "recur indefinitely" and must be omitted rather
  // than sent as null, which the provider would reject.
  if (totalCount !== undefined && totalCount !== null) {
    body.total_count = totalCount;
  }
  if (startAt) body.start_at = Math.floor(new Date(startAt).getTime() / 1000);
  if (customerEmail) body.customer_notify = 1;
  if (notes) body.notes = notes;

  const res = await request(config, { method: "POST", path: "/subscriptions", body });
  assertOk(res, "Failed to create Razorpay subscription");
  return res.body;
}

// Fetch a provider subscription by id. Used for webhook reconciliation and
// for the tenant-facing "what does the provider think" view.
async function fetchSubscription(config, providerSubscriptionId) {
  const res = await request(config, {
    method: "GET",
    path: `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
  });
  assertOk(res, "Failed to fetch Razorpay subscription");
  return res.body;
}

// Cancel a provider subscription. Per assumption (5) this is a POST with an
// empty JSON body, not a DELETE.
async function cancelSubscription(config, providerSubscriptionId) {
  const res = await request(config, {
    method: "POST",
    path: `/subscriptions/${encodeURIComponent(providerSubscriptionId)}/cancel`,
    body: {},
  });
  assertOk(res, "Failed to cancel Razorpay subscription");
  return res.body;
}

// --- Signature verification ------------------------------------------------
//
// Razorpay redirects a successful subscription Checkout back to the merchant
// with these three query params:
//
//   razorpay_payment_id      e.g. "pay_ABC123"
//   razorpay_subscription_id e.g. "sub_XYZ789"
//   razorpay_signature       HMAC-SHA256 of the first two joined by "|"
//
// The HMAC is keyed with the RAZORPAY_KEY_SECRET. The signature proves the
// redirect genuinely came from Razorpay; a frontend cannot forge it because
// it does not have the secret. The verify endpoint therefore:
//   - reconstructs the HMAC server-side,
//   - compares it byte-for-byte against the signature the browser sent,
//   - never reveals the secret in any code path.
//
// `config` is the same { keyId, keySecret } pair every other wrapper method
// receives. Returns true on a valid signature, false otherwise. Throws
// CONFIG_MISSING when the secret is absent (the only way to detect a
// misconfigured server).
//
// Important: this is the verify-time check the user lands on after the
// hosted Checkout redirect. It is NOT a replacement for the webhook — the
// webhook (payment.captured) is the authoritative activation path. The
// verify check only confirms the redirect came from Razorpay; it does not
// flip a local subscription to active. See index.js webhook handler.
function verifySubscriptionSignature(
  config,
  { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
) {
  const { keySecret } = requireCredentials(config);
  if (!razorpay_payment_id || !razorpay_subscription_id || !razorpay_signature) {
    return false;
  }
  const expected = crypto
    .createHmac("sha256", keySecret)
    .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
    .digest("hex");
  // Constant-time comparison. A plain `===` short-circuits on the first
  // mismatched byte and would leak timing on forged signatures. crypto's
  // timingSafeEqual requires equal-length buffers.
  const expectedBuf = Buffer.from(expected, "utf8");
  const givenBuf = Buffer.from(String(razorpay_signature), "utf8");
  if (expectedBuf.length !== givenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, givenBuf);
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  PROVIDER_SUBSCRIPTION_STATUSES,
  RazorpayError,
  isRazorpayError,
  toPaise,
  createPlan,
  fetchPlan,
  createSubscription,
  fetchSubscription,
  cancelSubscription,
  verifySubscriptionSignature,
};
