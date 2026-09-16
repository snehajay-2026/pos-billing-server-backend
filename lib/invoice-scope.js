// Build the parameterized predicate used by authenticated invoice-number
// lookups. The scope is resolved from req.user before this helper is called.
const buildInvoiceNoScope = (invoiceNo, scope = {}) => {
  const conditions = ["invoice_no = ?"];
  const params = [String(invoiceNo)];
  if (scope.storeType) {
    conditions.push("_store_type = ?");
    params.push(scope.storeType);
  }
  if (scope.storeId) {
    conditions.push("_store_id = ?");
    params.push(scope.storeId);
  }
  if (scope.email) {
    conditions.push("_user_email = ?");
    params.push(scope.email);
  }
  return { where: conditions.join(" AND "), params };
};

module.exports = { buildInvoiceNoScope };
