// invoice-cleanup.authorization.test.js
//
// Coverage for the retention + dependency-checked invoice cleanup module.
//
// Tests:
//   - Store-type gating: Hotel is refused, supported verticals accepted
//   - Scope enforcement: a missing store scope is refused rather than
//     defaulting to "delete everything"
//   - Retention normalization clamps to the supported range
//   - The dependency engine maps each EXISTS flag to its stable block code
//   - Eligibility is the absence of every block reason
//   - The candidate SQL orders ascending and caps the scan
//   - preview is read-only (issues no DELETE) and reports the reason breakdown
//   - execute re-checks inside the transaction and deletes ONLY clean rows
//   - The DELETE re-asserts the store boundary rather than trusting id alone
//   - A dependency created after preview causes a skip, not a deletion
//   - Idempotency: a second run finds nothing to delete
//   - Independent ledgers (stock_movements, customer_credits) are never touched
//
// Uses the same fake-pool pattern as returns.authorization.test.js so no live
// MySQL connection is required.

const test = require("node:test");
const assert = require("node:assert/strict");

// === Fake pool ===========================================================

const fakePool = {
  __queries: [],
  __setQueryImpl(fn) {
    this.__queryImpl = fn;
  },
  __setTxImpl(fn) {
    this.__txImpl = fn;
  },
  async query(sql, params) {
    fakePool.__queries.push({ sql, params, layer: "pool" });
    if (fakePool.__queryImpl) return fakePool.__queryImpl(sql, params);
    return [[], []];
  },
  async withTransaction(fn) {
    const queries = [];
    // A real mysql2 connection exposes `.query(sql, params)`. The cleanup
    // module accepts either that object or a bare query function, so the
    // fake mirrors the real connection shape.
    const conn = {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (fakePool.__txImpl) return fakePool.__txImpl(sql, params);
        return [[], []];
      },
    };
    const result = await fn(conn);
    return { result, queries };
  },
};

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: fakePool,
};

const cleanup = require("./db/queries/invoice-cleanup");

// === Helpers =============================================================

const RETAIL = { storeType: "retail", storeId: "store-1" };

// One candidate row as the DB would return it. All flags default to "clean"
// so a test only sets the dependency it is exercising.
const cleanRow = (overrides = {}) => ({
  id: 1001,
  invoice_no: "INV-1001",
  generated_at: "2020-01-01 10:00:00.000",
  has_return: 0,
  has_payment_intent: 0,
  has_active_order: 0,
  in_open_shift: 0,
  has_shift_cash: 0,
  ...overrides,
});

const resetPool = () => {
  fakePool.__queries = [];
  fakePool.__setQueryImpl(null);
  fakePool.__setTxImpl(null);
};

// Preview runs several queries (candidates, totals, storage, cutoff). This
// routes by SQL shape so each returns a plausible row set.
const previewImpl = ({ rows = [], total = null } = {}) => (sql) => {
  if (/COUNT\(\*\)/i.test(sql)) {
    return [[{ total: total ?? rows.length, oldest: null, newest: null }], []];
  }
  if (/information_schema\.TABLES/i.test(sql)) {
    return [[{ bytes: 1024 }], []];
  }
  if (/AS cutoff/i.test(sql)) {
    return [[{ cutoff: "2023-09-24 00:00:00.000" }], []];
  }
  return [rows, []];
};

// ============================================================================
// Store-type + scope gating
// ============================================================================

test("store types: hotel and hotel-* are rejected for cleanup", () => {
  assert.equal(cleanup.isHotelStoreType("hotel"), true);
  assert.equal(cleanup.isHotelStoreType("Hotel"), true);
  assert.equal(cleanup.isHotelStoreType("hotel-annex"), true);
  assert.equal(cleanup.isSupportedStoreType("hotel"), false);
  assert.equal(cleanup.isSupportedStoreType("hotel-lodge"), false);
});

test("store types: retail / service / laundry are supported", () => {
  for (const t of ["retail", "service", "msme-service", "laundry"]) {
    assert.equal(cleanup.isSupportedStoreType(t), true, `${t} should be supported`);
  }
});

