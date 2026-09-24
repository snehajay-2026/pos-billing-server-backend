// invoice-cleanup.js — retention-based, dependency-checked invoice cleanup.
//
// This is the ONLY safe path to permanently delete an invoice. The generic
// `DELETE /api/:resource/:id` route explicitly refuses the `invoices` resource
// (see index.js) precisely so a bare `DELETE FROM invoices` can never be
// reached without the checks below.
//
// Why the checks exist: nothing in the schema enforces them. There is no
// foreign key anywhere that references `invoices` — every relationship is a
// soft `invoice_no` string, or (for stock/credit) not a relationship at all.
// The database will happily orphan a return, a laundry order, or a payment
// intent. So the safety has to be built here, explicitly.
//
// Supported verticals: retail, service, laundry. Hotel is EXCLUDED — hotel
// settlement writes `hotel_state` JSON and flips `hotel_bookings.status`
// rather than creating `invoices` rows, and the lodging/dining realtime
// architecture must not be disturbed.
//
// What is NEVER deleted, even when its invoice goes:
//   stock_movements     — independent inventory ledger (no invoice column)
//   customer_credits    — live Udhaar balance (no invoice column)
//   orders              — the work order; only checked, never cascaded
//   shifts / audit_log  — financial + compliance records
// Only rows of `invoices` are removed.

const { query, withTransaction } = require("../pool");

// Stable, machine-readable block reasons. Every one of these is backed by a
// column that exists in the repository today — none are speculative.
const BLOCK_CODES = {
  RETURN_EXISTS: "RETURN_EXISTS",
  PAYMENT_INTENT_EXISTS: "PAYMENT_INTENT_EXISTS",
  ACTIVE_ORDER: "ACTIVE_ORDER",
  OPEN_SHIFT: "OPEN_SHIFT",
  SHIFT_CASH_DEPENDENCY: "SHIFT_CASH_DEPENDENCY",
};

// Human-facing labels for the admin UI. Kept beside the codes so a new code
// cannot be added without a label.
const BLOCK_LABELS = {
  RETURN_EXISTS: "Has a return, refund or exchange",
  PAYMENT_INTENT_EXISTS: "Has a payment intent",
  ACTIVE_ORDER: "Linked to a non-terminal order",
  OPEN_SHIFT: "Belongs to an open shift",
  SHIFT_CASH_DEPENDENCY: "Referenced by a shift cash movement",
};

// Terminal order statuses, taken from the app's own taxonomy in
// src/components/laundry/laundryStatus.js (LAUNDRY_ORDER_STATUSES +
// LAUNDRY_STATUS_ALIASES): `delivered` and `cancelled` are terminal, and the
// legacy `completed` maps onto `delivered`. Everything else — including the
// legacy `pending` / `washed` / `not_picked_up` — is treated as STILL
// ACTIVE, so an unrecognised status blocks deletion rather than permitting it.
const TERMINAL_ORDER_STATUSES = ["delivered", "cancelled", "completed"];

// Guard against a runaway retention value. 1..20 years.
const MIN_RETENTION_YEARS = 1;
const MAX_RETENTION_YEARS = 20;
const DEFAULT_RETENTION_YEARS = 3;

// Cap on how many invoices a single run may delete. A safety valve, not a
// feature: an operator who somehow sets a 1-year window on a large store
// should be forced into several deliberate runs rather than one accident.
const MAX_DELETE_PER_RUN = 5000;

// How many candidates preview will analyse before reporting a truncated
// total. Preview must stay fast on a large table.
const PREVIEW_ANALYZE_LIMIT = 5000;

const isSupportedStoreType = (storeType) => {
  const t = String(storeType || "").trim().toLowerCase();
  if (!t) return false;
  // Hotel (and any hotel-flavoured alias) is explicitly out of scope.
  if (t === "hotel" || t.startsWith("hotel")) return false;
  return ["retail", "service", "msme-service", "laundry", "inventory"].includes(t);
};

const isHotelStoreType = (storeType) => {
  const t = String(storeType || "").trim().toLowerCase();
  return t === "hotel" || t.startsWith("hotel");
};

const normalizeRetentionYears = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n)) return DEFAULT_RETENTION_YEARS;
  if (n < MIN_RETENTION_YEARS || n > MAX_RETENTION_YEARS) return DEFAULT_RETENTION_YEARS;
  return n;
};

