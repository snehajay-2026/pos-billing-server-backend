// lib/subscription-service.test.js
//
// Focused unit tests for the pure subscription service layer. Every test
// uses injected fakes — no HTTP, no process.env, no real Razorpay calls,
// no real database.
//
// What these tests own:
//   - monthly billing selects provider_plan_id
//   - yearly billing selects provider_plan_id_yearly
//   - missing monthly provider plan ID fails before any Razorpay call
//   - missing yearly provider plan ID fails before any Razorpay call
//   - frontend amount manipulation is ignored (price always from DB)
//   - frontend Razorpay plan ID manipulation is ignored
//   - correct Razorpay subscription ID is persisted locally
//   - ADMIN ownership isolation (cannot subscribe another tenant)
//   - STORE_ADMIN is denied for subscription management (create/cancel/
//     change plan/pay) — it inherits the parent ADMIN tenant's subscription,
//     but keeps tenant resolution for READ/entitlement purposes
//   - CASHIER is denied
//   - SUPER_OWNER bypass (may subscribe any tenant)

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canManageSubscription,
  resolveTenantEmail,
  selectProviderPlanId,
  selectLocalPrice,
  createSubscription,
  cancelSubscription,
} = require("./subscription-service");

// --- Fakes -------------------------------------------------------------------

function makeFakes({
  plan = null,
  existingSubscription = null,
  razorpaySubId = "sub_TEST123",
} = {}) {
  const calls = {
    razorpayCreateSubscription: [],
    razorpayCancelSubscription: [],
    subscriptionCreate: [],
    subscriptionUpdate: [],
    eventAppend: [],
  };

  const plansQueries = {
    findById: async (id) => {
      calls.planId = id;
      return plan;
    },
  };

  const subscriptionsQueries = {
    create: async (data) => {
      calls.subscriptionCreate.push(data);
      return { id: 1, ...data };
    },
    findById: async (id) => {
      calls.subscriptionId = id;
      return existingSubscription;
    },
    update: async (id, fields) => {
      calls.subscriptionUpdate.push({ id, fields });
      return { id, ...existingSubscription, ...fields };
    },
  };

  const subscriptionEventsQueries = {
    append: async (data) => {
      calls.eventAppend.push(data);
      return { id: 1, ...data };
    },
  };

  const razorpay = {
    createSubscription: async (config, params) => {
      calls.razorpayCreateSubscription.push({ config, params });
      return { id: razorpaySubId, status: "created" };
    },
    cancelSubscription: async (config, subId) => {
      calls.razorpayCancelSubscription.push({ config, subId });
      return { id: subId, status: "cancelled" };
    },
  };

  const razorpayConfig = { keyId: "rzp_test_123", keySecret: "secret-value" };

  return {
    deps: {
      plansQueries,
      subscriptionsQueries,
      subscriptionEventsQueries,
      razorpay,
      razorpayConfig,
    },
    calls,
  };
}

const VALID_PLAN = {
  id: 1,
  name: "Pro Plan",
  monthlyPrice: 999,
  yearlyPrice: 9990,
  providerPlanId: "plan_monthly_ABC",
  providerPlanIdYearly: "plan_yearly_XYZ",
  active: true,
};

const SUPER_OWNER_SESSION = {
  role: "SUPER_OWNER",
  email: "super@example.com",
};

const ADMIN_SESSION = {
  role: "ADMIN",
  email: "admin@example.com",
  rootOwnerEmail: "admin@example.com",
  ownerEmail: "admin@example.com",
};

const STORE_ADMIN_SESSION = {
  role: "STORE_ADMIN",
  email: "store@example.com",
  rootOwnerEmail: "admin@example.com",
  ownerEmail: "store@example.com",
  storeType: "retail",
  storeId: "branch-1",
};

const CASHIER_SESSION = {
  role: "CASHIER",
  email: "cashier@example.com",
  rootOwnerEmail: "admin@example.com",
  ownerEmail: "store@example.com",
};

// ===========================================================================
// 1. Role-based authorization
// ===========================================================================

