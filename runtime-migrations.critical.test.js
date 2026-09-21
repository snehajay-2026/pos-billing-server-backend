// runtime-migrations.critical.test.js
//
// F8: regression coverage for the hard-startup-gate added to
// db/runtime-migrations.js. Without the gate, a denied ALTER on
// `invoices.customer_id` or `idx_invoices_customer` would silently drop
// every cashier-supplied `customerId` on POST /api/invoices — the
// validation passes, the INSERT succeeds, the linkage is lost. The
// gate makes that failure visible at deploy time instead of request
// time.
//
// These tests pin the runner behavior. They do not exercise
// index.js's startServer() flow directly (that would require
// supertest + a real listen loop); they exercise runRuntimeMigrations
// and assert the structured `deniedCritical` field that the
// startServer() guard reads.

const test = require("node:test");
const assert = require("node:assert/strict");

// === Fake pool ============================================================
//
// `db/runtime-migrations.js` captures `{ query, pool }` at module load.
// To exercise runRuntimeMigrations without a live MySQL connection we
// substitute the pool module BEFORE the runner loads it. The fake
// returns canned information_schema results so each test can stage
// "column missing", "column present", "ALTER succeeds", "ALTER denied"
// without a real DB.
//
// Note on shape: the runner does
//     const { query, pool } = require("./pool");
// then `await pool.query(sql, params)` for inspection and the bare
// `query(sql, params)` for the actual ALTER. JavaScript destructuring
// reads the *named* properties of the source — so the fake module
// needs a `pool` property pointing back at itself and a `query`
// property pointing at the same query function. Otherwise the
// destructure of `pool` would yield `undefined` and the runner would
// throw "Cannot read properties of undefined (reading 'query')" at
// the very first probe.

const fakeQuery = async function query(sql, params) {
  fakePool.__lastQueries.push({ sql, params });
  if (fakePool.__handler) return fakePool.__handler(sql, params);
  return [[], []];
};

const fakePool = {
  __lastQueries: [],
  __setQueryHandler(fn) {
    this.__handler = fn;
  },
  reset() {
    this.__lastQueries = [];
    this.__handler = null;
  },
  // IMPORTANT: the runner destructures { query, pool } from this
  // object. The bare `query` is used for ALTERs (small `query(s,p)`
  // calls) and `pool.query(...)` is used for information_schema
  // probes. Both must resolve to the same function. We attach both
  // pointers explicitly so they don't drift if test code reassigns.
};

fakePool.query = fakeQuery;
fakePool.pool = fakePool;

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: fakePool,
};

const {
  runRuntimeMigrations,
  CRITICAL_MIGRATIONS,
  MIGRATIONS,
} = require("./db/runtime-migrations");

// === Helpers =============================================================

// Information_schema ROW patterns:
//   - `invoices` row that has `customer_id` → 1 row
//   - `invoices` row that does NOT have `customer_id` → 0 rows
//   - `idx_invoices_customer` present → 1 row in STATISTICS
//   - `idx_invoices_customer` missing → 0 rows
//
// The runner runs a single SUM(...) query that bundles all the
// presence checks into one row. We model the bundle: we treat any
// "I want this column missing" / "I want this index missing" by
// returning 0 for the right predicate, and 1 for "present".

const columnPresent = (table, column) =>
  [{ ...bundleRow({ table, column, present: true }) }];

const columnMissing = (table, column) =>
  [{ ...bundleRow({ table, column, present: false }) }];

const indexPresent = (table, indexName) => {
  // The runner probes `SELECT INDEX_NAME FROM information_schema.STATISTICS
  // WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`.
  // We must match the column name (`INDEX_NAME`) for the runner to think
  // the index exists.
  return [[{ INDEX_NAME: indexName }], []];
};

const indexMissing = () => [[], []];

// Returns the SUM(...) bundle that the runner's module-load probe
// expects. We don't drive module load in these tests (the production
// probe fires at the top of the runRuntimeMigrations call indirectly
// via the column-add `MIGRATIONS` loop) — the loop issues
// SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE
// TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1.
// We just intercept those probes directly.
function bundleRow() {
  return {};
}

