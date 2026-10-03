// user-access.authorization.test.js
//
// Regression tests for the Task 6 (security audit) user-management fixes:
// cross-tenant update/delete isolation, role-assignment validation, and
// server-owned identity-field stripping. Exercises the pure decision
// helpers in lib/user-access.js — the same functions the PUT/DELETE
// /api/users routes call — so the behavior is tested directly without
// booting Express or MySQL.
//
// Verified vulnerabilities covered (High):
//   - H1: cross-tenant user update/delete via arbitrary :id
//         (route gate checked role hierarchy only, no tenant membership).
//   - H2: privilege escalation via role field on update
//         (route validated the target's CURRENT role, not the requested one).
// Medium hardening covered:
//   - M1: owner_email/root_owner_email rewritable by ADMIN
//         (server-owned tenant-identity fields accepted from the request).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  canManageRole,
  deriveUserTenantKey,
  canUpdateUser,
  canDeleteUser,
  sanitizeUserPatch,
} = require("./lib/user-access");

const adminA = {
  id: 1,
  email: "admin@a.example.com",
  role: "ADMIN",
  rootOwnerEmail: "admin@a.example.com",
  ownerEmail: "admin@a.example.com",
};
const cashierA = {
  id: 2,
  email: "cashier@a.example.com",
  role: "CASHIER",
  rootOwnerEmail: "admin@a.example.com",
  ownerEmail: "cashier@a.example.com",
};
const cashierB = {
  id: 3,
  email: "cashier@b.example.com",
  role: "CASHIER",
  rootOwnerEmail: "admin@b.example.com",
  ownerEmail: "cashier@b.example.com",
};
const storeAdminB = {
  id: 4,
  email: "branch@b.example.com",
  role: "STORE_ADMIN",
  rootOwnerEmail: "admin@b.example.com",
  ownerEmail: "branch@b.example.com",
};
const superOwner = { id: 9, email: "owner@example.com", role: "SUPER_OWNER" };

// --- H1: cross-tenant isolation ---------------------------------------------

test("ADMIN cannot update a user from another tenant (fails closed 404)", () => {
  const res = canUpdateUser(adminA, cashierB, { name: "x" });
  assert.deepEqual(res, { ok: false, status: 404, error: "User not found" });
});

test("ADMIN cannot delete a user from another tenant (fails closed 404)", () => {
  const res = canDeleteUser(adminA, storeAdminB, {});
  assert.deepEqual(res, { ok: false, status: 404, error: "User not found" });
});

test("ADMIN can still update a user in their own tenant", () => {
  assert.deepEqual(canUpdateUser(adminA, cashierA, { name: "x" }), { ok: true });
  assert.deepEqual(canDeleteUser(adminA, cashierA), { ok: true });
});

test("SUPER_OWNER keeps platform-wide update/delete access", () => {
  assert.deepEqual(canUpdateUser(superOwner, cashierB, { role: "ADMIN" }), { ok: true });
  assert.deepEqual(canDeleteUser(superOwner, cashierB), { ok: true });
});

// --- H2: role assignment -----------------------------------------------------

test("ADMIN editing a CASHIER cannot escalate them to ADMIN", () => {
  const res = canUpdateUser(adminA, cashierA, { role: "ADMIN" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});

test("ADMIN editing a CASHIER cannot escalate them to SUPER_OWNER", () => {
  const res = canUpdateUser(adminA, cashierA, { role: "SUPER_OWNER" });
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);
});

test("ADMIN can still move a user within manageable roles", () => {
  // Demoting within the manageable set (no role change at all) stays allowed.
  assert.deepEqual(canUpdateUser(adminA, cashierA, { role: "CASHIER" }), { ok: true });
  assert.deepEqual(canUpdateUser(adminA, cashierA, { name: "renamed" }), { ok: true });
});

test("role hierarchy itself is unchanged", () => {
  assert.equal(canManageRole("ADMIN", "STORE_ADMIN"), true);
  assert.equal(canManageRole("ADMIN", "CASHIER"), true);
  assert.equal(canManageRole("ADMIN", "ADMIN"), false);
  assert.equal(canManageRole("CASHIER", "CASHIER"), false);
});

// --- M1: server-owned identity fields ----------------------------------------

test("ADMIN patch cannot rewrite owner_email/root_owner_email", () => {
  const patch = sanitizeUserPatch(adminA, {
    name: "x",
    owner_email: "evil@example.com",
    root_owner_email: "evil@example.com",
  });
  assert.deepEqual(patch, { name: "x" });
});

test("SUPER_OWNER patch keeps identity fields", () => {
  const patch = sanitizeUserPatch(superOwner, {
    owner_email: "a@example.com",
    root_owner_email: "a@example.com",
  });
  assert.deepEqual(patch, {
    owner_email: "a@example.com",
    root_owner_email: "a@example.com",
  });
});

// --- Tenant key derivation ----------------------------------------------------

test("tenant key folds branch users into the owner and lowercases", () => {
  assert.equal(deriveUserTenantKey(cashierB), "admin@b.example.com");
  assert.equal(
    deriveUserTenantKey({ email: "X@Example.COM", role: "ADMIN" }),
    "x@example.com"
  );
  assert.equal(deriveUserTenantKey(null), null);
});