// ===========================================================================
// 1. Role-based authorization
//
// SUPER_OWNER → allowed. ADMIN → allowed. STORE_ADMIN → DENIED.
// CASHIER → DENIED.
//
// STORE_ADMIN belongs to one branch of an ADMIN tenant and inherits the
// parent tenant's subscription. It must never create, cancel, change plan,
// or pay — it may only view. This test block owns that contract.
test("role authorization: SUPER_OWNER and ADMIN allowed; STORE_ADMIN and CASHIER denied", () => {
  assert.equal(canManageSubscription("SUPER_OWNER"), true);
  assert.equal(canManageSubscription("ADMIN"), true);
  assert.equal(canManageSubscription("STORE_ADMIN"), false);
  assert.equal(canManageSubscription("CASHIER"), false);
  // Case-insensitivity is exercised for the denied roles as a guard against
  // role-string drift.
  assert.equal(canManageSubscription("store_admin"), false);
  assert.equal(canManageSubscription("cashier"), false);
});

test("CASHIER is denied on createSubscription", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: 1,
      billingCycle: "monthly",
      session: CASHIER_SESSION,
    }),
    (err) => {
      assert.equal(err.code, "FORBIDDEN");
      assert.equal(err.status, 403);
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
  assert.equal(calls.subscriptionCreate.length, 0);
});

test("STORE_ADMIN is denied on createSubscription", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: 1,
      billingCycle: "monthly",
      session: STORE_ADMIN_SESSION,
      requestedTenantEmail: "other@example.com",
    }),
    (err) => {
      assert.equal(err.code, "FORBIDDEN");
      assert.equal(err.status, 403);
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
  assert.equal(calls.subscriptionCreate.length, 0);
});

test("CASHIER is denied on cancelSubscription", async () => {
  const { deps, calls } = makeFakes({
    existingSubscription: { id: 1, tenantEmail: "admin@example.com", razorpaySubscriptionId: "sub_1" },
  });
  await assert.rejects(
    () => cancelSubscription(deps, { subscriptionId: 1, session: CASHIER_SESSION }),
    (err) => {
      assert.equal(err.code, "FORBIDDEN");
      return true;
    }
  );
  assert.equal(calls.razorpayCancelSubscription.length, 0);
});

test("STORE_ADMIN is denied on cancelSubscription", async () => {
  const { deps, calls } = makeFakes({
    existingSubscription: { id: 1, tenantEmail: "admin@example.com", razorpaySubscriptionId: "sub_1" },
  });
  await assert.rejects(
    () => cancelSubscription(deps, { subscriptionId: 1, session: STORE_ADMIN_SESSION }),
    (err) => {
      assert.equal(err.code, "FORBIDDEN");
      return true;
    }
  );
  assert.equal(calls.razorpayCancelSubscription.length, 0);
  assert.equal(calls.subscriptionUpdate.length, 0);
});

// ===========================================================================
// 2. Monthly vs yearly provider plan selection
// ===========================================================================

test("monthly billing selects provider_plan_id", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: SUPER_OWNER_SESSION,
  });
  assert.equal(calls.razorpayCreateSubscription.length, 1);
  assert.equal(calls.razorpayCreateSubscription[0].params.providerPlanId, "plan_monthly_ABC");
});

test("yearly billing selects provider_plan_id_yearly", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "yearly",
    session: SUPER_OWNER_SESSION,
  });
  assert.equal(calls.razorpayCreateSubscription.length, 1);
  assert.equal(calls.razorpayCreateSubscription[0].params.providerPlanId, "plan_yearly_XYZ");
});

test("selectProviderPlanId returns monthly plan ID for monthly cycle", () => {
  assert.equal(selectProviderPlanId(VALID_PLAN, "monthly"), "plan_monthly_ABC");
});

test("selectProviderPlanId returns yearly plan ID for yearly cycle", () => {
  assert.equal(selectProviderPlanId(VALID_PLAN, "yearly"), "plan_yearly_XYZ");
});

test("selectLocalPrice returns monthly price for monthly cycle", () => {
  assert.equal(selectLocalPrice(VALID_PLAN, "monthly"), 999);
});