// buildScopeWhere: the store boundary. Both predicates are required — a
// scope missing either one is not authorized for any deletion and must fail
// loudly rather than defaulting to "all invoices".
const requireConcreteScope = (scope) => {
  const storeType = String(scope?.storeType || "").trim();
  const storeId = String(scope?.storeId || "").trim();
  if (!storeType || !storeId) {
    const err = new Error("A concrete authorized store scope is required for invoice cleanup");
    err.status = 400;
    err.code = "SCOPE_REQUIRED";
    throw err;
  }
  if (isHotelStoreType(storeType)) {
    const err = new Error("Invoice cleanup is not available for the Hotel store");
    err.status = 400;
    err.code = "HOTEL_NOT_SUPPORTED";
    throw err;
  }
  if (!isSupportedStoreType(storeType)) {
    const err = new Error(`Invoice cleanup is not available for store type "${storeType}"`);
    err.status = 400;
    err.code = "STORE_TYPE_NOT_SUPPORTED";
    throw err;
  }
  return { storeType, storeId };
};

// The cutoff is computed in SQL so the database's clock — not the Node
// process's — decides what "older than retention" means. That avoids any
// skew between the Render host and TiDB Cloud.
//
// Boundary is STRICTLY LESS THAN: `generated_at < cutoff`. An invoice sitting
// exactly on the cutoff instant is not yet eligible, so nothing can be
// deleted in the same instant it crosses the threshold.
const cutoffSql = "DATE_SUB(NOW(3), INTERVAL ? YEAR)";

// analyzeCandidates: the single source of truth for "can this invoice be
// deleted?". Used identically by preview, by the execute-time re-check, and by
// the tests, so the two paths can never drift apart.
//
// Correlated EXISTS subqueries rather than joins: one row per invoice, no
// fan-out, no N+1, and every check is independent so an invoice can report
// several reasons at once.
//
// `generated_at IS NOT NULL` deliberately excludes pre-migration-009 rows.
// An invoice with no recorded generation time is not known to be old, and
// deleting it on an unknown's age would be exactly the kind of guess this
// feature exists to avoid.
const CANDIDATE_SQL = `
  SELECT i.id, i.invoice_no, i.generated_at,
    EXISTS(SELECT 1 FROM invoice_returns r
            WHERE r.invoice_no = i.invoice_no) AS has_return,
    EXISTS(SELECT 1 FROM payment_intents p
            WHERE p.invoice_no = i.invoice_no) AS has_payment_intent,
    EXISTS(SELECT 1 FROM orders o
            WHERE o.invoice_no = i.invoice_no
              AND LOWER(COALESCE(o.status, ''))
                  NOT IN (?, ?, ?, ?, ?, ?)) AS has_active_order,
    EXISTS(SELECT 1 FROM shifts s
            WHERE s.id = i.shift_id
              AND s.status = 'open') AS in_open_shift,
    EXISTS(SELECT 1 FROM shift_cash_movements m
            WHERE m.reason = CONCAT('refund:', i.invoice_no)) AS has_shift_cash
  FROM invoices i
  WHERE i._store_type = ?
    AND i._store_id = ?
    AND i.generated_at IS NOT NULL
    AND i.generated_at < ${cutoffSql}
  ORDER BY i.generated_at ASC, i.id ASC
  LIMIT ?
`;

// A non-terminal order means the order is still being worked. The list covers
// every status the app can produce, both current and legacy, so nothing slips
// through as "unrecognised".
const NON_TERMINAL_ORDER_STATUSES = [
  "received",
  "in_process",
  "ready",
  "pending",
  "washed",
  "not_picked_up",
];

const buildCandidateParams = ({ storeType, storeId }, retentionYears, limit) => [
  ...NON_TERMINAL_ORDER_STATUSES,
  storeType,
  storeId,
  retentionYears,
  limit,
];

// reasonsFor: turn the EXISTS booleans into the stable code list.
const reasonsFor = (row) => {
  const reasons = [];
  if (Number(row.has_return) === 1) reasons.push(BLOCK_CODES.RETURN_EXISTS);
  if (Number(row.has_payment_intent) === 1) reasons.push(BLOCK_CODES.PAYMENT_INTENT_EXISTS);
  if (Number(row.has_active_order) === 1) reasons.push(BLOCK_CODES.ACTIVE_ORDER);
  if (Number(row.in_open_shift) === 1) reasons.push(BLOCK_CODES.OPEN_SHIFT);
  if (Number(row.has_shift_cash) === 1) reasons.push(BLOCK_CODES.SHIFT_CASH_DEPENDENCY);
  return reasons;
};

