// lib/billable-customer.js
//
// F8: shared validator for the `customerId` carried on a new invoice
// payload. Both POST /api/invoices and POST /api/invoices/checkout call
// `resolveBillableCustomer(customerId, scope)` and use the returned id
// (or `null` for the walking-customer path) as the canonical
// `invoices.customer_id` value to persist.
//
// Rules:
//   - null / undefined / empty input → returns null (preserved
//     walking-customer behavior; the existing customer_name +
//     customer_mobile strings continue to carry the human-readable
//     metadata).
//   - non-numeric / non-positive input → throws Error with .status=400.
//   - same-store lookup via customersQueries.findByIdScoped(id, scope).
//     The query module already filters by `_store_type + _store_id +
//     _user_email`, so cross-store rows return null and surface as 404
//     here. We deliberately use findByIdScoped (not the admin-bypass
//     variant) so a cashier cannot link a customer they could not see
//     in their POS search — and even an admin cannot bill against a
//     customer from a store they are not currently scoped to.
//   - found but `approvalStatus` is 'pending' or 'rejected' → 422.
//   - found and approved → returns { id }.
//
// This module is intentionally the only place these rules live so that
// every invoice-creation path — including future ones — shares one
// source of truth.

const resolveBillableCustomer = async (customerId, scope, deps = {}) => {
  const customersQueries = deps.customersQueries || require("../db/queries/customers");
  if (customerId == null || customerId === "") return null;
  const parsed = Number(customerId);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    const err = new Error("customerId must be a positive number");
    err.status = 400;
    throw err;
  }
  const found = await customersQueries.findByIdScoped(parsed, scope);
  if (!found) {
    const err = new Error("Customer not found or not in your store");
    err.status = 404;
    throw err;
  }
  if (found.approvalStatus && found.approvalStatus !== "approved") {
    const err = new Error(
      `Customer is ${found.approvalStatus} — only approved customers can be billed`
    );
    err.status = 422;
    throw err;
  }
  return { id: Number(found.id) };
};

module.exports = { resolveBillableCustomer };