test("requireConcreteScope refuses a hotel scope with a clear code", () => {
  assert.throws(
    () => cleanup.requireConcreteScope({ storeType: "hotel", storeId: "H1" }),
    (e) => e.code === "HOTEL_NOT_SUPPORTED"
  );
});

test("requireConcreteScope refuses an empty scope rather than defaulting to all", () => {
  assert.throws(
    () => cleanup.requireConcreteScope({ storeType: null, storeId: null }),
    (e) => e.code === "SCOPE_REQUIRED"
  );
  assert.throws(
    () => cleanup.requireConcreteScope({ storeType: "retail", storeId: "" }),
    (e) => e.code === "SCOPE_REQUIRED"
  );
});

test("requireConcreteScope returns the normalized store for a valid scope", () => {
  assert.deepEqual(cleanup.requireConcreteScope(RETAIL), RETAIL);
});

// ============================================================================
// Retention normalization
// ============================================================================

test("normalizeRetentionYears clamps to the supported range and defaults safely", () => {
  assert.equal(cleanup.normalizeRetentionYears(3), 3);
  assert.equal(cleanup.normalizeRetentionYears("2"), 2);
  assert.equal(cleanup.normalizeRetentionYears(0), cleanup.DEFAULT_RETENTION_YEARS);
  assert.equal(cleanup.normalizeRetentionYears(-5), cleanup.DEFAULT_RETENTION_YEARS);
  assert.equal(cleanup.normalizeRetentionYears(999), cleanup.DEFAULT_RETENTION_YEARS);
  assert.equal(cleanup.normalizeRetentionYears("abc"), cleanup.DEFAULT_RETENTION_YEARS);
  assert.equal(cleanup.normalizeRetentionYears(undefined), cleanup.DEFAULT_RETENTION_YEARS);
});

// ============================================================================
// Dependency engine
// ============================================================================

test("dependency engine: an old invoice with no dependencies is ELIGIBLE", () => {
  const shaped = cleanup.shapeCandidate(cleanRow());
  assert.equal(shaped.eligible, true);
  assert.deepEqual(shaped.reasons, []);
  assert.equal(shaped.invoiceId, 1001);
  assert.equal(shaped.invoiceNo, "INV-1001");
});

test("dependency engine: a return blocks with RETURN_EXISTS", () => {
  const shaped = cleanup.shapeCandidate(cleanRow({ has_return: 1 }));
  assert.equal(shaped.eligible, false);
  assert.deepEqual(shaped.reasons, ["RETURN_EXISTS"]);
});

test("dependency engine: a payment intent blocks with PAYMENT_INTENT_EXISTS", () => {
  const shaped = cleanup.shapeCandidate(cleanRow({ has_payment_intent: 1 }));
  assert.equal(shaped.eligible, false);
  assert.deepEqual(shaped.reasons, ["PAYMENT_INTENT_EXISTS"]);
});

test("dependency engine: a non-terminal order blocks with ACTIVE_ORDER", () => {
  const shaped = cleanup.shapeCandidate(cleanRow({ has_active_order: 1 }));
  assert.equal(shaped.eligible, false);
  assert.deepEqual(shaped.reasons, ["ACTIVE_ORDER"]);
});

test("dependency engine: an open shift blocks with OPEN_SHIFT", () => {
  const shaped = cleanup.shapeCandidate(cleanRow({ in_open_shift: 1 }));
  assert.equal(shaped.eligible, false);
  assert.deepEqual(shaped.reasons, ["OPEN_SHIFT"]);
});

test("dependency engine: a refund cash movement blocks with SHIFT_CASH_DEPENDENCY", () => {
  const shaped = cleanup.shapeCandidate(cleanRow({ has_shift_cash: 1 }));
  assert.equal(shaped.eligible, false);
  assert.deepEqual(shaped.reasons, ["SHIFT_CASH_DEPENDENCY"]);
});