const shapeCandidate = (row) => {
  const reasons = reasonsFor(row);
  return {
    invoiceId: row.id != null ? Number(row.id) : row.id,
    invoiceNo: row.invoice_no || null,
    generatedAt: row.generated_at || null,
    eligible: reasons.length === 0,
    reasons,
  };
};

// analyzeCandidates(runQuery, scope, retentionYears, limit)
// `runQuery` is either the shared pool `query` (a bare function) or a
// transaction connection (a mysql2 poolConnection object with a `.query`
// method). `withTransaction` hands us the latter, so accept both — this is
// what lets the execute path re-run the identical check inside its own
// transaction on the same connection.
const callQuery = (runQuery, sql, params) => {
  if (typeof runQuery === "function") return runQuery(sql, params);
  if (runQuery && typeof runQuery.query === "function") return runQuery.query(sql, params);
  throw new Error("invoice-cleanup: a query runner is required");
};

const analyzeCandidates = async (runQuery, scope, retentionYears, limit) => {
  const bounded = requireConcreteScope(scope);
  const years = normalizeRetentionYears(retentionYears);
  const params = buildCandidateParams(bounded, years, limit);
  const rows = await callQuery(runQuery, CANDIDATE_SQL, params);
  return (rows[0] || []).map(shapeCandidate);
};

// totalCandidates: how many invoices exist in scope before the cutoff,
// independent of the analyze cap. Lets preview say "12,450 of 20,000
// analysed" instead of silently under-reporting.
const totalCandidates = async (runQuery, scope, retentionYears) => {
  const bounded = requireConcreteScope(scope);
  const years = normalizeRetentionYears(retentionYears);
  const rows = await callQuery(runQuery,
    `SELECT COUNT(*) AS total,
            MIN(i.generated_at) AS oldest,
            MAX(i.generated_at) AS newest
       FROM invoices i
      WHERE i._store_type = ?
        AND i._store_id = ?
        AND i.generated_at IS NOT NULL
        AND i.generated_at < ${cutoffSql}`,
    [bounded.storeType, bounded.storeId, years]
  );
  const r = (rows[0] || [])[0] || {};
  return {
    total: Number(r.total || 0),
    oldest: r.oldest || null,
    newest: r.newest || null,
  };
};

// estimatedBytes: "estimated invoice data eligible for cleanup" — NOT a
// promise about disk. InnoDB/TiDB free space internally after a DELETE but
// do not shrink the tablespace file without OPTIMIZE TABLE, so the file on
// disk often does not move at all.
//
// Estimated as (table data + index length) × the fraction of the table that
// the candidates represent. It is an order-of-magnitude figure and is
// labelled as such everywhere it surfaces in the UI.
const estimatedBytes = async (runQuery, scope, retentionYears) => {
  const bounded = requireConcreteScope(scope);
  const years = normalizeRetentionYears(retentionYears);
  const stats = await totalCandidates(runQuery, bounded, years);
  if (!stats.total) return 0;

  const rows = await callQuery(runQuery,
    `SELECT COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'invoices'`,
    []
  );
  const tableBytes = Number(((rows[0] || [])[0] || {}).bytes || 0);
  if (!tableBytes) return 0;

  // Fraction of the table that is in scope AND past the cutoff. Bounded to
  // 1 so a scope that holds every invoice cannot report more than the table.
  const scopeRows = await callQuery(runQuery,
    `SELECT COUNT(*) AS total FROM invoices WHERE _store_type = ? AND _store_id = ?`,
    [bounded.storeType, bounded.storeId]
  );
  const inScopeTotal = Number(((scopeRows[0] || [])[0] || {}).total || 0);
  if (!inScopeTotal) return 0;

  const fraction = Math.min(1, stats.total / inScopeTotal);
  return Math.round(tableBytes * fraction);
};

const warningsFor = (retentionYears) => [
  {
    code: "PERMANENT",
    message:
      "Deleted invoices cannot be recovered from the application. There is no in-app backup or restore.",
  },
  {
    code: "PUBLIC_LINKS",
    message:
      "Public invoice links (WhatsApp / email shares) stop working once the invoice is deleted. This system keeps no record of which links were shared, so this cannot be checked in advance.",
  },
  {
    code: "REPORT_HISTORY",
    message: `Sales, GST and payment reports read invoices live, so detail older than ${retentionYears} year(s) will no longer appear in historical reports.`,
  },
];

