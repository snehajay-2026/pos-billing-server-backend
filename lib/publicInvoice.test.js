// server/lib/publicInvoice.test.js
//
// F11: regression pins for the public-invoice sanitizer. The WhatsApp /
// Email share link flows through `sanitizePublicInvoice()` which strips
// `items[].meta` — but the renderer chain on the public page needs the
// per-industry template metadata (industry, templateId, fields) the
// cashier saved onto the line item at billing time. Without the
// `pickTemplateMetaFromItems` hoist that lives in this module, the
// public share link falls back to the legacy `ServiceInvoice` /
// `MSMEInvoice` renderer and silently drops every per-industry Extra
// Field (PO Number, Founder / Signatory, Service Period, etc.).
//
// We exercise two surfaces:
//
//   1. `pickTemplateMetaFromItems()` directly — pure function, no DB
//      dependency, can be asserted against in isolation.
//   2. `sanitizePublicInvoice()` end-to-end — pins that the hoist lands
//      the metadata at the top level on the response, and that the
//      downstream `meta` strip does not erase them.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

// Stub the DB pool before publicInvoice.js captures its module-level
// imports. We don't run any queries — the hoist + sanitize logic is
// pure data transformation on the row argument — but publicInvoice.js
// transitively requires `invoicesQueries` which requires the pool at
// load time. Mirrors the require.cache trick used in
// customers.authorization.test.js so the test runs without MySQL env
// vars.
const fakePool = {
  async query() {
    return [[], []];
  },
  async withTransaction(fn) {
    const conn = { query: async () => [[], []] };
    return await fn(conn);
  },
};
require.cache[require.resolve("../db/pool")] = {
  id: require.resolve("../db/pool"),
  filename: require.resolve("../db/pool"),
  loaded: true,
  exports: fakePool,
};
require.cache[require.resolve("../db/queries/store-settings")] = {
  id: require.resolve("../db/queries/store-settings"),
  filename: require.resolve("../db/queries/store-settings"),
  loaded: true,
  exports: {
    getPayloadByScopeKey: async () => null,
  },
};
require.cache[require.resolve("../db/queries/users")] = {
  id: require.resolve("../db/queries/users"),
  filename: require.resolve("../db/queries/users"),
  loaded: true,
  exports: {
    findByEmail: async () => null,
  },
};

const {
  pickTemplateMetaFromItems,
  sanitizePublicInvoice,
} = require("./publicInvoice");

// F11: a Startup invoice whose only copy of the per-industry metadata
// lives on `items[0].meta.fields` survives `pickTemplateMetaFromItems`
// unchanged. The renderer reads these keys via `resolveInvoiceFields`
// → `fields.founderName` / `fields.incorporationNo`, so any loss here
// is a silent field drop on the rendered page.
test("pickTemplateMetaFromItems hoists Startup founder + incorporation fields", () => {
  const items = [
    {
      name: "Service",
      meta: {
        industry: "startup",
        templateId: "startup-modern",
        fields: {
          founderName: "Ajay Merchant",
          incorporationNo: "U74999MH2024PTC123456",
        },
      },
    },
  ];
  const out = pickTemplateMetaFromItems(items);
  assert.equal(out.industry, "startup");
  assert.equal(out.templateId, "startup-modern");
  assert.deepEqual(out.fields, {
    founderName: "Ajay Merchant",
    incorporationNo: "U74999MH2024PTC123456",
  });
});

// F11: a Manufacturing invoice carries PO Number, Packing & Forwarding,
// and e-Way Bill Note on the line item. The named `po` branch in
// TraditionalA4.jsx reads all three — the renderer only renders them
// if the sanitizer hoists them up before stripping `meta`.
test("pickTemplateMetaFromItems hoists Manufacturing PO/packing/eWayBill fields", () => {
  const items = [
    {
      name: "Goods",
      meta: {
        industry: "manufacturing",
        templateId: "manufacturing-traditional",
        fields: {
          poNumber: "PO-2026-041",
          packing: "200",
          eWayBillNote: "EWB-12345",
          placeOfSupply: "27-Maharashtra",
        },
      },
    },
  ];
  const out = pickTemplateMetaFromItems(items);
  assert.equal(out.industry, "manufacturing");
  assert.equal(out.templateId, "manufacturing-traditional");
  assert.deepEqual(out.fields, {
    poNumber: "PO-2026-041",
    packing: "200",
    eWayBillNote: "EWB-12345",
    placeOfSupply: "27-Maharashtra",
  });
});

