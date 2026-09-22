// server/db/queries/services.js
//
// Same shape as products.js but for the `services` table. Columns per
// schema.sql: id, name, description, rate, hours, gst, category, industry,
// default_template_id, hsn_sac, field_values, _store_type, _store_id,
// _user_email, created_at, updated_at.
//
// The `industry` / `default_template_id` / `hsn_sac` columns were added
// in migration F9 in db/runtime-migrations.js so a service row in the
// Service Catalog can carry the per-product invoice-template mapping that
// the Service Billing screen auto-applies at bill time. The `field_values`
// column was added in F10 (same migration file) so the cashier's typed
// per-industry defaults (PO number, distributor code, etc.) persist on
// the row and pre-fill the next bill's industry-fields drawer. All four
// columns are nullable; legacy rows keep working.
//
// Conventions (matching db/queries/products.js):
//   - Returns plain JS objects, id cast to Number (Date.now() shape).
//   - All scope columns read from MySQL as snake_case; the rowToService
//     mapper exposes them as camelCase so the existing JSON contract is
//     preserved for the frontend.
//   - DECIMAL columns come back as strings under decimalNumbers:false —
//     we parse to Number for rate/hours/gst.
//   - JSON columns (`field_values`) come back as strings; rowToService
//     parses them with a safe-fallback to {} so the frontend never has
//     to null-check.
//
// Bug fix (mirrors products.js Bug #3): the previous buildWhere appended
// `_user_email = ?` unconditionally. That made a cashier's GET /api/services
// return [] whenever the catalog had been seeded by an admin in the same
// store. Reads now ignore email via includeEmail:false; ownership of writes
// is still gated on email through findByIdScoped (includeEmail:true).
//
// F10 backend validation: required-field gating. When a create/update
// submits an `industry` together with `fieldValues`, the same keys that
// the frontend form marked with a red `*` (via `requiredFieldsFor` on
// the registry) must be non-empty in the submitted object. This is the
// brief's "Validate submitted industry and field data on the backend
// wherever appropriate" requirement — a curl-spoofed POST that bypasses
// the form still can't land a half-filled Manufacturing row.

const { query } = require("../pool");

const COLUMNS =
  "id, name, description, rate, hours, gst, category, industry, default_template_id, hsn_sac, field_values, _store_type, _store_id, _user_email, created_at, updated_at";

// Safe JSON parser used by rowToService and the create/update paths.
// Tolerant of:
//   - null / undefined → {}
//   - empty string    → {}
//   - non-JSON strings → {} (logged once so a stale shape on disk
//     surfaces in monitoring without breaking the read path)
const safeParseJson = (raw, { fallback = {}, logLabel = "json" } = {}) => {
  if (raw == null) return fallback;
  if (typeof raw === "object") return raw;
  if (typeof raw !== "string") return fallback;
  const text = raw.trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch (err) {
    console.warn(`[services] could not parse ${logLabel}: ${err.message}`);
    return fallback;
  }
};

// Normalize the submitted fieldValues payload to a plain object of
// { [key]: string }. Strips arrays / nested objects / nulls so the JSON
// column stays predictable and the validator can simply Object.keys().
const normalizeFieldValues = (input) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed) out[k] = trimmed;
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = String(v);
    }
    // Arrays / objects on the way in are silently dropped — the registry
    // only ever emits string-valued fields.
  }
  return out;
};

// Mirror of the frontend helper at
// src/components/service/templates/index.js. Returns the list of field
// keys that the registry marks as `required: true` for a given industry.
// Lives here so a curl-spoofed create/update can't bypass the form's
// `*` markers — the brief's section 10 requires backend validation.
//
// Today the supported industries and their required keys are:
//   consulting    → engagementRef
//   manufacturing → poNumber
//   wholesale     → poNumber
//   hardware      → poNumber
//   trading       → poNumber
//   healthcare    → patientId
//   logistics     → lrNo
//   education     → courseName
//   nonprofit     → donorName
//
// Other industries (startup, realestate, distributors, construction,
// agriculture, foodbeverage, technology) intentionally have no required
// keys today — the cashier fills what they know and the bill saves with
// partial fields. Add entries here if a future product owner flags a
// field as must-have.
const REQUIRED_FIELDS_BY_INDUSTRY = {
  consulting: ["engagementRef"],
  manufacturing: ["poNumber"],
  wholesale: ["poNumber"],
  hardware: ["poNumber"],
  trading: ["poNumber"],
  healthcare: ["patientId"],
  logistics: ["lrNo"],
  education: ["courseName"],
  nonprofit: ["donorName"],
};

