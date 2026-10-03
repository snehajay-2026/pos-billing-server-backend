// db/queries/super-tenants.js
//
// Platform tenant directory for GET /api/super/tenants (SUPER_OWNER only).
// There is NO tenant registry table — a tenant is a distinct business-owner
// identity derived from persisted user rows, following the repository's
// established rule (see lib/subscription-service.js resolveTenantEmail and
// lib/require-active-subscription.js):
//   root_owner_email || owner_email || email
//
// How branch users are handled: STORE_ADMIN / CASHIER rows carry the
// owner's root_owner_email (see getOwnershipFields in index.js — created
// users inherit the creator's rootOwnerEmail), so GROUP BY the derived key
// folds every branch user into their owner's tenant instead of counting
// them as separate tenants. SUPER_OWNER rows are excluded outright.
//
// Per-tenant subscription enrichment is schema-backed: subscriptions has
// UNIQUE(tenant_email) — one row per tenant — so a LEFT JOIN on the same
// derived key yields at most one subscription status/plan per tenant.
// Fields with no schema support (owner display name/phone, per-tenant
// revenue, branch breakdowns) are deliberately NOT selected; the UI must
// not present them.
//
// The pool is required via destructuring at module top, matching
// payment-records.js / subscription-events.js.

const { query } = require("../pool");

// Derived tenant key, mirrored by deriveTenantEmail below. NULLIF turns
// '' into NULL so COALESCE falls through to the next identity column;
// email is NOT NULL so the key is never NULL.
const TENANT_KEY = `COALESCE(NULLIF(root_owner_email, ''), NULLIF(owner_email, ''), email)`;

const PLATFORM_PAGE_DEFAULT = 1;
const PLATFORM_LIMIT_DEFAULT = 25;
const PLATFORM_LIMIT_MAX = 100;

// Pure helper mirroring TENANT_KEY for a single row object (snake_case
// DB row or camelCase service object). Exported for tests.
const deriveTenantEmail = (row) => {
  if (!row) return null;
  const v =
    row.root_owner_email ||
    row.rootOwnerEmail ||
    row.owner_email ||
    row.ownerEmail ||
    row.email;
  const s = String(v == null ? "" : v).trim();
  return s || null;
};

const normalizePlatformPaging = (page, limit) => {
  let p = Number.parseInt(page, 10);
  if (!Number.isFinite(p) || p < 1) p = PLATFORM_PAGE_DEFAULT;
  let l = Number.parseInt(limit, 10);
  if (!Number.isFinite(l) || l < 1) l = PLATFORM_LIMIT_DEFAULT;
  if (l > PLATFORM_LIMIT_MAX) l = PLATFORM_LIMIT_MAX;
  return { page: p, limit: l };
};

const toNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// UI allowlist: tenant identity + schema-backed aggregates only. No
// password hash, reset_token, phone, address, name, or raw user rows.
const toPlatformTenant = (row) => {
  if (!row) return null;
  return {
    tenantEmail: row.tenant_email || null,
    userCount: toNumber(row.user_count),
    storeCount: toNumber(row.store_count),
    subscriptionStatus: row.subscription_status || null,
    planName: row.plan_name || null,
    firstSeen: row.first_seen || null,
  };
};

const TENANT_WHERE = `WHERE UPPER(u.role) <> 'SUPER_OWNER'`;

async function countPlatformTenants() {
  const [rows] = await query(
    `SELECT COUNT(DISTINCT ${TENANT_KEY}) AS c FROM users u ${TENANT_WHERE}`
  );
  return toNumber(rows[0]?.c);
}

async function listPlatformTenants({ page, limit } = {}) {
  const { page: p, limit: l } = normalizePlatformPaging(page, limit);
  const offset = (p - 1) * l;
  const [rows] = await query(
    `SELECT ${TENANT_KEY} AS tenant_email,
       COUNT(*) AS user_count,
       COUNT(DISTINCT u.store_type, u.store_id) AS store_count,
       MIN(s.status) AS subscription_status,
       MIN(s.plan_name) AS plan_name,
       MIN(u.created_at) AS first_seen
     FROM users u
     LEFT JOIN subscriptions s ON s.tenant_email = ${TENANT_KEY}
     ${TENANT_WHERE}
     GROUP BY ${TENANT_KEY}
     ORDER BY tenant_email ASC
     LIMIT ? OFFSET ?`,
    [l, offset]
  );
  return { tenants: rows.map(toPlatformTenant), page: p, limit: l };
}