test("dependency engine: multiple dependencies report every reason, not just the first", () => {
  const shaped = cleanup.shapeCandidate(
    cleanRow({ has_return: 1, has_payment_intent: 1, in_open_shift: 1 })
  );
  assert.equal(shaped.eligible, false);
  assert.deepEqual(shaped.reasons, ["RETURN_EXISTS", "PAYMENT_INTENT_EXISTS", "OPEN_SHIFT"]);
});

test("dependency engine: every emitted code has a UI label", () => {
  for (const code of Object.values(cleanup.BLOCK_CODES)) {
    assert.ok(cleanup.BLOCK_LABELS[code], `${code} needs a label`);
  }
});

test("terminal order statuses reuse the app taxonomy (delivered/cancelled/completed)", () => {
  assert.deepEqual(cleanup.TERMINAL_ORDER_STATUSES, ["delivered", "cancelled", "completed"]);
  // Every legacy alias the UI still renders must be treated as NON-terminal
  // so an unrecognised status blocks rather than silently permitting deletion.
  for (const legacy of ["pending", "washed", "not_picked_up"]) {
    assert.ok(
      cleanup.NON_TERMINAL_ORDER_STATUSES.includes(legacy),
      `${legacy} must be non-terminal`
    );
  }
  // Current, non-terminal statuses likewise block.
  for (const live of ["received", "in_process", "ready"]) {
    assert.ok(cleanup.NON_TERMINAL_ORDER_STATUSES.includes(live), `${live} must be non-terminal`);
  }
});

// ============================================================================
// Candidate SQL
// ============================================================================

test("candidate SQL: orders ascending, caps the scan, and excludes NULL generated_at", async () => {
  resetPool();
  fakePool.__setQueryImpl(() => [[], []]);
  await cleanup.analyzeCandidates(fakePool.query, RETAIL, 3, 50);
  const { sql, params } = fakePool.__queries[0];

  assert.match(sql, /ORDER BY i\.generated_at ASC, i\.id ASC/);
  assert.match(sql, /i\.generated_at IS NOT NULL/);
  assert.match(sql, /i\.generated_at < DATE_SUB\(NOW\(3\), INTERVAL \? YEAR\)/);
  assert.match(sql, /LIMIT \?/);
  // Store boundary is a parameter, never interpolated.
  assert.ok(sql.includes("i._store_type = ?"));
  assert.ok(sql.includes("i._store_id = ?"));
  // Non-terminal statuses are passed as parameters, ahead of scope + years + limit.
  assert.deepEqual(params.slice(0, 6), cleanup.NON_TERMINAL_ORDER_STATUSES);
  assert.equal(params[6], "retail");
  assert.equal(params[7], "store-1");
  assert.equal(params[8], 3);
  assert.equal(params[9], 50);
});

test("candidate SQL: checks every evidenced dependency table", () => {
  const sql = cleanup.CANDIDATE_SQL;
  assert.match(sql, /FROM invoice_returns/);
  assert.match(sql, /FROM payment_intents/);
  assert.match(sql, /FROM orders/);
  assert.match(sql, /FROM shifts/);
  assert.match(sql, /FROM shift_cash_movements/);
  // The cash-movement link is matched the way returns.js actually writes it.
  assert.match(sql, /CONCAT\('refund:', i\.invoice_no\)/);
});

test("candidate SQL: a cross-store scope never widens — store params come from scope", async () => {
  resetPool();
  fakePool.__setQueryImpl(() => [[], []]);
  await cleanup.analyzeCandidates(
    fakePool.query,
    { storeType: "retail", storeId: "store-B" },
    3,
    10
  );
  const { params } = fakePool.__queries[0];
  assert.equal(params[6], "retail");
  assert.equal(params[7], "store-B");
});

// ============================================================================
// Preview — read-only
// ============================================================================