const requiredFieldsFor = (industryId) =>
  industryId && REQUIRED_FIELDS_BY_INDUSTRY[industryId]
    ? REQUIRED_FIELDS_BY_INDUSTRY[industryId]
    : [];

// Validate the (industry, fieldValues) pair against the registry's
// required-field markers. Throws an Error with .status = 400 and a
// human-readable message listing each missing key. Empty / missing
// industry means no validation runs (legacy callers that don't set
// industry at all are unaffected).
const validateFieldValues = (industry, fieldValues) => {
  if (!industry) return;
  const required = requiredFieldsFor(industry);
  if (!required.length) return;
  const values = fieldValues || {};
  const missing = required.filter(
    (k) => values[k] == null || String(values[k]).trim() === ""
  );
  if (missing.length) {
    const err = new Error(
      `Missing required field(s) for ${industry}: ${missing.join(", ")}`
    );
    err.status = 400;
    err.code = "MISSING_REQUIRED_FIELDS";
    err.missing = missing;
    throw err;
  }
};

const toNumber = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const rowToService = (row) => {
  if (!row) return null;
  return {
    id: row.id != null ? Number(row.id) : row.id,
    name: row.name || null,
    description: row.description || null,
    rate: toNumber(row.rate),
    hours: toNumber(row.hours),
    gst: toNumber(row.gst),
    category: row.category || null,
    // F9: per-service invoice-template mapping. The Service Billing
    // screen auto-applies these on a fresh bill; legacy rows keep them
    // null and the cashier picks manually or falls back to the
    // store-level default. Surfaced as camelCase to keep the JSON
    // contract the frontend already consumes.
    industry: row.industry || null,
    defaultTemplateId: row.default_template_id || null,
    hsnSac: row.hsn_sac || null,
    // F10: per-service dynamic field values. The column is LONGTEXT
    // holding a JSON-encoded { [fieldKey]: string } object. Parsing is
    // tolerant — null / empty / bad JSON all surface as {} so the
    // frontend never has to defend against undefined.
    fieldValues: safeParseJson(row.field_values, {
      fallback: {},
      logLabel: "field_values",
    }),
    _storeType: row._store_type || null,
    _storeId: row._store_id || null,
    _userEmail: row._user_email || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const buildWhere = (scope, query_, { includeEmail = false } = {}) => {
  const conds = [];
  const params = [];
  if (scope.storeType) { conds.push("_store_type = ?"); params.push(scope.storeType); }
  if (scope.storeId)   { conds.push("_store_id = ?");   params.push(scope.storeId); }
  if (includeEmail && scope.email) { conds.push("_user_email = ?"); params.push(scope.email); }
  for (const [k, v] of Object.entries(query_ || {})) {
    if (v === undefined || v === "") continue;
    if (k === "storeType" || k === "storeId" || k === "email") continue;
    conds.push(`\`${k}\` = ?`);
    params.push(v);
  }
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
};

const list = async (scope, query_ = {}) => {
  // Bug fix: do NOT include `_user_email` in the WHERE clause. The store
  // catalog is shared across all staff in the same store, so a cashier
  // must see services seeded by an admin.
  const where = buildWhere(scope, query_, { includeEmail: false });
  const rows = await query(
    `SELECT ${COLUMNS} FROM services ${where.sql} ORDER BY created_at DESC, id DESC`,
    where.params
  );
  return rows[0].map(rowToService);
};

// findByIdScoped: keeps the email filter (includeEmail:true) so a cashier
// can't mutate the admin's catalog by guessing an id. Reads via list()
// stay scope-wide.
const findByIdScoped = async (id, scope) => {
  const where = buildWhere(scope, {}, { includeEmail: true });
  const rows = await query(
    `SELECT ${COLUMNS} FROM services WHERE id = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [id, ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToService(rows[0][0]);
};

// findById: ignores scope (returns the row by id alone). Used by
// create()/update() to re-read after writing, where we don't yet have a
// scope-filtered context. Routes that need scope enforcement should call
// findByIdScoped directly.
const findById = async (id) => {
  const rows = await query(
    `SELECT ${COLUMNS} FROM services WHERE id = ? LIMIT 1`,
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToService(rows[0][0]);
};

// findByName: looks up a service row by its (store-scoped) name. Used by
// the service-order → invoice conversion flow (F1): the orders.service
// column stores a free-text name, not a numeric FK, so the route has to
// resolve the rate/GST by name. Includes the email filter (includeEmail
// defaults to true for writes here, mirroring findByIdScoped) so a
// cashier in one store can't accidentally invoice a service from a
// different store. Returns the first match.
const findByName = async (name, scope) => {
  if (!name) return null;
  const where = buildWhere(scope, {}, { includeEmail: true });
  const rows = await query(
    `SELECT ${COLUMNS} FROM services WHERE name = ? ${where.sql ? "AND " + where.sql.replace(/^WHERE /, "") : ""} LIMIT 1`,
    [String(name), ...where.params]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToService(rows[0][0]);
};

const create = async (item, scope) => {
  // F10: validate the (industry, fieldValues) pair before we touch the
  // DB. The required-field markers live on the same registry the
  // frontend reads so the * on the form matches the backend gate.
  const normalizedFields = normalizeFieldValues(item.fieldValues);
  validateFieldValues(item.industry, normalizedFields);
  const id = Date.now();
  await query(
    `INSERT INTO services
       (id, name, description, rate, hours, gst, category,
        industry, default_template_id, hsn_sac, field_values,
        _store_type, _store_id, _user_email, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
    [
      id,
      item.name || "",
      item.description || null,
      toNumber(item.rate) ?? 0,
      toNumber(item.hours),
      toNumber(item.gst) ?? 0,
      item.category || null,
      // F9: optional industry / template / HSN-SAC. NULL when the
      // cashier left the new fields blank — legacy callers keep
      // working unchanged.
      item.industry || null,
      item.defaultTemplateId || null,
      item.hsnSac || null,
      // F10: serialize the normalized field map. We persist NULL when
      // the cashier saved with no industry / no values so the column
      // doesn't carry a stray "{}" that would show up as truthy on a
      // future boolean check.
      Object.keys(normalizedFields).length
        ? JSON.stringify(normalizedFields)
        : null,
      scope.storeType || null,
      scope.storeId || null,
      scope.email || null,
    ]
  );
  return findById(id);
};

const update = async (id, patch) => {
  // F9: industry + defaultTemplateId + hsnSac ride on the same
  // allow-list pattern so a stray field on the request body never
  // touches the row. Empty strings normalize to NULL on the way in
  // so a cleared dropdown doesn't leave a stray "" in the catalog.
  // F10: fieldValues joins the allow-list with a JSON-encoded payload
  // (or NULL when cleared). When fieldValues is present we also need
  // industry on the same patch to validate the required keys — if the
  // cashier is changing industry alone without rewriting fields, we
  // fall back to the existing row's industry for the validation check.
  const allowed = [
    "name",
    "description",
    "rate",
    "hours",
    "gst",
    "category",
    "industry",
    "defaultTemplateId",
    "hsnSac",
    "fieldValues",
  ];

  // Run validation up front so we don't half-write a row. Read the
  // existing row first to know its current industry (the patch may not
  // include one).
  let existingIndustry = null;
  let existingFields = {};
  if (
    Object.prototype.hasOwnProperty.call(patch, "fieldValues") ||
    Object.prototype.hasOwnProperty.call(patch, "industry")
  ) {
    const existing = await findById(id);
    if (existing) {
      existingIndustry = existing.industry || null;
      existingFields = existing.fieldValues || {};
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "fieldValues")) {
    const normalized = normalizeFieldValues(patch.fieldValues);
    const effectiveIndustry =
      patch.industry !== undefined ? patch.industry || null : existingIndustry;
    validateFieldValues(effectiveIndustry, normalized);
  } else if (Object.prototype.hasOwnProperty.call(patch, "industry")) {
    // Industry change without an explicit fieldValues: validate the
    // existing field map against the new industry's required keys so
    // a switch from Manufacturing to Healthcare can't strand a row
    // with empty patientId when healthcare is now mandatory.
    validateFieldValues(patch.industry || null, existingFields);
  }

  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (["rate", "hours", "gst"].includes(k)) v = toNumber(v);
    // Treat blank strings as NULL for the optional template-mapping
    // fields so the cashier can clear a previously-set industry by
    // re-saving the service with the dropdown on "— none —".
    if (
      ["industry", "defaultTemplateId", "hsnSac"].includes(k) &&
      (v === "" || v === undefined)
    ) {
      v = null;
    }
    // F10: serialize the normalized field map; an empty object
    // collapses to NULL so the column stays tight.
    if (k === "fieldValues") {
      const normalized = normalizeFieldValues(v);
      v = Object.keys(normalized).length ? JSON.stringify(normalized) : null;
    }
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  if (!sets.length) {
    await query("UPDATE services SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE services SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM services WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = { list, findById, findByIdScoped, findByName, create, update, deleteById };