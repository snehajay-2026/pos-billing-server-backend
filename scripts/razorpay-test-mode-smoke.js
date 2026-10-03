// scripts/razorpay-test-mode-smoke.js
//
// Opt-in smoke test that talks to Razorpay Test Mode APIs. This is the ONLY
// script in the repo that touches the network provider, and it refuses to
// run unless explicitly enabled with Test Mode credentials:
//
//   RAZORPAY_SMOKE=1 RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... \
//     node scripts/razorpay-test-mode-smoke.js
//
// Guards:
//   - RAZORPAY_SMOKE must be exactly "1" (no accidental runs in CI).
//   - KEY_ID must start with "rzp_test_" (Live keys, which start with
//     "rzp_live_", are refused). Never use Live credentials.
//   - KEY_SECRET must be non-empty. It is never printed, logged, or echoed.
//   - No real payment is made: the script creates a plan + subscription,
//     fetches the subscription back, then cancels it. No checkout URL is
//     opened and no payment method is attached.
//
// Usage note: run from the backend directory. Exits 0 on pass, non-zero
// with a one-line failure reason (secret redacted) on fail.

const razorpay = require("../lib/razorpay");

function fail(reason) {
  console.error(`SMOKE FAIL: ${reason}`);
  process.exit(1);
}

async function main() {
  if (process.env.RAZORPAY_SMOKE !== "1") {
    fail("set RAZORPAY_SMOKE=1 to opt in (refusing to run unprompted)");
  }
  const keyId = process.env.RAZORPAY_KEY_ID || "";
  const keySecret = process.env.RAZORPAY_KEY_SECRET || "";
  if (!keyId.startsWith("rzp_test_")) {
    fail("RAZORPAY_KEY_ID must start with rzp_test_ (Live keys refused)");
  }
  if (!keySecret) {
    fail("RAZORPAY_KEY_SECRET is empty");
  }
  const config = { keyId, keySecret };

  // 1. Create a throwaway Test plan (monthly, small amount).
  const plan = await razorpay
    .createPlan(config, {
      name: "Smoke " + Date.now(),
      amount: 1, // Rs 1.00 — smallest meaningful charge
      currency: "INR",
      period: "monthly",
      interval: 1,
    })
    .catch((e) => fail(`createPlan: ${e.message}`));
  if (!plan || !plan.id) fail("createPlan returned no plan id");
  console.log(`plan ok: ${plan.id}`);

  // 2. Create a subscription against that plan (no payment attached).
  const sub = await razorpay
    .createSubscription(config, {
      providerPlanId: plan.id,
      customerEmail: "smoke@example.invalid",
      totalCount: 1,
    })
    .catch((e) => fail(`createSubscription: ${e.message}`));
  if (!sub || !sub.id) fail("createSubscription returned no subscription id");
  console.log(`subscription ok: ${sub.id} status=${sub.status || "?"}`);

  // 3. Fetch it back — proves reads work with the same credentials.
  const fetched = await razorpay
    .fetchSubscription(config, sub.id)
    .catch((e) => fail(`fetchSubscription: ${e.message}`));
  if (!fetched || fetched.id !== sub.id) {
    fail("fetchSubscription did not return the created subscription");
  }
  console.log(`fetch ok: ${fetched.id}`);

  // 4. Cancel it — leaves no dangling Test subscription behind.
  await razorpay
    .cancelSubscription(config, sub.id)
    .catch((e) => fail(`cancelSubscription: ${e.message}`));
  console.log("cancel ok");

  console.log("SMOKE PASS: plan → subscription → fetch → cancel (Test Mode)");
}

main().catch((e) => fail(e && e.message ? e.message : String(e)));
