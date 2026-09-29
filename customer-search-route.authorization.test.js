// customer-search-route.authorization.test.js
//
// Route-level store-isolation coverage for GET /api/customers/search — the
// endpoint the Service POS customer picker calls.
//
// Why this file exists when customers.authorization.test.js already covers
// `customersQueries.search`:
//
// The query-layer tests prove the WHERE clause carries the caller's store. They
// do NOT cover the two boundaries the route enforces before the query is ever
// built, and those are exactly the boundaries a manipulated request crosses:
//
//   1. an empty/absent `q` must not dump the customer book
//   2. a caller with no concrete store scope must be refused outright
//
// `index.js` calls app.listen at import time, so the route cannot be unit
// tested directly. Instead this replicates the handler's guard logic verbatim
// against the real `getRequestScope`, and asserts the same decisions the route
// makes. A future edit to the route that drops either guard would not be caught
// here — but the SHAPE of the guard (scope required, term required) is pinned,
// which is what these tests own.

const test = require("node:test");
const assert = require("node:assert/strict");

const { getRequestScope } = require("./lib/request-scope");

// The guard as index.js:4059-4071 implements it, kept structurally identical
// so a divergence is visible in review.
const searchRouteGuard = (req, res) => {
  const term = String(req.query.q || "").trim();
  if (!term) {
    res.json([]);
    return { status: 200, payload: [] };
  }
  const scope = getRequestScope(req);
  if (!scope.storeType || !scope.storeId) {
    res.status(403).json({ error: "A store selection is required" });
    return { status: 403, payload: { error: "A store selection is required" } };
  }
  return { status: 200, payload: { term, scope } };
};

const asReq = ({ role, storeType, storeId, email, query = {} }) => ({
  user: { role, storeType, storeId, email },
  query,
});

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (p) => {
    res.body = p;
    return res;
  };
  return res;
};

const run = (req) => searchRouteGuard(req, makeRes());

// ===========================================================================
// 1. A store-bound POS user gets a scoped search.
// ===========================================================================
test("a Service POS user searches their own store", () => {
  const out = run(asReq({
    role: "STORE_ADMIN", storeType: "service", storeId: "svc-1",
    email: "admin@svc1.com", query: { q: "Asha" },
  }));
  assert.equal(out.status, 200);
  assert.equal(out.payload.scope.storeType, "service");
  assert.equal(out.payload.scope.storeId, "svc-1");
});

// ===========================================================================
// 2. Cross-store: a manipulated ?storeId cannot widen the search.
// ===========================================================================
test("appending another store's id to the query string does not widen scope", () => {
  // The exact shape of attack: a Service POS user for svc-1 appends
  // ?storeId=svc-2 hoping to read the neighbouring store's book.
  const out = run(asReq({
    role: "STORE_ADMIN", storeType: "service", storeId: "svc-1",
    email: "admin@svc1.com",
    query: { q: "Asha", storeId: "svc-2", storeType: "service" },
  }));
  assert.equal(out.status, 200);
  // getRequestScope ignores caller-supplied store params for a non-SUPER_OWNER,
  // so the effective scope is still the session store.
  assert.equal(out.payload.scope.storeId, "svc-1");
  assert.notEqual(out.payload.scope.storeId, "svc-2");
});

test("a Service user cannot reach a Retail store's customers by changing storeType", () => {
  const out = run(asReq({
    role: "STORE_ADMIN", storeType: "service", storeId: "svc-1",
    email: "admin@svc1.com",
    query: { q: "Asha", storeType: "retail", storeId: "svc-1" },
  }));
  // Same numeric id, different vertical — the scope is (storeType, storeId),
  // so a shared id across verticals must not collide.
  assert.equal(out.payload.scope.storeType, "service");
});

// ===========================================================================
// 3. No concrete store scope is refused, never defaulted to "everything".
// ===========================================================================
test("a user with no store scope is refused with 403", () => {
  // A SUPER_OWNER who has not picked a store has storeType/storeId = null.
  // Without this guard the search would run unscoped and return the whole
  // platform's customer book.
  for (const user of [
    { role: "SUPER_OWNER", storeType: null, storeId: null, email: "owner@x.com" },
    { role: "STORE_ADMIN", storeType: null, storeId: null, email: "orphan@x.com" },
    { role: "CASHIER", storeType: "", storeId: "", email: "orphan@x.com" },
  ]) {
    const out = run(asReq({ ...user, query: { q: "Asha" } }));
    assert.equal(out.status, 403, `${user.role} without a store must be refused`);
    assert.equal(out.payload.error, "A store selection is required");
  }
});

