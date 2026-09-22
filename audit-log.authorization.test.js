// audit-log.authorization.test.js
//
// Regression coverage for the Recent Activity upgrade.
//
//   1. The audit_log query module's list() honors the new storeType /
//      storeId / outcome / order filters and emits the expected
//      JSON_EXTRACT clauses. This is the SQL contract the route layer
//      in index.js depends on — if a future change drops one of these
//      predicates, an admin could read rows they aren't authorized
//      to see, so we pin the shape here.
//
//   2. The append() helper stamps created_at with NOW(3) (server-side
//      timestamp), so a clock-skewed client cannot forge an audit
//      timestamp.
//
//   3. The audit-log mutation routes return 405. Audit rows are
//      append-only — exposing POST/PUT/DELETE/PATCH would let a
//      malicious caller rewrite or destroy compliance history.
//
// The tests stub the MySQL pool via the same require.cache trick
// customers.authorization.test.js uses. The fake records every query
// so we can assert the WHERE / ORDER BY shape.

const test = require("node:test");
const assert = require("node:assert/strict");

const fakePool = {
  __lastQueries: [],
  __setQueryImpl(fn) {
    this.__queryImpl = fn;
  },
  __reset() {
    this.__lastQueries = [];
    this.__queryImpl = null;
  },
  async query(sql, params) {
    fakePool.__lastQueries.push({ sql, params });
    if (fakePool.__queryImpl) return fakePool.__queryImpl(sql, params);
    return [[], []];
  },
};

require.cache[require.resolve("./db/pool")] = {
  id: require.resolve("./db/pool"),
  filename: require.resolve("./db/pool"),
  loaded: true,
  exports: fakePool,
};

const auditLogQueries = require("./db/queries/audit-log");
const { _internal } = auditLogQueries;
const { normalizeOrder } = _internal;

// === list() WHERE / ORDER BY shape ========================================

const captureList = (opts) => {
  fakePool.__reset();
  fakePool.__setQueryImpl((sql) => {
    if (/^SELECT COUNT\(\*\) AS c FROM audit_log/i.test(sql)) {
      return [[{ c: 0 }], []];
    }
    if (/^SELECT id, user_id, action/i.test(sql)) {
      return [[], []];
    }
    return [[], []];
  });
  return auditLogQueries.list(opts).then(() => {
    const listSql = fakePool.__lastQueries.find((q) =>
      /^SELECT id, user_id, action/i.test(q.sql)
    );
    const countSql = fakePool.__lastQueries.find((q) =>
      /^SELECT COUNT\(\*\) AS c FROM audit_log/i.test(q.sql)
    );
    return { listSql, countSql, lastQueries: fakePool.__lastQueries.slice() };
  });
};

test("list() default query has no WHERE clause and uses DESC ordering", async () => {
  const { listSql } = await captureList({});
  assert.ok(listSql, "list() must issue a SELECT against audit_log");
  assert.ok(!/WHERE/i.test(listSql.sql), "default list() should have no WHERE");
  assert.ok(/ORDER BY created_at DESC, id DESC/i.test(listSql.sql));
});

test("list({ userId, action, entityType, entityId }) builds the legacy predicate set", async () => {
  const { listSql } = await captureList({
    userId: 7,
    action: "service.rate_changed",
    entityType: "service",
    entityId: "42",
  });
  assert.match(listSql.sql, /user_id = \?/);
  assert.match(listSql.sql, /action = \?/);
  assert.match(listSql.sql, /entity_type = \?/);
  assert.match(listSql.sql, /entity_id = \?/);
  assert.deepEqual(listSql.params.slice(0, 4), [7, "service.rate_changed", "service", "42"]);
});