// F11: Real Estate Service Period — a single-key industry field that
// only exists because of the F11 named-block addition in
// ModernA4.jsx. Without the hoist, the public share link loses it.
test("pickTemplateMetaFromItems hoists Real Estate servicePeriod", () => {
  const items = [
    {
      name: "Rent",
      meta: {
        industry: "realestate",
        templateId: "realestate-modern",
        fields: {
          agreementRef: "AGR-2026-009",
          propertyAddress: "Flat 3B, Sea Breeze Towers",
          servicePeriod: "01 May — 31 May 2026",
          stampDutyNote: "Stamp duty payable by buyer",
        },
      },
    },
  ];
  const out = pickTemplateMetaFromItems(items);
  assert.equal(out.industry, "realestate");
  assert.equal(out.fields.servicePeriod, "01 May — 31 May 2026");
});

// F11: a malformed `fields` (typed array, primitive, null) must not
// crash the hoist — a legacy row with junk metadata still resolves to
// an empty hoist so the renderer falls back cleanly without throwing.
test("pickTemplateMetaFromItems tolerates malformed fields payloads", () => {
  assert.deepEqual(
    pickTemplateMetaFromItems([
      { name: "Service", meta: { industry: "consulting", fields: null } },
    ]),
    { industry: "consulting", templateId: null, fields: null }
  );
  assert.deepEqual(
    pickTemplateMetaFromItems([
      { name: "Service", meta: { fields: ["PO-1", "PO-2"] } },
    ]),
    {}
  );
  assert.deepEqual(
    pickTemplateMetaFromItems([
      { name: "Service", meta: { fields: "PO-2026-041" } },
    ]),
    {}
  );
  // Empty object → no industry/templateId/fields signals on meta → empty hoist.
  assert.deepEqual(
    pickTemplateMetaFromItems([
      { name: "Service", meta: { fields: {} } },
    ]),
    {}
  );
});

// F11: items[] with no `meta` at all (legacy pre-F10 rows) returns an
// empty hoist — the sanitizer should not crash, and the public viewer
// should fall through to the legacy ServiceInvoice renderer.
test("pickTemplateMetaFromItems returns {} when no item carries meta", () => {
  assert.deepEqual(pickTemplateMetaFromItems([]), {});
  assert.deepEqual(
    pickTemplateMetaFromItems([{ name: "Service" }, { name: "Other" }]),
    {}
  );
});

// F11: end-to-end. The sanitizer must hoist the metadata onto the
// top-level response and the subsequent `items[].meta` strip must not
// erase what the renderer needs. This is the actual contract the public
// share link depends on — anything else is a silent field drop.
test("sanitizePublicInvoice hoists F11 metadata for service invoices", async () => {
  const row = {
    invoiceNo: "SVC-F11-001",
    storeType: "service",
    storeId: "A",
    _storeType: "service",
    _storeId: "A",
    _userEmail: "cashier@example.com",
    items: [
      {
        name: "Service",
        meta: {
          industry: "startup",
          templateId: "startup-modern",
          fields: {
            founderName: "Ajay Merchant",
            incorporationNo: "U74999MH2024PTC123456",
          },
        },
      },
    ],
  };

  const out = await sanitizePublicInvoice(row);

  assert.equal(out.industry, "startup");
  assert.equal(out.templateId, "startup-modern");
  assert.equal(out.fields.founderName, "Ajay Merchant");
  assert.equal(out.fields.incorporationNo, "U74999MH2024PTC123456");

  // The per-item `meta` block is still stripped (it carries internal
  // data the public viewer must not see) — but the hoisted top-level
  // copies survive. This is the core F11 invariant.
  assert.equal(Array.isArray(out.items), true);
  assert.equal(out.items[0].meta, undefined);
  assert.equal(out.items[0].name, "Service");
});