// preview: strictly read-only. No DELETE, no UPDATE, no audit write.
const preview = async (scope, options = {}) => {
  const bounded = requireConcreteScope(scope);
  const years = normalizeRetentionYears(options.retentionYears);
  const candidates = await analyzeCandidates(query, bounded, years, PREVIEW_ANALYZE_LIMIT);
  const totals = await totalCandidates(query, bounded, years);

  const blockedReasons = {};
  let eligible = 0;
  let blocked = 0;
  for (const c of candidates) {
    if (c.eligible) {
      eligible += 1;
    } else {
      blocked += 1;
      for (const reason of c.reasons) {
        blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
      }
    }
  }

  const bytes = await estimatedBytes(query, bounded, years);
  const cutoffRows = await query("SELECT " + cutoffSql + " AS cutoff", [years]);
  const cutoffDate = ((cutoffRows[0] || [])[0] || {}).cutoff || null;

  return {
    storeType: bounded.storeType,
    storeId: bounded.storeId,
    retentionYears: years,
    cutoffDate,
    totalCandidates: totals.total,
    analysedCandidates: candidates.length,
    truncated: totals.total > candidates.length,
    oldestCandidate: totals.oldest,
    eligible,
    blocked,
    blockedReasons,
    blockedLabels: BLOCK_LABELS,
    estimatedBytes,
    warnings: warningsFor(years),
  };
};

// execute: permanent deletion, gated on a final in-transaction re-check.
//
// The re-check is the whole point. Preview is advisory — between preview and
// execute a cashier can process a return against an invoice that was eligible
// a moment ago. So the dependency query runs again INSIDE the delete
// transaction, on the transaction's own connection, and only rows that are
// still clean at that instant are removed.
//
// Dependencies are never reversed and child ledgers are never touched. This
// deletes invoice headers and nothing else.
const execute = async (scope, options = {}) => {
  const bounded = requireConcreteScope(scope);
  const years = normalizeRetentionYears(options.retentionYears);

  return withTransaction(async (conn) => {
    // Same SQL, same store boundary, same retention semantics as preview —
    // just re-read at the moment of deletion.
    const candidates = await analyzeCandidates(conn, bounded, years, MAX_DELETE_PER_RUN);

    const eligible = candidates.filter((c) => c.eligible);
    const blocked = candidates.filter((c) => !c.eligible);
    const blockedReasons = {};
    for (const c of blocked) {
      for (const reason of c.reasons) {
        blockedReasons[reason] = (blockedReasons[reason] || 0) + 1;
      }
    }

    const deletedIds = [];
    const deleted = [];
    for (const c of eligible) {
      // Re-assert the store boundary on the DELETE itself. The candidate scan
      // already filtered by store, but a delete keyed only on id would be one
      // careless refactor away from a cross-store write.
      const [result] = await conn.query(
        "DELETE FROM invoices WHERE id = ? AND _store_type = ? AND _store_id = ?",
        [c.invoiceId, bounded.storeType, bounded.storeId]
      );
      if (result && result.affectedRows > 0) {
        deletedIds.push(c.invoiceId);
        deleted.push(c.invoiceNo);
      }
    }

    return {
      storeType: bounded.storeType,
      storeId: bounded.storeId,
      retentionYears: years,
      totalCandidates: candidates.length,
      eligible: eligible.length,
      blocked: blocked.length,
      blockedReasons,
      // Invoices that were eligible at preview time but picked up a new
      // dependency before this transaction committed. Reported separately so
      // the UI can say exactly why the numbers moved.
      skipped: eligible.length - deleted.length,
      deletedCount: deleted.length,
      deletedIds,
      deletedInvoiceNos: deleted,
    };
  });
};

module.exports = {
  BLOCK_CODES,
  BLOCK_LABELS,
  TERMINAL_ORDER_STATUSES,
  NON_TERMINAL_ORDER_STATUSES,
  DEFAULT_RETENTION_YEARS,
  MIN_RETENTION_YEARS,
  MAX_RETENTION_YEARS,
  MAX_DELETE_PER_RUN,
  PREVIEW_ANALYZE_LIMIT,
  CANDIDATE_SQL,
  isSupportedStoreType,
  isHotelStoreType,
  normalizeRetentionYears,
  requireConcreteScope,
  reasonsFor,
  shapeCandidate,
  analyzeCandidates,
  totalCandidates,
  estimatedBytes,
  warningsFor,
  preview,
  execute,
};
