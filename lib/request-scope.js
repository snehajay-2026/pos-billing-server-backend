// Resolve the store scope authorized for an authenticated request.
// Ordinary users are permanently bound to the session-loaded store. A
// SUPER_OWNER may explicitly narrow a request to a selected store; without
// that hint the existing platform-wide behavior is preserved.
//
// Returns an object that includes `role` so query helpers can branch on
// the caller's role without re-deriving it from req.user — e.g. the
// customers query module uses scope.role to decide whether cashier-
// submitted rows start in `pending` vs. admin-submitted rows in `approved`.
const getRequestScope = (req) => {
  const role = String(req.user?.role || "").toUpperCase();
  const query = req.query || {};
  const scalar = (value) => {
    if (Array.isArray(value)) return value.length === 1 ? String(value[0] || "").trim() : "";
    return value == null ? "" : String(value).trim();
  };
  const userStoreType = scalar(req.user?.storeType);
  const userStoreId = scalar(req.user?.storeId) || userStoreType;
  const queryStoreType = scalar(query.storeType);
  const queryStoreId = scalar(query.storeId);

  if (role !== "SUPER_OWNER") {
    return {
      storeType: userStoreType,
      storeId: userStoreId,
      email: String(req.user?.email || "").trim(),
      role,
    };
  }

  // `email` is always populated for SUPER_OWNER even when unscoped so the
  // coupon redemption fallback can resolve owner-scoped coupons.
  if (!queryStoreType) {
    return {
      storeType: null,
      storeId: null,
      email: String(req.user?.email || "").trim(),
      role,
    };
  }
  return {
    storeType: queryStoreType,
    storeId: queryStoreId || queryStoreType,
    email: String(query.email || req.user?.email || "").trim(),
    role,
  };
};

module.exports = { getRequestScope };
