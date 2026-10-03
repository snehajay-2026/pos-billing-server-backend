// lib/legacy-allowlist.js
//
// SUPER_OWNER-approved legacy tenant allowlist (Task 10). Tenants whose
// canonical key appears here keep access without a subscription row.
// Exact-match on the canonical key (trimmed + lowercased); lookup failure
// fails closed (not allowlisted). Management is SUPER_OWNER-only at the
// route layer; this module owns storage + audit shape only.

const { canonicalizeTenantKey } = require("./subscription-dates");

/**
 * In-memory allowlist — used by unit tests and as the interface contract.
 * Production uses db/queries/legacy-allowlist.js which exposes the same
 * three methods.
 */
function makeMemoryAllowlist(entries = []) {
  const set = new Set(entries.map((e) => canonicalizeTenantKey(e)).filter(Boolean));
  return {
    isAllowlisted(canonicalKey) {
      const k = canonicalizeTenantKey(canonicalKey);
      if (!k) return false;
      return set.has(k);
    },
    async add(canonicalKey, { approvedBy, reason } = {}) {
      const k = canonicalizeTenantKey(canonicalKey);
      if (!k) throw new Error("Invalid tenant key");
      set.add(k);
      return { tenantKey: k, approvedBy: approvedBy || null, reason: reason || null };
    },
    async remove(canonicalKey) {
      const k = canonicalizeTenantKey(canonicalKey);
      set.delete(k);
      return { tenantKey: k };
    },
  };
}

module.exports = {
  canonicalizeTenantKey,
  makeMemoryAllowlist,
};