test("selectLocalPrice returns yearly price for yearly cycle", () => {
  assert.equal(selectLocalPrice(VALID_PLAN, "yearly"), 9990);
});

// ===========================================================================
// 3. Missing provider plan ID fails before Razorpay call
// ===========================================================================

test("missing monthly provider plan ID fails before Razorpay call", async () => {
  const planNoMonthly = { ...VALID_PLAN, providerPlanId: null };
  const { deps, calls } = makeFakes({ plan: planNoMonthly });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: 1,
      billingCycle: "monthly",
      session: SUPER_OWNER_SESSION,
    }),
    (err) => {
      assert.equal(err.code, "PROVIDER_PLAN_MISSING");
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
  assert.equal(calls.subscriptionCreate.length, 0);
});

test("missing yearly provider plan ID fails before Razorpay call", async () => {
  const planNoYearly = { ...VALID_PLAN, providerPlanIdYearly: null };
  const { deps, calls } = makeFakes({ plan: planNoYearly });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: 1,
      billingCycle: "yearly",
      session: SUPER_OWNER_SESSION,
    }),
    (err) => {
      assert.equal(err.code, "PROVIDER_PLAN_MISSING");
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
  assert.equal(calls.subscriptionCreate.length, 0);
});

// ===========================================================================
// 4. Frontend manipulation is ignored
// ===========================================================================

test("frontend amount manipulation is ignored — price always from DB", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  // Even if a malicious caller passes amount in the session or params,
  // the service uses the DB price exclusively.
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: { ...SUPER_OWNER_SESSION, amount: 0.01 },
  });
  assert.equal(calls.subscriptionCreate.length, 1);
  assert.equal(calls.subscriptionCreate[0].subscribedPrice, 999);
});

test("frontend Razorpay plan ID manipulation is ignored", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  // Even if a caller passes a providerPlanId in the session,
  // the service uses the DB-derived value exclusively.
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: { ...SUPER_OWNER_SESSION, providerPlanId: "plan_malicious" },
  });
  assert.equal(calls.razorpayCreateSubscription.length, 1);
  assert.equal(calls.razorpayCreateSubscription[0].params.providerPlanId, "plan_monthly_ABC");
});

// ===========================================================================
// 5. Razorpay subscription ID persistence
// ===========================================================================

test("correct Razorpay subscription ID is persisted locally", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN, razorpaySubId: "sub_PERSIST_456" });
  const result = await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: SUPER_OWNER_SESSION,
  });
  assert.equal(calls.subscriptionCreate.length, 1);
  assert.equal(calls.subscriptionCreate[0].razorpaySubscriptionId, "sub_PERSIST_456");
  assert.equal(result.subscription.razorpaySubscriptionId, "sub_PERSIST_456");
});

// ===========================================================================
// 6. Ownership isolation
// ===========================================================================

test("ADMIN cannot subscribe another tenant", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: ADMIN_SESSION,
    requestedTenantEmail: "other@example.com",
  });
  // The service must ignore requestedTenantEmail for non-SUPER_OWNER.
  assert.equal(calls.subscriptionCreate.length, 1);
  assert.equal(calls.subscriptionCreate[0].tenantEmail, "admin@example.com");
});

// STORE_ADMIN resolves to the parent ADMIN tenant for READ/entitlement
// purposes. The tenant resolution is unchanged by the management denial:
// a STORE_ADMIN with rootOwnerEmail "admin@example.com" always lands on
// "admin@example.com", and a forged requestedTenantEmail is ignored.
test("STORE_ADMIN resolves to parent ADMIN tenant", () => {
  assert.equal(
    resolveTenantEmail(STORE_ADMIN_SESSION, "other@example.com"),
    "admin@example.com"
  );
});

test("SUPER_OWNER can subscribe any tenant", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: SUPER_OWNER_SESSION,
    requestedTenantEmail: "tenant@example.com",
  });
  assert.equal(calls.subscriptionCreate.length, 1);
  assert.equal(calls.subscriptionCreate[0].tenantEmail, "tenant@example.com");
});

