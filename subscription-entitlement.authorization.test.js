// subscription-entitlement.authorization.test.js
//
// Structural contract for the entitlement gate wiring in index.js.
//
// index.js is not factored for dependency injection (it binds the real
// pool at require time), so these tests assert on the route-registration
// source instead of booting the server:
//
//   - the gate (ensureAuthWithSubscription + isSubscriptionExempt +
//     SUBSCRIPTION_EXEMPT_PATHS) is defined and delegates to
//     requireActiveSubscription with the real subscriptionsQueries
//   - subscription management routes stay on plain ensureAuth so an
//     expired tenant can still renew (create / cancel / my / plans)
//   - subscription read routes (list / get-by-id) ARE gated
//   - hotel module-lock routes stay on plain ensureAuth (own access rules)
//   - authentication routes carry no entitlement gate
//   - the webhook and public-invoice routes carry neither ensureAuth
//     nor the gate
//   - business routes (invoices, hotel bookings, generic catch-alls)
//     are gated

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");

function routeLine(prefix) {
  const line = src.split("\n").find((l) => l.startsWith(prefix));
  assert.ok(line, `expected route registration starting with: ${prefix}`);
  return line;
}

test("gate is defined and uses the real subscriptionsQueries with legacy allowlist", () => {
  // Task 10: missing-row tenants are denied unless explicitly allowlisted.
  // legacyAllowMissing is the unit-test fallback only; production wiring
  // injects the real allowlist (db/queries/legacy-allowlist.js) and sets
  // legacyAllowMissing: false.
  assert.match(src, /requireActiveSubscription\(\{\s*\n?\s*subscriptionsQueries,/);
  assert.match(src, /legacyAllowlist:\s*legacyAllowlistQueries/);
  assert.match(src, /legacyAllowMissing:\s*false/);
  assert.match(src, /function ensureAuthWithSubscription\(req, res, next\)/);
  assert.match(src, /function isSubscriptionExempt\(req\)/);
});

test("exempt set covers management, renewal-adjacent, and module-lock paths", () => {
  for (const p of [
    '"/api/auth/user"',
    '"/api/subscriptions"',
    '"/api/subscriptions/my"',
    '"/api/subscriptions/config"',
    '"/api/subscriptions/verify"',
    '"/api/subscriptions/plans"',
    '"/api/subscriptions/plans/active"',
    '"/api/hotel/module-locks"',
    '"/api/hotel/module-locks/me"',
  ]) {
    assert.ok(src.includes(p), `expected exempt path ${p}`);
  }
  // Dynamic exemptions: plan update, subscription cancel, module-lock update.
  assert.match(src, /\/api\/subscriptions\/plans\//);
  assert.match(src, /\/api\/subscriptions\/[^/]+\/cancel/);
  assert.match(src, /\/api\/hotel\/module-locks\//);
});

test("subscription management stays ungated so expired tenants can renew", () => {
  assert.match(routeLine('app.post("/api/subscriptions"'), /, ensureAuth,/);
  assert.match(routeLine('app.post("/api/subscriptions/:id/cancel"'), /, ensureAuth,/);
  assert.match(routeLine('app.get("/api/subscriptions/my"'), /, ensureAuth,/);
  assert.match(routeLine('app.get("/api/subscriptions/plans"'), /, ensureAuth,/);
  assert.match(routeLine('app.get("/api/subscriptions/plans/active"'), /, ensureAuth,/);
  assert.match(routeLine('app.post("/api/subscriptions/plans"'), /, ensureAuth,/);
  assert.match(routeLine('app.put("/api/subscriptions/plans/:id"'), /, ensureAuth,/);
});

test("subscription read routes ARE gated", () => {
  assert.match(routeLine('app.get("/api/subscriptions",'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.get("/api/subscriptions/:id"'), /ensureAuthWithSubscription/);
});

test("hotel module-lock routes stay on plain ensureAuth (own access rules)", () => {
  assert.match(routeLine('app.get("/api/hotel/module-locks"'), /, ensureAuth,/);
  assert.match(routeLine('app.get("/api/hotel/module-locks/me"'), /, ensureAuth,/);
  assert.match(routeLine('app.put("/api/hotel/module-locks/:customerEmail/:module"'), /, ensureAuth,/);
});

test("authentication routes carry no entitlement gate", () => {
  for (const prefix of [
    'app.post("/api/login"',
    'app.post("/api/logout"',
    'app.get("/api/auth/user"',
    'app.get("/api/register/available"',
    'app.post("/api/register"',
    'app.post("/api/password-reset/request"',
    'app.post("/api/password-reset/confirm"',
  ]) {
    assert.doesNotMatch(routeLine(prefix), /ensureAuthWithSubscription/);
  }
});

test("webhook and public routes carry neither ensureAuth nor the gate", () => {
  assert.doesNotMatch(routeLine('app.post("/api/subscriptions/webhook"'), /ensureAuth/);
  assert.doesNotMatch(routeLine('app.get("/api/public/invoices/:invoiceNo"'), /ensureAuth/);
  assert.doesNotMatch(routeLine('app.get("/api/hotel/coupons/:code"'), /ensureAuth/);
});

test("business routes are gated (invoices, hotel bookings, generic catch-alls)", () => {
  assert.match(routeLine('app.post("/api/invoices"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.get("/api/invoices/:invoiceNo"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.post("/api/hotel/bookings"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.get("/api/hotel/bookings"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.get("/api/:resource"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.post("/api/:resource"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.put("/api/:resource/:id"'), /ensureAuthWithSubscription/);
  assert.match(routeLine('app.delete("/api/:resource/:id"'), /ensureAuthWithSubscription/);
});