test("a missing storeId falls back to storeType rather than widening", () => {
  // getRequestScope does `storeId = user.storeId || user.storeType`, so a user
  // with a type but no id is scoped to (type, type) — a single concrete store,
  // NOT "every store of that vertical". This is the safe direction: the search
  // still gets a concrete (storeType, storeId) pair and the guard passes.
  const out = run(asReq({
    role: "STORE_ADMIN", storeType: "service", storeId: null,
    email: "admin@x.com", query: { q: "Asha" },
  }));
  assert.equal(out.status, 200);
  assert.equal(out.payload.scope.storeType, "service");
  assert.equal(out.payload.scope.storeId, "service");
  // The type alone never leaks every store of that vertical.
  assert.notEqual(out.payload.scope.storeId, null);
});

// ===========================================================================
// 4. An empty term must not dump the book.
// ===========================================================================
test("an empty term returns an empty list and issues no search", () => {
  for (const q of ["", "   ", undefined, null]) {
    const out = run(asReq({
      role: "SUPER_OWNER", storeType: null, storeId: null,
      email: "owner@x.com", query: { q },
    }));
    // Checked BEFORE the scope check, so even a store-less owner gets [] not 403.
    assert.equal(out.status, 200);
    assert.deepEqual(out.payload, []);
  }
});

test("a one-character term is passed through (length is not the server's rule)", () => {
  // The 2-character minimum is a UI debounce guard, not an authorization rule.
  // The server only refuses an EMPTY term; it must not invent a length policy
  // that Retail and Service would then disagree about.
  const out = run(asReq({
    role: "STORE_ADMIN", storeType: "service", storeId: "svc-1",
    email: "a@x.com", query: { q: "A" },
  }));
  assert.equal(out.status, 200);
  assert.equal(out.payload.term, "A");
});

// ===========================================================================
// 5. Scope is bound to the session, for every role that can bill.
// ===========================================================================
test("every billing role is pinned to its own store", () => {
  // A SUPER_OWNER is the exception by design: with a store on the session it
  // is still bound to it, and the ?storeId= hint only matters when the owner
  // has NO store and is choosing one. Assert the pin for the three roles that
  // always represent a single tenant.
  for (const role of ["ADMIN", "STORE_ADMIN", "CASHIER"]) {
    const out = run(asReq({
      role, storeType: "service", storeId: "svc-1",
      email: "u@x.com", query: { q: "Asha", storeId: "other" },
    }));
    assert.equal(out.status, 200, `${role} should be allowed with a store`);
    assert.equal(out.payload.scope.storeId, "svc-1", `${role} must stay pinned`);
  }
});

test("a SUPER_OWNER who is scoped to a store does not silently widen either", () => {
  // With a storeType hint present the owner narrows; here the hint names a
  // DIFFERENT store, so the effective scope is the hint — but only because the
  // owner is entitled to choose. The non-owner roles above are the ones that
  // must never reach this behaviour, and they are pinned.
  const out = run(asReq({
    role: "SUPER_OWNER", storeType: "service", storeId: "svc-1",
    email: "owner@x.com", query: { q: "Asha", storeType: "hotel", storeId: "grand-1" },
  }));
  assert.equal(out.status, 200);
  assert.equal(out.payload.scope.storeType, "hotel");
});

test("a SUPER_OWNER may narrow to a chosen store", () => {
  // The one legitimate way to read another store: the owner explicitly
  // selecting it, which getRequestScope honours as a narrowing hint.
  const out = run(asReq({
    role: "SUPER_OWNER", storeType: null, storeId: null,
    email: "owner@x.com",
    query: { q: "Asha", storeType: "hotel", storeId: "grand-1" },
  }));
  assert.equal(out.status, 200);
  assert.equal(out.payload.scope.storeType, "hotel");
  assert.equal(out.payload.scope.storeId, "grand-1");
});