test("SUPER_OWNER defaults to own email when no tenant specified", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: SUPER_OWNER_SESSION,
  });
  assert.equal(calls.subscriptionCreate[0].tenantEmail, "super@example.com");
});

// ===========================================================================
// 7. resolveTenantEmail helper
// ===========================================================================

test("resolveTenantEmail ignores requestedTenantEmail for ADMIN", () => {
  const result = resolveTenantEmail(ADMIN_SESSION, "attacker@example.com");
  assert.equal(result, "admin@example.com");
});

test("resolveTenantEmail ignores requestedTenantEmail for STORE_ADMIN", () => {
  const result = resolveTenantEmail(STORE_ADMIN_SESSION, "attacker@example.com");
  assert.equal(result, "admin@example.com");
});

test("resolveTenantEmail honors requestedTenantEmail for SUPER_OWNER", () => {
  const result = resolveTenantEmail(SUPER_OWNER_SESSION, "tenant@example.com");
  assert.equal(result, "tenant@example.com");
});

// ===========================================================================
// 8. Cancel subscription
// ===========================================================================

test("cancelSubscription calls Razorpay and updates local status", async () => {
  const existingSub = {
    id: 1,
    tenantEmail: "admin@example.com",
    razorpaySubscriptionId: "sub_CANCEL_123",
    status: "active",
  };
  const { deps, calls } = makeFakes({ existingSubscription: existingSub });
  const result = await cancelSubscription(deps, {
    subscriptionId: 1,
    session: SUPER_OWNER_SESSION,
  });
  assert.equal(calls.razorpayCancelSubscription.length, 1);
  assert.equal(calls.razorpayCancelSubscription[0].subId, "sub_CANCEL_123");
  assert.equal(calls.subscriptionUpdate.length, 1);
  assert.equal(calls.subscriptionUpdate[0].fields.status, "cancelled");
  assert.equal(result.status, "cancelled");
});

test("ADMIN cannot cancel another tenant's subscription", async () => {
  const existingSub = {
    id: 1,
    tenantEmail: "other@example.com",
    razorpaySubscriptionId: "sub_1",
    status: "active",
  };
  const { deps, calls } = makeFakes({ existingSubscription: existingSub });
  await assert.rejects(
    () => cancelSubscription(deps, { subscriptionId: 1, session: ADMIN_SESSION }),
    (err) => {
      assert.equal(err.code, "FORBIDDEN");
      return true;
    }
  );
  assert.equal(calls.razorpayCancelSubscription.length, 0);
});

// ===========================================================================
// 9. Validation
// ===========================================================================

test("invalid billingCycle is rejected", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: 1,
      billingCycle: "weekly",
      session: SUPER_OWNER_SESSION,
    }),
    (err) => {
      assert.equal(err.code, "VALIDATION");
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
});

test("missing planId is rejected", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: null,
      billingCycle: "monthly",
      session: SUPER_OWNER_SESSION,
    }),
    (err) => {
      assert.equal(err.code, "VALIDATION");
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
});

test("non-existent plan is rejected", async () => {
  const { deps, calls } = makeFakes({ plan: null });
  await assert.rejects(
    () => createSubscription(deps, {
      planId: 999,
      billingCycle: "monthly",
      session: SUPER_OWNER_SESSION,
    }),
    (err) => {
      assert.equal(err.code, "NOT_FOUND");
      return true;
    }
  );
  assert.equal(calls.razorpayCreateSubscription.length, 0);
});

// ===========================================================================
// 10. Per-tenant model: two ADMINs remain isolated, two branches under the
// same ADMIN share one tenant, STORE_ADMIN/CASHIER resolve to the parent
// ADMIN tenant for READ/entitlement purposes.
//
// These are the regression guards for the per-tenant commercial model:
//   Rahul (ADMIN)   → Retail tenant → Subscription A
//   Sneha (ADMIN)   → Service tenant → Subscription B
//   Pune / Sangli / Kolhapur STORE_ADMINs → all share Rahul's tenant
// ===========================================================================