// ---------------------------------------------------------------------------
// Tenant detail (SUPER_OWNER only, via GET /api/super/tenants/:tenantEmail).
//
// The requested email is matched against the SAME canonical derived key —
// never trusted as an identity by itself. A branch user's own email matches
// nothing (their row carries the owner's root_owner_email, so the derived
// key is the owner's address), which yields 404 rather than leaking the
// owner's tenant under a branch identity. Every query below is scoped to
// that one canonical key with a bound parameter, so no other tenant's
// users, stores, or subscription can appear.
//
// Four separate bounded queries instead of one mega-JOIN: joins across
// users × stores × subscriptions would multiply the user/store counts.
// Each result is allowlisted at the SELECT level — no password hash,
// reset_token, phone, address, name, provider ids, or raw rows.
// ---------------------------------------------------------------------------

const DETAIL_USER_LIMIT = 500;
const DETAIL_STORE_LIMIT = 200;

const isValidTenantEmail = (v) => {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length === 0 || s.length > 255) return false;
  // Minimal shape check — full RFC validation belongs to auth/registration,
  // not to a lookup path. Rejects path fragments (a slash can never be
  // part of an email, only of a crafted URL path) and bare words.
  return /^[^@\s/]+@[^@\s/]+\.[^@\s/]+$/.test(s);
};

const toDetailUser = (row) => {
  if (!row) return null;
  return {
    email: row.email || null,
    role: row.role || null,
    storeType: row.store_type || null,
    storeId: row.store_id || null,
    createdAt: row.created_at || null,
  };
};

const toDetailStore = (row) => {
  if (!row) return null;
  return {
    storeType: row.store_type || null,
    storeId: row.store_id || null,
  };
};

async function getTenantDetail(rawEmail) {
  const canonical =
    typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (!isValidTenantEmail(canonical)) return { invalid: true };
  // Each query resolves to [rows, fields] (mysql2); unwrap one level.
  const [[summaryRows], [userRows], [storeRows], [subRows]] = await Promise.all([
    query(
      `SELECT ${TENANT_KEY} AS tenant_email,
         COUNT(*) AS user_count,
         COUNT(DISTINCT u.store_type, u.store_id) AS store_count,
         MIN(u.created_at) AS first_seen
       FROM users u
       ${TENANT_WHERE}
       GROUP BY ${TENANT_KEY}
       HAVING tenant_email = ?
       LIMIT 1`,
      [canonical]
    ),
    query(
      `SELECT u.email, u.role, u.store_type, u.store_id, u.created_at
       FROM users u
       WHERE ${TENANT_KEY} = ?
         AND UPPER(u.role) <> 'SUPER_OWNER'
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT ?`,
      [canonical, DETAIL_USER_LIMIT]
    ),
    query(
      `SELECT DISTINCT u.store_type, u.store_id
       FROM users u
       WHERE ${TENANT_KEY} = ?
         AND UPPER(u.role) <> 'SUPER_OWNER'
         AND u.store_type IS NOT NULL AND u.store_type <> ''
         AND u.store_id IS NOT NULL AND u.store_id <> ''
       ORDER BY u.store_type ASC, u.store_id ASC
       LIMIT ?`,
      [canonical, DETAIL_STORE_LIMIT]
    ),
    query(
      `SELECT status, plan_name, billing_cycle
       FROM subscriptions
       WHERE tenant_email = ?
       LIMIT 1`,
      [canonical]
    ),
  ]);
  const summary = summaryRows[0];
  if (!summary) return { notFound: true };
  const sub = subRows[0] || null;
  return {
    tenant: {
      tenantEmail: summary.tenant_email || canonical,
      userCount: toNumber(summary.user_count),
      storeCount: toNumber(summary.store_count),
      subscription: sub
        ? {
            status: sub.status || null,
            planName: sub.plan_name || null,
            billingCycle: sub.billing_cycle || null,
          }
        : null,
      firstSeen: summary.first_seen || null,
    },
    users: userRows.map(toDetailUser),
    stores: storeRows.map(toDetailStore),
  };
}

module.exports = {
  PLATFORM_LIMIT_MAX,
  deriveTenantEmail,
  normalizePlatformPaging,
  countPlatformTenants,
  listPlatformTenants,
  isValidTenantEmail,
  getTenantDetail,
};