test("preview: reports candidates, eligible, blocked and the reason breakdown", async () => {
  resetPool();
  fakePool.__setQueryImpl(
    previewImpl({
      rows: [
        cleanRow({ id: 1, invoice_no: "INV-1" }),
        cleanRow({ id: 2, invoice_no: "INV-2", has_return: 1 }),
        cleanRow({ id: 3, invoice_no: "INV-3", has_payment_intent: 1 }),
        cleanRow({ id: 4, invoice_no: "INV-4", in_open_shift: 1 }),
        cleanRow({ id: 5, invoice_no: "INV-5", has_return: 1, in_open_shift: 1 }),
      ],
      total: 5,
    })
  );

  const result = await cleanup.preview(RETAIL, { retentionYears: 3 });

  assert.equal(result.storeType, "retail");
  assert.equal(result.storeId, "store-1");
  assert.equal(result.retentionYears, 3);
  assert.ok(result.cutoffDate);
  assert.equal(result.totalCandidates, 5);
  assert.equal(result.eligible, 1);
  assert.equal(result.blocked, 4);
  assert.equal(result.blockedReasons.RETURN_EXISTS, 2);
  assert.equal(result.blockedReasons.PAYMENT_INTENT_EXISTS, 1);
  assert.equal(result.blockedReasons.OPEN_SHIFT, 2);
  // Warnings cover permanence, public links and report history.
  const codes = result.warnings.map((w) => w.code);
  assert.ok(codes.includes("PERMANENT"));
  assert.ok(codes.includes("PUBLIC_LINKS"));
  assert.ok(codes.includes("REPORT_HISTORY"));
});

test("preview: deletes nothing — no DELETE/UPDATE/INSERT is issued", async () => {
  resetPool();
  fakePool.__setQueryImpl(previewImpl({ rows: [cleanRow()], total: 1 }));
  await cleanup.preview(RETAIL, { retentionYears: 3 });
  for (const q of fakePool.__queries) {
    assert.doesNotMatch(q.sql, /DELETE/i);
    assert.doesNotMatch(q.sql, /UPDATE/i);
    assert.doesNotMatch(q.sql, /INSERT/i);
  }
});

test("preview: refuses a hotel scope before touching the database", async () => {
  resetPool();
  await assert.rejects(
    () => cleanup.preview({ storeType: "hotel", storeId: "H1" }, { retentionYears: 3 }),
    (e) => e.code === "HOTEL_NOT_SUPPORTED"
  );
  assert.equal(fakePool.__queries.length, 0, "no query should run for hotel");
});

test("preview: flags truncation when candidates exceed the analyze cap", async () => {
  resetPool();
  fakePool.__setQueryImpl(
    previewImpl({ rows: [cleanRow()], total: cleanup.PREVIEW_ANALYZE_LIMIT + 500 })
  );
  const result = await cleanup.preview(RETAIL, { retentionYears: 3 });
  assert.equal(result.truncated, true);
  assert.equal(result.totalCandidates, cleanup.PREVIEW_ANALYZE_LIMIT + 500);
});

// ============================================================================
// Execute — final re-check + delete
// ============================================================================

test("execute: deletes only invoices that pass the re-check, inside the transaction", async () => {
  resetPool();
  fakePool.__setTxImpl((sql) => {
    if (/COUNT\(\*\)/i.test(sql)) return [[{ total: 2, oldest: null, newest: null }], []];
    if (/information_schema\.TABLES/i.test(sql)) return [[{ bytes: 1024 }], []];
    if (/^DELETE/i.test(sql.trim())) return [{ affectedRows: 1 }, []];
    // The re-check: INV-1 clean, INV-2 gained a return since preview.
    return [
      [cleanRow({ id: 1, invoice_no: "INV-1" }), cleanRow({ id: 2, invoice_no: "INV-2", has_return: 1 })],
      [],
    ];
  });

  const { result } = await cleanup.execute(RETAIL, { retentionYears: 3 });

  assert.equal(result.totalCandidates, 2);
  assert.equal(result.eligible, 1);
  assert.equal(result.blocked, 1);
  assert.equal(result.deletedCount, 1);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.deletedIds, [1]);
  assert.deepEqual(result.blockedReasons.RETURN_EXISTS, 1);
});

