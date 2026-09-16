const { getRequestScope } = require("./request-scope");

// Resolve the concrete scope allowed to read or update an authenticated
// invoice. SUPER_OWNER keeps the existing platform-wide behavior when no
// store is selected; ordinary users must have a concrete store scope.
const getAuthorizedInvoiceScope = (req) => {
  const scope = getRequestScope(req);
  if (String(req.user?.role || "").toUpperCase() === "SUPER_OWNER") {
    return { storeType: scope.storeType || null, storeId: scope.storeId || null, email: null };
  }
  if (scope.storeType && scope.storeId) return scope;
  const error = new Error("A concrete authorized store scope is required");
  error.status = 403;
  throw error;
};

// Resolve an invoice number only within the scope authorized by the session.
// Keeping the query dependency injectable makes this boundary deterministic
// to test without importing the live Express/MySQL bootstrap.
const findAuthorizedInvoiceByNo = (req, invoiceNo, findByInvoiceNoScoped) => {
  const scope = getAuthorizedInvoiceScope(req);
  return findByInvoiceNoScoped(invoiceNo, scope);
};

module.exports = { findAuthorizedInvoiceByNo, getAuthorizedInvoiceScope };