// Build a generic handler. `tablesAndIndexes` is a map keyed by SQL
// fragments; values are arrays (rows returned). Anything not in the
// map falls through to a query-able default.
//
// opts.columnProbeFailures is an optional Map keyed by "<table>|<column>"
// whose value is the number of TIMES the COLUMNS probe should throw
// before it returns a result. The runner re-probes once for critical
// migrations, so this lets tests stage "fail twice" (unconfirmed) vs.
// "fail once then succeed" (transient blip). Same shape for
// opts.indexProbeFailures keyed by "<table>|<indexName>".
const consumeFailureBudget = (map, key) => {
  if (!map) return 0;
  const remaining = Number(map.get(key)) || 0;
  if (remaining > 0) map.set(key, remaining - 1);
  return remaining;
};

const makeHandler = (opts) => (sql, params) => {
  fakePool.__lastQueries.push({ sql, params });
  const s = sql.trim();
  // Column probe (one per MIGRATIONS entry + the runtime probe).
  if (/information_schema\.COLUMNS/i.test(s)) {
    if (opts && typeof opts.columnHandler === "function") {
      return opts.columnHandler(sql, params);
    }
    // Default: probe for column_name = ? matches → treat as present.
    return [[{ COLUMN_NAME: params && params[2] }], []];
  }
  // Index probe (one per index migration).
  if (/information_schema\.STATISTICS/i.test(s)) {
    if (opts && typeof opts.indexHandler === "function") {
      return opts.indexHandler(sql, params);
    }
    return [[], []];
  }
  // ALTER TABLE for column-add migrations.
  if (/^ALTER TABLE `?[\w-]+`?\s+ADD COLUMN/i.test(s)) {
    if (opts && opts.alterErrorsAsDenied) {
      const e = new Error("ALTER command denied to user 'pos_billing_app'@'%'");
      e.errno = 1142;
      throw e;
    }
    if (opts && opts.alterErrorsAsOther) {
      throw new Error(opts.alterErrorsAsOther);
    }
    return [{ affectedRows: 0 }, []];
  }
  // ALTER TABLE for index migrations.
  if (/^ALTER TABLE\s+`?\w+`?/i.test(s) && /ADD (UNIQUE )?KEY/i.test(s)) {
    if (opts && opts.alterIndexErrorsAsDenied) {
      const e = new Error("ALTER command denied to user 'pos_billing_app'@'%'");
      e.errno = 1142;
      throw e;
    }
    if (opts && opts.alterIndexErrorsAsOther) {
      throw new Error(opts.alterIndexErrorsAsOther);
    }
    return [{ affectedRows: 0 }, []];
  }
  // Customers backfill probe.
  if (/FROM customers\s+WHERE approval_status IS NULL/i.test(s)) {
    return [[{ c: 0 }], []];
  }
  // Customers backfill update (only if the probe above returned > 0).
  if (/UPDATE customers\s+SET approval_status = 'approved'/i.test(s)) {
    return [{ affectedRows: 0 }, []];
  }
  // Default: no-op success.
  return [[], []];
};

// Wraps a column handler so a probe for a specific (table, column)
// throws on the first N calls before falling through. The handler is
// shared across all COLUMNS probes in a test run, so we count calls per
// (table, column) pair to avoid collateral damage on unrelated
// migrations.
const wrapColumnHandlerWithProbeFailures = (baseHandler, opts) => {
  const counts = new Map();
  return (sql, params) => {
    const table = params && params[1];
    const column = params && params[2];
    const key = `${table}|${column}`;
    if (opts && opts.columnProbeFailures && opts.columnProbeFailures.has(key)) {
      const budget = Number(opts.columnProbeFailures.get(key)) || 0;
      const seen = Number(counts.get(key)) || 0;
      if (seen < budget) {
        counts.set(key, seen + 1);
        const e = new Error(
          `information_schema probe timed out (simulated) for ${table}.${column}`
        );
        e.errno = 1205; // ER_LOCK_WAIT_TIMEOUT — a realistic transient
        throw e;
      }
    }
    if (typeof baseHandler === "function") return baseHandler(sql, params);
    return [[], []];
  };
};

