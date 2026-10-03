// lib/user-access.js
//
// Authorization decisions for the user-management routes (GET/PUT/DELETE
// /api/users in index.js). Extracted into a pure, dependency-free module
// so the security regression suite can exercise the exact decisions the
// routes enforce without booting Express or MySQL.
//
// The two rules this module owns:
//
//   1. Tenant membership: a non-SUPER_OWNER caller may only manage users
//      whose derived tenant key (rootOwnerEmail || ownerEmail || email,
//      lowercased) equals the caller's own. The route gate previously
//      checked only the role hierarchy (canManageRole), so an ADMIN of
//      tenant A could update or delete a STORE_ADMIN/CASHIER of tenant B.
//   2. Role assignment: the requested NEW role (not just the target's
//      current role) must be manageable by the caller. The route gate
//      previously validated only the target's existing role, so an ADMIN
//      editing a CASHIER could set role=ADMIN (or SUPER_OWNER).

const ROLE_MANAGEMENT = {
  SUPER_OWNER: ["SUPER_OWNER", "ADMIN", "STORE_ADMIN", "CASHIER"],
  ADMIN: ["STORE_ADMIN", "CASHIER"],
  STORE_ADMIN: ["CASHIER"],
};

const canManageRole = (currentRole, targetRole) => {
  if (!currentRole || !targetRole) return false;
  return ROLE_MANAGEMENT[currentRole]?.includes(targetRole) || false;
};

// Derived tenant key for a user row/session object. Mirrors the canonical
// database expression COALESCE(NULLIF(root_owner_email,''),NULLIF(owner_email,''),email).
const deriveUserTenantKey = (user) => {
  if (!user) return null;
  const v = user.rootOwnerEmail || user.ownerEmail || user.email;
  const s = String(v == null ? "" : v).trim().toLowerCase();
  return s || null;
};

const isSuperOwner = (user) =>
  String(user?.role || "").toUpperCase() === "SUPER_OWNER";

/**
 * Decide whether currentUser may update targetUser with the requested patch.
 * Assumes both users exist (the route 404s otherwise).
 * Returns { ok: true } or { ok: false, status, error }.
 */
const canUpdateUser = (currentUser, targetUser, updates) => {
  if (isSuperOwner(currentUser)) return { ok: true };
  if (!canManageRole(currentUser?.role, targetUser?.role)) {
    return { ok: false, status: 403, error: "Insufficient permissions to update this user" };
  }
  // Cross-tenant: fail closed with 404 (same as a scoped lookup miss —
  // reveals nothing about whether the id exists in another tenant).
  if (deriveUserTenantKey(currentUser) !== deriveUserTenantKey(targetUser)) {
    return { ok: false, status: 404, error: "User not found" };
  }
  const newRole = updates?.role;
  if (newRole && String(newRole).toUpperCase() !== String(targetUser.role).toUpperCase()) {
    if (!canManageRole(currentUser.role, String(newRole).toUpperCase())) {
      return { ok: false, status: 403, error: "Insufficient permissions to assign this role" };
    }
  }
  return { ok: true };
};

/**
 * Decide whether currentUser may delete targetUser.
 */
const canDeleteUser = (currentUser, targetUser) => {
  if (isSuperOwner(currentUser)) return { ok: true };
  if (!canManageRole(currentUser?.role, targetUser?.role)) {
    return { ok: false, status: 403, error: "Insufficient permissions to delete this user" };
  }
  if (deriveUserTenantKey(currentUser) !== deriveUserTenantKey(targetUser)) {
    return { ok: false, status: 404, error: "User not found" };
  }
  return { ok: true };
};

/**
 * Strip server-owned identity fields from a user patch for non-SUPER_OWNER
 * callers. owner_email/root_owner_email define tenant identity and are
 * stamped by getOwnershipFields at creation — letting an ADMIN rewrite
 * them would detach a user from their tenant (or attach them elsewhere).
 */
const sanitizeUserPatch = (currentUser, patch) => {
  if (isSuperOwner(currentUser)) return patch;
  const { owner_email, root_owner_email, ...rest } = patch || {};
  return rest;
};

module.exports = {
  ROLE_MANAGEMENT,
  canManageRole,
  deriveUserTenantKey,
  canUpdateUser,
  canDeleteUser,
  sanitizeUserPatch,
};