// F11: top-level `industry` / `templateId` on the row win over the
// per-item `meta` copy. `fields` is hoisted only when the top-level
// copy is missing or empty — a non-empty top-level `fields` is treated
// as authoritative and the meta hoist is skipped entirely (so a
// future endpoint that surfaces the merged map at the top level wins,
// and a top-level `{ engagementRef: ... }` never gets clobbered with
// meta-side keys).
test("sanitizePublicInvoice top-level metadata wins over meta", async () => {
  const row = {
    invoiceNo: "SVC-F11-002",
    storeType: "service",
    storeId: "A",
    _storeType: "service",
    _storeId: "A",
    _userEmail: "cashier@example.com",
    industry: "consulting",
    templateId: "consulting-modern",
    fields: { engagementRef: "MSA-TOP" },
    items: [
      {
        name: "Service",
        meta: {
          industry: "manufacturing",
          templateId: "manufacturing-traditional",
          fields: {
            engagementRef: "MSA-META",
            poNumber: "PO-META",
          },
        },
      },
    ],
  };

  const out = await sanitizePublicInvoice(row);

  // Top-level wins for industry/templateId even when meta disagrees.
  assert.equal(out.industry, "consulting");
  assert.equal(out.templateId, "consulting-modern");
  // Top-level fields wins — meta's keys are NOT merged in (the
  // non-empty top-level fields is treated as authoritative).
  assert.deepEqual(out.fields, { engagementRef: "MSA-TOP" });
});

// F11: when the top-level `fields` is empty/missing, the meta-side
// fields get hoisted in full. This is the original F9 hoist path and
// is what makes the public share link work today for invoices whose
// only fields copy lives on items[0].meta.
test("sanitizePublicInvoice hoists meta fields when top-level is empty", async () => {
  const row = {
    invoiceNo: "SVC-F11-003",
    storeType: "service",
    storeId: "A",
    _storeType: "service",
    _storeId: "A",
    _userEmail: "cashier@example.com",
    items: [
      {
        name: "Service",
        meta: {
          industry: "manufacturing",
          templateId: "manufacturing-traditional",
          fields: {
            poNumber: "PO-META",
            packing: "200",
          },
        },
      },
    ],
  };

  const out = await sanitizePublicInvoice(row);

  assert.equal(out.industry, "manufacturing");
  assert.equal(out.templateId, "manufacturing-traditional");
  assert.deepEqual(out.fields, { poNumber: "PO-META", packing: "200" });
});

// F11: hoist is scoped to service / msme-service storeTypes. A hotel
// invoice whose line item happens to carry `meta.industry` should NOT
// have its industry hoisted onto the top-level — the renderer for
// hotel rows doesn't read it and a wrong hoist could mask a real bug
// elsewhere. This pins the existing scoping (matches the
// `rest.storeType === "service" || rest.storeType === "msme-service"`
// guard in `sanitizePublicInvoice`).
test("sanitizePublicInvoice does not hoist industry for non-service storeTypes", async () => {
  const row = {
    invoiceNo: "HOT-F11-001",
    storeType: "hotel",
    storeId: "H1",
    _storeType: "hotel",
    _storeId: "H1",
    _userEmail: "owner@example.com",
    items: [
      {
        name: "Room",
        meta: {
          industry: "startup",
          templateId: "startup-modern",
          fields: { founderName: "Should Not Hoist" },
        },
      },
    ],
  };

  const out = await sanitizePublicInvoice(row);

  assert.equal(out.industry, undefined);
  assert.equal(out.templateId, undefined);
  assert.equal(out.fields, undefined);
});