const wrapIndexHandlerWithProbeFailures = (baseHandler, opts) => {
  const counts = new Map();
  return (sql, params) => {
    const table = params && params[1];
    const indexName = params && params[2];
    const key = `${table}|${indexName}`;
    if (opts && opts.indexProbeFailures && opts.indexProbeFailures.has(key)) {
      const budget = Number(opts.indexProbeFailures.get(key)) || 0;
      const seen = Number(counts.get(key)) || 0;
      if (seen < budget) {
        counts.set(key, seen + 1);
        const e = new Error(
          `information_schema probe timed out (simulated) for ${indexName}`
        );
        e.errno = 1205;
        throw e;
      }
    }
    if (typeof baseHandler === "function") return baseHandler(sql, params);
    return [[], []];
  };
};

// Translate `(table, column, present)` into a columnHandler that the
// inner loop can use. The runner's column-add loop probes with the
// pattern `TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`.
const stageColumn = (table, column, present) => (sql, params) => {
  if (
    /information_schema\.COLUMNS/i.test(sql) &&
    params &&
    params[1] === table &&
    params[2] === column
  ) {
    return present ? [[{ COLUMN_NAME: column }], []] : [[], []];
  }
  // Default fallback for OTHER column probes (treat as present so the
  // unrelated migrations don't fire spuriously).
  return [[{ COLUMN_NAME: params && params[2] }], []];
};

const stageIndex = (table, indexName, present) => (sql, params) => {
  if (
    /information_schema\.STATISTICS/i.test(sql) &&
    params &&
    params[1] === table &&
    params[2] === indexName
  ) {
    return present ? indexPresent(table, indexName) : indexMissing();
  }
  return [[], []];
};

const resetEnv = (next) => {
  const prev = process.env.DB_NAME;
  process.env.DB_NAME = next;
  return () => {
    if (prev === undefined) delete process.env.DB_NAME;
    else process.env.DB_NAME = prev;
  };
};

// === Tests ===============================================================

// Helper: stage every MIGRATIONS column as PRESENT unless
// `columnProbeFailures` overrides a specific (table, column) with a
// transient throw budget. Stage every index as PRESENT unless
// `indexProbeFailures` overrides. Returns the handler factory opts.
const stageAllPresentWithOverrides = (opts = {}) => {
  const columnHandler = (sql, params) => {
    const m = MIGRATIONS.find(
      (mg) => mg.table === params[1] && mg.column === params[2]
    );
    if (m) return [[{ COLUMN_NAME: m.column }], []];
    return [[], []];
  };
  const indexHandler = (sql, params) => {
    const indexName = params[2];
    if (indexName === "idx_invoices_customer") return indexPresent("invoices", indexName);
    if (indexName === "idx_customers_status") return indexPresent("customers", indexName);
    if (indexName === "uq_shift_cash_movements_ref")
      return indexPresent("shift_cash_movements", indexName);
    return [[], []];
  };
  const wrappedColumn = wrapColumnHandlerWithProbeFailures(columnHandler, opts);
  const wrappedIndex = wrapIndexHandlerWithProbeFailures(indexHandler, opts);
  return {
    columnHandler: wrappedColumn,
    indexHandler: wrappedIndex,
    columnProbeFailures: opts.columnProbeFailures,
    indexProbeFailures: opts.indexProbeFailures,
  };
};

// Helper: stage everything present EXCEPT a single critical column
// (default: invoices.customer_id) and a single critical index
// (default: idx_invoices_customer), with optional probe-failure budgets.
const stageMissingCriticalWithOverrides = (opts = {}) => {
  const missingColumn = opts.missingColumn || "customer_id";
  const missingIndex = opts.missingIndex || "idx_invoices_customer";
  const missingColumnTable = opts.missingColumnTable || "invoices";
  const columnHandler = (sql, params) => {
    if (
      params &&
      params[1] === missingColumnTable &&
      params[2] === missingColumn
    ) {
      return [[], []];
    }
    return [[{ COLUMN_NAME: params && params[2] }], []];
  };
  const indexHandler = (sql, params) => {
    if (params && params[2] === missingIndex) return [[], []];
    if (params && params[2] === "idx_customers_status")
      return indexPresent("customers", "idx_customers_status");
    if (params && params[2] === "uq_shift_cash_movements_ref")
      return indexPresent("shift_cash_movements", "uq_shift_cash_movements_ref");
    return [[], []];
  };
  const wrappedColumn = wrapColumnHandlerWithProbeFailures(columnHandler, opts);
  const wrappedIndex = wrapIndexHandlerWithProbeFailures(indexHandler, opts);
  return {
    columnHandler: wrappedColumn,
    indexHandler: wrappedIndex,
    columnProbeFailures: opts.columnProbeFailures,
    indexProbeFailures: opts.indexProbeFailures,
  };
};