// Two STORE_ADMIN sessions that share an ADMIN parent — same rootOwnerEmail,
// different (store_type, store_id).
const STORE_ADMIN_BRANCH_PUNE = {
  role: "STORE_ADMIN",
  email: "pune@retail.example.com",
  storeType: "retail",
  storeId: "Pune Retail",
  rootOwnerEmail: "rahul@example.com",
  ownerEmail: "rahul@example.com",
};
const STORE_ADMIN_BRANCH_SANGLI = {
  role: "STORE_ADMIN",
  email: "sangli@retail.example.com",
  storeType: "retail",
  storeId: "Sangli Retail",
  rootOwnerEmail: "rahul@example.com",
  ownerEmail: "rahul@example.com",
};
// A different ADMIN tenant entirely.
const SNEHA_ADMIN_SESSION = {
  role: "ADMIN",
  email: "sneha@example.com",
  rootOwnerEmail: "sneha@example.com",
  ownerEmail: "sneha@example.com",
};
// A CASHIER within Rahul's tenant.
const RAHUL_CASHIER_SESSION = {
  role: "CASHIER",
  email: "cashier@retail.example.com",
  storeType: "retail",
  storeId: "Pune Retail",
  rootOwnerEmail: "rahul@example.com",
  ownerEmail: "rahul@example.com",
};

test("two branches under one ADMIN resolve to the same tenant", () => {
  assert.equal(
    resolveTenantEmail(STORE_ADMIN_BRANCH_PUNE),
    "rahul@example.com"
  );
  assert.equal(
    resolveTenantEmail(STORE_ADMIN_BRANCH_SANGLI),
    "rahul@example.com"
  );
  // Even though storeType/storeId differ, the tenant is the parent ADMIN.
  assert.equal(
    resolveTenantEmail(STORE_ADMIN_BRANCH_PUNE, "forged@attacker.example.com"),
    "rahul@example.com"
  );
});

test("two different ADMINs remain isolated as tenants", () => {
  assert.equal(
    resolveTenantEmail(ADMIN_SESSION),
    "admin@example.com"
  );
  assert.equal(
    resolveTenantEmail(SNEHA_ADMIN_SESSION),
    "sneha@example.com"
  );
  // Sneha cannot target Rahul's tenant — the requestedTenantEmail parameter
  // is ignored for non-SUPER_OWNER, so Sneha's tenant stays sneha@example.com.
  assert.notEqual(
    resolveTenantEmail(SNEHA_ADMIN_SESSION),
    resolveTenantEmail(ADMIN_SESSION)
  );
});

test("CASHIER resolves to the parent ADMIN tenant for READ/entitlement", () => {
  assert.equal(
    resolveTenantEmail(RAHUL_CASHIER_SESSION),
    "rahul@example.com"
  );
  // A forged tenant email is ignored — the cashier can never see Sneha's
  // subscription through this code path.
  assert.equal(
    resolveTenantEmail(RAHUL_CASHIER_SESSION, "sneha@example.com"),
    "rahul@example.com"
  );
});

test("ADMIN cannot subscribe Sneha's tenant via a forged payload", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: ADMIN_SESSION,
    requestedTenantEmail: "sneha@example.com",
  });
  assert.equal(calls.subscriptionCreate.length, 1);
  // Rahul subscribes his own tenant, NOT Sneha's.
  assert.equal(calls.subscriptionCreate[0].tenantEmail, "admin@example.com");
  assert.notEqual(
    calls.subscriptionCreate[0].tenantEmail,
    "sneha@example.com"
  );
});

test("SUPER_OWNER can subscribe any tenant — including Sneha", async () => {
  const { deps, calls } = makeFakes({ plan: VALID_PLAN });
  await createSubscription(deps, {
    planId: 1,
    billingCycle: "monthly",
    session: SUPER_OWNER_SESSION,
    requestedTenantEmail: "sneha@example.com",
  });
  assert.equal(calls.subscriptionCreate.length, 1);
  assert.equal(calls.subscriptionCreate[0].tenantEmail, "sneha@example.com");
});
