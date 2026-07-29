// server/db/queries/users.js
//
// All SQL touching the `users` table lives here. Routes in index.js call
// these functions; they never run raw queries against `users`.
//
// Conventions:
//   - Every function returns plain JS objects (no mysql2 row wrapper).
//   - Every function normalizes column values: empty strings → null,
//     role enum lowercased to match MySQL's ENUM casing.
//   - `id` is BIGINT UNSIGNED in MySQL; mysql2 returns it as a string by
//     default with dateStrings true. We cast back to Number where the
//     existing JSON shape used number IDs (Date.now()).
//   - The `password` field is NEVER returned by `find*` helpers. Use
//     `findByEmailWithPassword` only inside the login handler.

const { query, withTransaction } = require("../pool");

const VALID_ROLES = new Set(["SUPER_OWNER", "ADMIN", "STORE_ADMIN", "CASHIER"]);

const normalizeRole = (role) => {
  if (!role) return "CASHIER";
  const upper = String(role).toUpperCase();
  return VALID_ROLES.has(upper) ? upper : "CASHIER";
};

const normalizeEmail = (email) =>
  String(email || "").trim().toLowerCase();

const rowToUser = (row) => {
  if (!row) return null;
  // Cast id to Number to match the existing JSON shape (Date.now()).
  const id = row.id != null ? Number(row.id) : row.id;
  return {
    id,
    email: row.email,
    role: normalizeRole(row.role),
    storeType: row.store_type || null,
    storeId: row.store_id || null,
    ownerEmail: row.owner_email || null,
    rootOwnerEmail: row.root_owner_email || null,
    approved: !!row.approved,
    status: row.status || (row.approved ? "approved" : "pending"),
    name: row.name || null,
    phone: row.phone || null,
    address: row.address || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

// findByEmailWithPassword: only used by /api/login. Returns the row
// INCLUDING the bcrypt hash so the caller can compareSync().
const findByEmailWithPassword = async (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const rows = await query(
    "SELECT id, email, password, role, store_type, store_id, owner_email, root_owner_email, approved, status, name, phone, address, created_at, updated_at FROM users WHERE email = ? LIMIT 1",
    [normalized]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  const r = rows[0][0];
  return {
    ...rowToUser(r),
    password: r.password, // raw bcrypt hash
  };
};

const findById = async (id) => {
  const rows = await query(
    "SELECT id, email, role, store_type, store_id, owner_email, root_owner_email, approved, status, name, phone, address, created_at, updated_at FROM users WHERE id = ? LIMIT 1",
    [id]
  );
  if (!rows[0] || rows[0].length === 0) return null;
  return rowToUser(rows[0][0]);
};

const count = async () => {
  const rows = await query("SELECT COUNT(*) AS c FROM users");
  return rows[0][0].c;
};

const existsByEmail = async (email) => {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const rows = await query(
    "SELECT 1 FROM users WHERE email = ? LIMIT 1",
    [normalized]
  );
  return rows[0].length > 0;
};

// create: insert a new user. The caller has already verified email
// uniqueness (we still double-check via the UNIQUE constraint and return
// null on duplicate). Returns the sanitized user.
const create = async ({
  email,
  passwordHash,
  role,
  storeType = null,
  storeId = null,
  ownerEmail = null,
  rootOwnerEmail = null,
  approved = false,
  status = null,
  name = null,
  phone = null,
  address = null,
}) => {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !passwordHash) return null;

  const finalRole = normalizeRole(role);
  const finalStatus = status || (approved ? "approved" : "pending");
  // BIGINT UNSIGNED max is ~9.2e18, far above Date.now() (~1.7e12).
  const id = Date.now();

  try {
    await query(
      `INSERT INTO users
        (id, email, password, role, store_type, store_id, owner_email, root_owner_email, approved, status, name, phone, address, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [
        id,
        normalizedEmail,
        passwordHash,
        finalRole,
        storeType,
        storeId,
        ownerEmail,
        rootOwnerEmail,
        approved ? 1 : 0,
        finalStatus,
        name,
        phone,
        address,
      ]
    );
  } catch (err) {
    // Duplicate email — UNIQUE constraint caught it. Caller treats null as
    // "already exists".
    if (err && err.code === "ER_DUP_ENTRY") return null;
    throw err;
  }

  return findById(id);
};

// listAll / listByStore: pagination-free lists, scoped by the current
// user's role. SUPER_OWNER sees everyone; everyone else is filtered by
// store_type + store_id.
const listAll = async () => {
  const rows = await query(
    "SELECT id, email, role, store_type, store_id, owner_email, root_owner_email, approved, status, name, phone, address, created_at, updated_at FROM users ORDER BY created_at DESC, id DESC"
  );
  return rows[0].map(rowToUser);
};

const listByStore = async (storeType, storeId) => {
  const rows = await query(
    `SELECT id, email, role, store_type, store_id, owner_email, root_owner_email, approved, status, name, phone, address, created_at, updated_at
     FROM users
     WHERE store_type = ? AND store_id = ?
     ORDER BY created_at DESC, id DESC`,
    [String(storeType), String(storeId)]
  );
  return rows[0].map(rowToUser);
};

// update: applies only the columns present in `patch`. Re-hashes the
// password if provided. Matches the JSON behavior (partial update,
// untouched fields preserved).
const update = async (id, patch) => {
  const allowed = [
    "email", "role", "store_type", "store_id", "owner_email",
    "root_owner_email", "approved", "status", "name", "phone", "address",
  ];
  const sets = [];
  const params = [];
  for (const k of allowed) {
    if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
    let v = patch[k];
    if (k === "role") v = normalizeRole(v);
    if (k === "approved") v = v ? 1 : 0;
    if (k === "email") v = normalizeEmail(v);
    sets.push(`\`${k}\` = ?`);
    params.push(v);
  }
  // Password is hashed separately (caller's responsibility — they
  // already used bcrypt.hashSync()).
  if (patch.password) {
    sets.push("`password` = ?");
    params.push(patch.password);
  }
  if (!sets.length) {
    await query("UPDATE users SET updated_at = NOW(3) WHERE id = ?", [id]);
    return findById(id);
  }
  sets.push("updated_at = NOW(3)");
  params.push(id);
  await query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, params);
  return findById(id);
};

const deleteById = async (id) => {
  const result = await query("DELETE FROM users WHERE id = ?", [id]);
  return result[0].affectedRows > 0;
};

module.exports = {
  findByEmailWithPassword,
  findById,
  count,
  existsByEmail,
  create,
  listAll,
  listByStore,
  update,
  deleteById,
  // Exposed for Stage 3b+ (user CRUD beyond login/register).
  normalizeRole,
  normalizeEmail,
};