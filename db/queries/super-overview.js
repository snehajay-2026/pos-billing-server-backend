// db/queries/super-overview.js
//
// Platform-wide aggregates for GET /api/super/overview (SUPER_OWNER only).
// Every SELECT here is a COUNT / SUM — the module never selects personal
// data (no email, name, phone, address) and never selects payment rows,
// so a response built from it cannot leak per-user or per-payment data.
//
// Tenant identity follows the repository's established rules:
//   - A tenant is a root_owner_email (see lib/subscription-service.js
//     resolveTenantEmail and the subscriptions table comment: "one row
//     per tenant (root_owner_email)"). totalTenants counts distinct
//     non-empty root_owner_email values on non-SUPER_OWNER user rows.
//   - There is NO stores/branches registry table. Stores are implicit
//     (store_type, store_id) pairs carried on user rows, so totalStores
//     counts distinct pairs on non-SUPER_OWNER user rows. There is no
//     branch registry at all (shifts.branch_name is a free-text label,
//     not a registry), so branches are reported as null with a reason.
//   - Subscriptions carry UNIQUE(tenant_email): one row per tenant, so a
//     GROUP BY status cannot double-count.
//   - Revenue is gross captured money: SUM(amount) over payment_records
//     rows with status='captured'. Amounts are stored in rupees (the
//     webhook converts Razorpay paise at capture time). Refunds are NOT
//     netted: no refund writer exists in the webhook path, so netting
//     would be speculative.
//
// The pool is required LAZILY so this module stays importable without DB
// credentials (same reason as db/queries/dashboard.js).

let poolRef = null;
const getPool = () => {
  if (!poolRef) poolRef = require("../pool");
  return poolRef;
};

// Subset of subscriptions.status ENUM surfaced on the dashboard. Kept in
// dashboard-card order, not ENUM order.
const KNOWN_STATUSES = ["trialing", "active", "past_due", "cancelled", "expired"];

const REVENUE_DEFINITION =
  "Gross sum of payment_records.amount in rupees with status 'captured', " +
  "bucketed by created_at (UTC): calendar month-to-date and calendar " +
  "year-to-date. Refunds are not netted.";

const BRANCHES_UNAVAILABLE =
  "No branch registry table exists; shifts.branch_name is a free-text " +
  "label, not a registry, so branches cannot be counted without inventing data.";

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const zeroedStatusCounts = () => ({
  trialing: 0,
  active: 0,
  past_due: 0,
  cancelled: 0,
  expired: 0,
});

// UTC calendar bounds, pure for tests. Returns ISO strings so callers can
// pass them straight into created_at comparisons (DATETIME round-trips
// as UTC strings per db/pool.js timezone:'Z').
const monthBoundsUTC = (now = new Date()) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
};

const yearBoundsUTC = (now = new Date()) => {
  const start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
  return { start: start.toISOString(), end: end.toISOString() };
};

// Pure assembler: turns raw query outputs into the response shape. Empty
// tables arrive as zero counts / empty row arrays / NULL sums; NULL sums
// become 0 (a correct aggregate over no rows, not a fabricated value).
// Unknown subscription statuses are ignored rather than surfaced, so a
// future ENUM value cannot silently corrupt the dashboard cards.
const buildOverviewResponse = ({
  tenantCount = 0,
  storeCount = 0,
  userCount = 0,
  statusRows = [],
  monthlyRevenue = null,
  yearlyRevenue = null,
  generatedAt = null,
} = {}) => {
  const byStatus = zeroedStatusCounts();
  for (const row of statusRows || []) {
    if (Object.prototype.hasOwnProperty.call(byStatus, row?.status)) {
      byStatus[row.status] = toNumber(row.c);
    }
  }
  const total =
    byStatus.trialing +
    byStatus.active +
    byStatus.past_due +
    byStatus.cancelled +
    byStatus.expired;
  return {
    tenants: { total: toNumber(tenantCount) },
    stores: { total: toNumber(storeCount), branches: null },
    users: { total: toNumber(userCount) },
    subscriptions: { total, ...byStatus },
    revenue: {
      monthly: monthlyRevenue == null ? 0 : toNumber(monthlyRevenue),
      yearly: yearlyRevenue == null ? 0 : toNumber(yearlyRevenue),
      currency: "INR",
      definition: REVENUE_DEFINITION,
    },
    meta: {
      generatedAt: generatedAt || new Date().toISOString(),
      branchesUnavailable: BRANCHES_UNAVAILABLE,
    },
  };
};

async function getOverview(now = new Date()) {
  const { query } = getPool();
  const month = monthBoundsUTC(now);
  const year = yearBoundsUTC(now);
  const [tenants, stores, users, statusRows, monthly, yearly] =
    await Promise.all([
      query(
        `SELECT COUNT(DISTINCT root_owner_email) AS c FROM users
         WHERE UPPER(role) <> 'SUPER_OWNER'
           AND root_owner_email IS NOT NULL AND root_owner_email <> ''`
      ),
      query(
        `SELECT COUNT(DISTINCT store_type, store_id) AS c FROM users
         WHERE UPPER(role) <> 'SUPER_OWNER'
           AND store_type IS NOT NULL AND store_type <> ''
           AND store_id IS NOT NULL AND store_id <> ''`
      ),
      query(
        `SELECT COUNT(*) AS c FROM users WHERE UPPER(role) <> 'SUPER_OWNER'`
      ),
      query(`SELECT status, COUNT(*) AS c FROM subscriptions GROUP BY status`),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records
         WHERE status = 'captured' AND created_at >= ? AND created_at < ?`,
        [month.start, month.end]
      ),
      query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM payment_records
         WHERE status = 'captured' AND created_at >= ? AND created_at < ?`,
        [year.start, year.end]
      ),
    ]);
  return buildOverviewResponse({
    tenantCount: tenants[0]?.[0]?.c,
    storeCount: stores[0]?.[0]?.c,
    userCount: users[0]?.[0]?.c,
    statusRows: statusRows[0],
    monthlyRevenue: monthly[0]?.[0]?.total,
    yearlyRevenue: yearly[0]?.[0]?.total,
  });
}

module.exports = {
  KNOWN_STATUSES,
  REVENUE_DEFINITION,
  BRANCHES_UNAVAILABLE,
  monthBoundsUTC,
  yearBoundsUTC,
  buildOverviewResponse,
  getOverview,
};