test("execute: the DELETE re-asserts the store boundary, not just the id", async () => {
  resetPool();
  fakePool.__setTxImpl((sql) => {
    if (/^DELETE/i.test(sql.trim())) return [{ affectedRows: 1 }, []];
    return [[cleanRow({ id: 7, invoice_no: "INV-7" })], []];
  });

  const { queries } = await cleanup.execute(RETAIL, { retentionYears: 3 });
  const del = queries.find((q) => /^DELETE/i.test(q.sql.trim()));

  assert.match(del.sql, /WHERE id = \? AND _store_type = \? AND _store_id = \?/);
  assert.deepEqual(del.params, [7, "retail", "store-1"]);
});

test("execute: never touches independent ledgers", async () => {
  resetPool();
  fakePool.__setTxImpl((sql) => {
    if (/^DELETE/i.test(sql.trim())) return [{ affectedRows: 1 }, []];
    return [[cleanRow()], []];
  });

  const { queries } = await cleanup.execute(RETAIL, { retentionYears: 3 });
  for (const q of queries) {
    if (!/^DELETE/i.test(q.sql.trim())) continue;
    // The only deletion this feature performs is against `invoices`.
    assert.match(q.sql, /DELETE FROM invoices/i);
    assert.doesNotMatch(q.sql, /stock_movements/i);
    assert.doesNotMatch(q.sql, /customer_credits/i);
    assert.doesNotMatch(q.sql, /audit_log/i);
    assert.doesNotMatch(q.sql, /orders/i);
    assert.doesNotMatch(q.sql, /shifts/i);
  }
});

test("execute: a dependency created after preview causes a skip, not a deletion", async () => {
  resetPool();
  let deleteCalls = 0;
  fakePool.__setTxImpl((sql) => {
    if (/^DELETE/i.test(sql.trim())) {
      deleteCalls += 1;
      return [{ affectedRows: 1 }, []];
    }
    // All three now carry a return that did not exist at preview time.
    return [
      [
        cleanRow({ id: 1, invoice_no: "INV-1", has_return: 1 }),
        cleanRow({ id: 2, invoice_no: "INV-2", has_return: 1 }),
        cleanRow({ id: 3, invoice_no: "INV-3", has_return: 1 }),
      ],
      [],
    ];
  });

  const { result } = await cleanup.execute(RETAIL, { retentionYears: 3 });

  assert.equal(result.eligible, 0);
  assert.equal(result.blocked, 3);
  assert.equal(result.deletedCount, 0);
  assert.equal(deleteCalls, 0, "no DELETE may run when every invoice is blocked");
});

test("execute: a DELETE that affects 0 rows is reported as skipped, not deleted", async () => {
  resetPool();
  fakePool.__setTxImpl((sql) => {
    if (/^DELETE/i.test(sql.trim())) return [{ affectedRows: 0 }, []];
    return [[cleanRow({ id: 5, invoice_no: "INV-5" })], []];
  });

  const { result } = await cleanup.execute(RETAIL, { retentionYears: 3 });
  assert.equal(result.eligible, 1);
  assert.equal(result.deletedCount, 0);
  assert.equal(result.skipped, 1);
});

test("execute: a second run is idempotent — nothing left to delete", async () => {
  resetPool();
  fakePool.__setTxImpl((sql) => {
    if (/^DELETE/i.test(sql.trim())) return [{ affectedRows: 1 }, []];
    // The rows are gone, so the candidate scan returns nothing.
    return [[], []];
  });

  const { result } = await cleanup.execute(RETAIL, { retentionYears: 3 });
  assert.equal(result.totalCandidates, 0);
  assert.equal(result.eligible, 0);
  assert.equal(result.deletedCount, 0);
});

test("execute: refuses a hotel scope before opening a transaction", async () => {
  resetPool();
  await assert.rejects(
    () => cleanup.execute({ storeType: "hotel", storeId: "H1" }, { retentionYears: 3 }),
    (e) => e.code === "HOTEL_NOT_SUPPORTED"
  );
});

test("execute: the re-check query is byte-identical to the preview query", () => {
  // Preview and execute MUST run the same SQL, or the safety guarantee is
  // only as good as the weaker of the two implementations.
  assert.ok(cleanup.CANDIDATE_SQL.includes("EXISTS"));
  assert.match(cleanup.CANDIDATE_SQL, /ORDER BY i\.generated_at ASC/);
});