test("CRITICAL_MIGRATIONS lists the two invoice-customer gates", () => {
  assert.ok(CRITICAL_MIGRATIONS instanceof Set, "CRITICAL_MIGRATIONS must be a Set");
  assert.ok(
    CRITICAL_MIGRATIONS.has("invoices.customer_id"),
    "invoices.customer_id must be critical"
  );
  assert.ok(
    CRITICAL_MIGRATIONS.has("idx_invoices_customer"),
    "idx_invoices_customer must be critical"
  );
});

test("runRuntimeMigrations: column + index already present → deniedCritical empty", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // Stage every MIGRATIONS column as PRESENT so no ALTER is attempted.
  const columnHandler = (sql, params) => {
    const m = MIGRATIONS.find(
      (mg) => mg.table === params[1] && mg.column === params[2]
    );
    if (m) return [[{ COLUMN_NAME: m.column }], []];
    return [[], []];
  };
  // Stage both critical indexes as PRESENT.
  const indexHandler = (sql, params) => {
    const indexName = params[2];
    if (indexName === "idx_invoices_customer") return indexPresent("invoices", indexName);
    if (indexName === "idx_customers_status") return indexPresent("customers", indexName);
    if (indexName === "uq_shift_cash_movements_ref")
      return indexPresent("shift_cash_movements", indexName);
    return [[], []];
  };
  fakePool.__setQueryHandler(makeHandler({ columnHandler, indexHandler }));
  try {
    const result = await runRuntimeMigrations();
    assert.equal(result.applied, 0);
    assert.equal(result.denied, 0);
    assert.deepEqual(result.deniedCritical, []);
    assert.deepEqual(result.deniedNames, []);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: invoices.customer_id missing + ALTER DENIED → deniedCritical carries it", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // All other columns / indexes present; invoices.customer_id missing.
  const columnHandler = (sql, params) => {
    if (params && params[1] === "invoices" && params[2] === "customer_id")
      return [[], []];
    return [[{ COLUMN_NAME: params && params[2] }], []];
  };
  const indexHandler = () =>
    // All indexes present.
    [[], []];
  fakePool.__setQueryHandler(
    makeHandler({
      columnHandler,
      indexHandler,
      alterErrorsAsDenied: true, // ← every ALTER throws DENIED
    })
  );
  try {
    const result = await runRuntimeMigrations();
    const names = result.deniedCritical.map((e) => e.name);
    assert.ok(
      names.includes("invoices.customer_id"),
      `deniedCritical must include invoices.customer_id; got ${names.join(",")}`
    );
    // The DDL hint is preserved so the operator knows what to run.
    const entry = result.deniedCritical.find((e) => e.name === "invoices.customer_id");
    assert.ok(
      /ADD COLUMN `customer_id`/i.test(entry.ddl),
      "deniedCritical entry must carry the DBA-actionable DDL"
    );
    // ONLY invoices.customer_id lands in deniedCritical, even though
    // many other MIGRATIONS entries are also denied.
    assert.equal(
      names.length,
      1,
      `deniedCritical must be scoped to the critical migration; got ${names.join(",")}`
    );
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: idx_invoices_customer missing + ALTER DENIED → deniedCritical carries it", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // All columns PRESENT; idx_invoices_customer MISSING.
  const columnHandler = (sql, params) =>
    [[{ COLUMN_NAME: params && params[2] }], []];
  const indexHandler = (sql, params) => {
    if (params && params[2] === "idx_invoices_customer") return [[], []];
    if (params && params[2] === "idx_customers_status")
      return indexPresent("customers", "idx_customers_status");
    if (params && params[2] === "uq_shift_cash_movements_ref")
      return indexPresent("shift_cash_movements", "uq_shift_cash_movements_ref");
    return [[], []];
  };
  fakePool.__setQueryHandler(
    makeHandler({
      columnHandler,
      indexHandler,
      alterIndexErrorsAsDenied: true, // ← every ALTER KEY throws DENIED
    })
  );
  try {
    const result = await runRuntimeMigrations();
    const names = result.deniedCritical.map((e) => e.name);
    assert.ok(
      names.includes("idx_invoices_customer"),
      `deniedCritical must include idx_invoices_customer; got ${names.join(",")}`
    );
    assert.equal(
      names.length,
      1,
      `deniedCritical must be scoped to the critical index; got ${names.join(",")}`
    );
    const entry = result.deniedCritical.find(
      (e) => e.name === "idx_invoices_customer"
    );
    assert.ok(
      /ADD KEY `idx_invoices_customer`/i.test(entry.ddl),
      "deniedCritical entry must carry the DBA-actionable DDL"
    );
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: BOTH critical missing + ALTER DENIED → deniedCritical contains both", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  const columnHandler = (sql, params) => {
    if (params && params[1] === "invoices" && params[2] === "customer_id")
      return [[], []];
    return [[{ COLUMN_NAME: params && params[2] }], []];
  };
  const indexHandler = (sql, params) => {
    if (params && params[2] === "idx_invoices_customer") return [[], []];
    return [[], []];
  };
  fakePool.__setQueryHandler(
    makeHandler({
      columnHandler,
      indexHandler,
      alterErrorsAsDenied: true,
      alterIndexErrorsAsDenied: true,
    })
  );
  try {
    const result = await runRuntimeMigrations();
    const names = result.deniedCritical.map((e) => e.name).sort();
    assert.deepEqual(names, [
      "idx_invoices_customer",
      "invoices.customer_id",
    ]);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: unrelated column (customers.gstin) denied → deniedCritical stays empty", async () => {
  // The fix is narrowly scoped. A denial on a non-critical column
  // (here we model `customers.gstin` missing on a fresh DB AND the app
  // user can't ALTER) must still soft-warn, not abort. The denied
  // counter goes up but deniedCritical stays empty.
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  const columnHandler = (sql, params) => {
    if (params && params[1] === "customers" && params[2] === "gstin")
      return [[], []];
    return [[{ COLUMN_NAME: params && params[2] }], []];
  };
  const indexHandler = () => [[], []];
  fakePool.__setQueryHandler(
    makeHandler({
      columnHandler,
      indexHandler,
      alterErrorsAsDenied: true,
    })
  );
  try {
    const result = await runRuntimeMigrations();
    assert.equal(
      result.deniedCritical.length,
      0,
      `deniedCritical must remain empty for non-critical denials; got ${result.deniedCritical
        .map((e) => e.name)
        .join(",")}`
    );
    // The unrelated denial still surfaces in `denied` for the operator.
    assert.ok(result.denied >= 1, "denied counter must still go up");
    assert.ok(
      result.deniedNames.includes("customers.gstin"),
      `deniedNames must include customers.gstin; got ${result.deniedNames.join(",")}`
    );
    assert.ok(
      !result.deniedNames.includes("invoices.customer_id"),
      "the existing invoices.customer_id must remain in the denied Names only when it's actually missing"
    );
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: critical column missing but ALTER succeeds → no denial at all", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // invoices.customer_id missing, but the ALTER succeeds (the app user
  // HAS ALTER on this DB).
  const columnHandler = (sql, params) => {
    if (params && params[1] === "invoices" && params[2] === "customer_id")
      return [[], []];
    return [[{ COLUMN_NAME: params && params[2] }], []];
  };
  const indexHandler = () => [[], []];
  fakePool.__setQueryHandler(
    makeHandler({
      columnHandler,
      indexHandler,
      // No alterErrorsAsDenied — ALTER succeeds.
    })
  );
  try {
    const result = await runRuntimeMigrations();
    assert.equal(result.denied, 0);
    assert.equal(result.deniedCritical.length, 0);
    assert.ok(
      result.applied >= 1,
      "applied counter must reflect the successful ALTER"
    );
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: ALTER throws a non-DENIED error → not flagged as critical denial", async () => {
  // A non-permission failure (e.g. the table doesn't exist, or some
  // other transient schema error) must NOT abort startup. The runner
  // logs the failure as a generic warning; deniedCritical stays
  // empty so unrelated infrastructure issues don't bring down the app.
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  const columnHandler = (sql, params) => {
    if (params && params[1] === "invoices" && params[2] === "customer_id")
      return [[], []];
    return [[{ COLUMN_NAME: params && params[2] }], []];
  };
  const indexHandler = () => [[], []];
  fakePool.__setQueryHandler(
    makeHandler({
      columnHandler,
      indexHandler,
      alterErrorsAsOther: "Table 'invoices.invoices' doesn't exist",
    })
  );
  try {
    const result = await runRuntimeMigrations();
    assert.equal(
      result.deniedCritical.length,
      0,
      "non-DENIED ALTER failures must not enter deniedCritical"
    );
    assert.equal(result.denied, 0);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

// === Probe-failure gate (information_schema re-probe) =====================
//
// The hard-startup-gate has two legs:
//   1. ALTER is denied   → deniedCritical populated, index.js aborts
//   2. information_schema probe fails twice for a critical entry →
//      unconfirmedCritical populated, index.js aborts.
//
// These tests pin leg (2). The runner re-probes once for critical
// migrations only; for unrelated migrations the original fail-open
// behavior is preserved. The tests verify three shapes:
//
//   a. Critical probe fails twice  → unconfirmedCritical carries it,
//      boot is blocked (deniedCritical stays empty).
//   b. Critical probe fails once then re-probe succeeds (column is
//      confirmed missing) → runner falls through to the ALTER path,
//      boot is allowed, unconfirmedCritical stays empty.
//   c. Critical probe fails once then re-probe succeeds (column is
//      confirmed present) → runner takes the skipped path, no ALTER,
//      boot is allowed, unconfirmedCritical stays empty.

test("runRuntimeMigrations: critical column probe fails twice → unconfirmedCritical carries it", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // Two throws on the invoices.customer_id probe; all OTHER column /
  // index probes succeed. The runner should re-probe once, the second
  // probe also fails, and the entry lands in unconfirmedCritical. The
  // runner does NOT then attempt the ALTER — proceeding blind could
  // either silently miss a missing column or ALTER a column with the
  // wrong shape.
  const opts = stageAllPresentWithOverrides({
    columnProbeFailures: new Map([["invoices|customer_id", 2]]),
  });
  fakePool.__setQueryHandler(makeHandler(opts));
  try {
    const result = await runRuntimeMigrations();
    const names = result.unconfirmedCritical.map((e) => e.name);
    assert.ok(
      names.includes("invoices.customer_id"),
      `unconfirmedCritical must include invoices.customer_id; got ${names.join(",")}`
    );
    assert.equal(
      names.length,
      1,
      `unconfirmedCritical must be scoped to the critical migration; got ${names.join(",")}`
    );
    const entry = result.unconfirmedCritical.find(
      (e) => e.name === "invoices.customer_id"
    );
    assert.ok(
      /ADD COLUMN `customer_id`/i.test(entry.ddl),
      "unconfirmedCritical entry must carry the DBA-actionable DDL"
    );
    assert.equal(result.deniedCritical.length, 0);
    assert.equal(result.denied, 0);
    // The unrelated probe-failure budget was 2 throws; the runner used
    // both (initial + re-probe) for invoices.customer_id. Every other
    // critical migration (the index) is staged as present so no other
    // entry enters unconfirmedCritical.
    assert.deepEqual(result.unconfirmedNames, ["invoices.customer_id"]);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: critical index probe fails twice → unconfirmedCritical carries it", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // Two throws on the idx_invoices_customer probe; the column probe
  // confirms invoices.customer_id is present so no column-side
  // unconfirmed entry is created.
  const opts = stageAllPresentWithOverrides({
    indexProbeFailures: new Map([["invoices|idx_invoices_customer", 2]]),
  });
  fakePool.__setQueryHandler(makeHandler(opts));
  try {
    const result = await runRuntimeMigrations();
    const names = result.unconfirmedCritical.map((e) => e.name);
    assert.ok(
      names.includes("idx_invoices_customer"),
      `unconfirmedCritical must include idx_invoices_customer; got ${names.join(",")}`
    );
    assert.equal(names.length, 1);
    const entry = result.unconfirmedCritical.find(
      (e) => e.name === "idx_invoices_customer"
    );
    assert.ok(
      /ADD KEY `idx_invoices_customer`/i.test(entry.ddl),
      "unconfirmedCritical entry must carry the DBA-actionable DDL"
    );
    assert.equal(result.deniedCritical.length, 0);
    assert.equal(result.denied, 0);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: critical probe fails once, re-probe confirms missing → ALTER proceeds, boot allowed", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // The first probe throws (transient); the re-probe succeeds and
  // reports the column as missing. The runner takes the ALTER path
  // and applies the column. unconfirmedCritical stays empty.
  const opts = stageMissingCriticalWithOverrides({
    columnProbeFailures: new Map([["invoices|customer_id", 1]]),
  });
  fakePool.__setQueryHandler(makeHandler(opts));
  try {
    const result = await runRuntimeMigrations();
    assert.equal(
      result.unconfirmedCritical.length,
      0,
      `unconfirmedCritical must stay empty when re-probe succeeds; got ${result.unconfirmedCritical
        .map((e) => e.name)
        .join(",")}`
    );
    assert.equal(result.deniedCritical.length, 0);
    // The column was missing + ALTER succeeded → applied >= 1.
    assert.ok(
      result.applied >= 1,
      "applied counter must reflect the successful ALTER after a transient probe blip"
    );
    assert.equal(result.denied, 0);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: critical probe fails once, re-probe confirms present → no ALTER, boot allowed", async () => {
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  // Stage every MIGRATIONS column as present, including invoices.customer_id.
  // Throw on the FIRST probe only; the re-probe succeeds and confirms
  // presence. The runner takes the skipped path — no ALTER.
  const opts = stageAllPresentWithOverrides({
    columnProbeFailures: new Map([["invoices|customer_id", 1]]),
  });
  fakePool.__setQueryHandler(makeHandler(opts));
  try {
    const result = await runRuntimeMigrations();
    assert.equal(
      result.unconfirmedCritical.length,
      0,
      `unconfirmedCritical must stay empty when re-probe confirms presence; got ${result.unconfirmedCritical
        .map((e) => e.name)
        .join(",")}`
    );
    assert.equal(result.deniedCritical.length, 0);
    // No ALTER attempted because the re-probe confirmed presence.
    assert.equal(result.applied, 0);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});

test("runRuntimeMigrations: UNRELATED column probe fails twice → unconfirmedCritical stays empty (fail-open preserved)", async () => {
  // A non-critical migration whose probe fails twice must NOT enter
  // unconfirmedCritical. The runner preserves the original fail-open
  // behavior for unrelated entries: log the failure, attempt the ALTER,
  // surface success/denial inline. The unrelated ALTER succeeds in this
  // test, so applied >= 1 and no denied/deniedCritical entry is created.
  fakePool.reset();
  const restoreEnv = resetEnv("pos_test");
  const opts = stageAllPresentWithOverrides({
    columnProbeFailures: new Map([["customers|gstin", 2]]),
  });
  fakePool.__setQueryHandler(makeHandler(opts));
  try {
    const result = await runRuntimeMigrations();
    assert.equal(
      result.unconfirmedCritical.length,
      0,
      `unconfirmedCritical must remain empty for non-critical probe failures; got ${result.unconfirmedCritical
        .map((e) => e.name)
        .join(",")}`
    );
    assert.equal(
      result.unconfirmedNames.length,
      0,
      "unconfirmedNames must also stay empty for non-critical probe failures"
    );
    assert.equal(result.deniedCritical.length, 0);
  } finally {
    restoreEnv();
    fakePool.reset();
  }
});