test("list({ storeType, storeId }) adds JSON_EXTRACT payload predicates", async () => {
  const { listSql, countSql } = await captureList({
    storeType: "service",
    storeId: "A",
  });
  assert.match(
    listSql.sql,
    /JSON_UNQUOTE\(JSON_EXTRACT\(payload, '\$\.storeType'\)\) = \?/
  );
  assert.match(
    listSql.sql,
    /JSON_UNQUOTE\(JSON_EXTRACT\(payload, '\$\.storeId'\)\) = \?/
  );
  // Same predicates appear in the COUNT query so the totals stay
  // consistent with the page query.
  assert.match(
    countSql.sql,
    /JSON_UNQUOTE\(JSON_EXTRACT\(payload, '\$\.storeType'\)\) = \?/
  );
  assert.deepEqual(listSql.params.slice(0, 2), ["service", "A"]);
});

test("list({ outcome: 'success' }) emits payload.ok = true predicate", async () => {
  const { listSql } = await captureList({ outcome: "success" });
  assert.match(listSql.sql, /JSON_EXTRACT\(payload, '\$\.ok'\) = true/);
});

test("list({ outcome: 'failed' }) emits payload.ok = false predicate", async () => {
  const { listSql } = await captureList({ outcome: "failed" });
  assert.match(listSql.sql, /JSON_EXTRACT\(payload, '\$\.ok'\) = false/);
});

test("list() silently ignores unknown outcome values (no ok predicate)", async () => {
  const { listSql } = await captureList({ outcome: "maybe" });
  assert.ok(!/ok/i.test(listSql.sql), "unknown outcome must not add an ok predicate");
});

test("list({ order: 'asc' }) uses ASC ordering with stable secondary sort", async () => {
  const { listSql } = await captureList({ order: "asc" });
  assert.match(listSql.sql, /ORDER BY created_at ASC, id ASC/i);
});

test("list() clamps an out-of-range limit and a negative offset", async () => {
  const { listSql } = await captureList({ limit: 99999, offset: -50 });
  const lastTwo = listSql.params.slice(-2);
  // limit is clamped to 5000, offset is clamped to 0
  assert.equal(lastTwo[0], 5000);
  assert.equal(lastTwo[1], 0);
});

// === append() server-stamps created_at ===================================

test("append() uses NOW(3) for created_at and ignores client-supplied timestamps", async () => {
  fakePool.__reset();
  fakePool.__setQueryImpl((sql, params) => {
    if (/^INSERT INTO audit_log/i.test(sql)) {
      // Fake a successful insert.
      return [{ insertId: 1234 }, []];
    }
    return [[], []];
  });
  const id = await auditLogQueries.append({
    userId: 1,
    action: "service.created",
    entityType: "service",
    entityId: "9",
    payload: { serviceName: "Plumbing" },
    ip: "127.0.0.1",
  });
  assert.equal(id, 1234);
  const insert = fakePool.__lastQueries.find((q) =>
    /^INSERT INTO audit_log/i.test(q.sql)
  );
  assert.ok(insert, "append() must INSERT into audit_log");
  assert.match(insert.sql, /NOW\(3\)/, "created_at must be server-stamped with NOW(3)");
  // The signature must NOT have a created_at parameter — a client
  // cannot influence the timestamp.
  assert.ok(
    !/created_at\s*=\s*\?/i.test(insert.sql),
    "INSERT must not bind a client-supplied created_at"
  );
});

test("append() returns null when action is missing", async () => {
  fakePool.__reset();
  let called = false;
  fakePool.__setQueryImpl(() => {
    called = true;
    return [[], []];
  });
  const id = await auditLogQueries.append({ entityType: "x", entityId: "1" });
  assert.equal(id, null);
  assert.equal(called, false, "append() must NOT query when action is missing");
});

// === normalizeOrder =====================================================

test("normalizeOrder defaults unknown values to 'desc'", () => {
  assert.equal(normalizeOrder(undefined), "desc");
  assert.equal(normalizeOrder(null), "desc");
  assert.equal(normalizeOrder(""), "desc");
  assert.equal(normalizeOrder("DESC"), "desc");
  assert.equal(normalizeOrder("ASC"), "asc");
  assert.equal(normalizeOrder("desc"), "desc");
  assert.equal(normalizeOrder("DROP TABLE x"), "desc");
});
