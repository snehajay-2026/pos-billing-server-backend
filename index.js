
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const fs = require("fs").promises;
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const usersQueries = require("./db/queries/users");
const productsQueries = require("./db/queries/products");
const invoicesQueries = require("./db/queries/invoices");

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";
const DATA_DIR = path.join(__dirname, "data");

const isAllowedOrigin = (origin) => {
  if (!origin) return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;
    const protocol = parsed.protocol;

    if (origin === FRONTEND_ORIGIN) {
      return true;
    }

    if ((hostname === "localhost" || hostname === "127.0.0.1") && (protocol === "http:" || protocol === "https:")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
};

const resourceFiles = {
  users: "users.json",
  products: "products.json",
  services: "services.json",
  expenses: "expenses.json",
  orders: "orders.json",
  invoices: "invoices.json",
  notifications: "notifications.json",
  "customer-credits": "customerCredits.json",
  customers: "customers.json",
  "store-settings": "storeSettings.json",
};

const hotelStoreDefaults = {
  tables: [],
  waiting: [],
  diningWaiting: [],
  lodgingWaiting: [],
  checkoutHistory: [],
  diningBills: [],
};

// hotelStore is loaded from server/data/hotel.json at startup so tables, waiting
// lists, dining bills, and checkout history survive server restarts. Mutating
// handlers MUST call persistHotelStore() after their in-memory update.
const hotelStore = { ...hotelStoreDefaults };

const loadHotelStore = async () => {
  let stored = {};
  try {
    stored = await readJson("hotel.json");
  } catch (err) {
    // ENOENT → first boot, no persisted state yet. Any other error has already
    // been logged by readJson's corruption handler; fall back to defaults so
    // the server still boots.
    if (err && err.code !== "ENOENT") {
      console.error("Failed to load hotel.json; using empty defaults.");
    }
  }
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of Object.keys(hotelStoreDefaults)) {
      if (Array.isArray(stored[key])) {
        hotelStore[key] = stored[key];
      }
    }
  }
};

const persistHotelStore = () => writeJson("hotel.json", hotelStore);

const hotelResourceMap = {
  "checkout-history": "checkoutHistory",
  "dining-bills": "diningBills",
  tables: "tables",
  waiting: "waiting",
  "dining-waiting": "diningWaiting",
  "lodging-waiting": "lodgingWaiting",
};

const resolveHotelResource = (resource) => hotelResourceMap[resource] || resource;

const sessions = new Map();
// Write-through cache for `sessions`. Persisted to sessions.json so the
// Map survives a server restart (and so horizontal scaling is one DB swap
// away instead of a rewrite). On every set/delete we serialize the whole
// Map; for ≤ a few thousand active sessions this is fine. Beyond that,
// swap writeJson for a real DB.
const SESSIONS_FILE = "sessions.json";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const loadSessions = async () => {
  let stored = [];
  try {
    stored = await readJson(SESSIONS_FILE);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.error("Failed to load sessions.json; starting empty.");
    }
    stored = [];
  }
  if (!Array.isArray(stored)) return;
  const now = Date.now();
  for (const s of stored) {
    if (s && s.sessionId && s.userId && (!s.expiresAt || s.expiresAt > now)) {
      sessions.set(s.sessionId, s.userId);
    }
  }
};

const persistSessions = () => {
  const now = Date.now();
  const payload = Array.from(sessions.entries()).map(([sid, uid]) => ({
    sessionId: sid,
    userId: uid,
    expiresAt: now + SESSION_TTL_MS,
  }));
  return writeJson(SESSIONS_FILE, payload);
};

// In-memory password-reset token store. Same volatility as `sessions` —
// tokens die on server restart. Production migration target: a DB row with
// TTL (e.g. Postgres `password_reset_tokens` table).
const resetTokens = new Map();
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// Generic rate-limit / lockout middleware. Same shape as the original
// loginAttempts pattern (sliding window + lockout on overflow) but
// reusable across login / register / password-reset.
//
// Usage:
//   const loginAttempts = new Map();
//   app.post("/api/login", rateLimit({
//     store: loginAttempts,
//     windowMs: 15 * 60 * 1000,
//     lockoutMs: 15 * 60 * 1000,
//     maxAttempts: 5,
//     keyFn: (req) => `${req.body.email}:${req.ip}`,
//     errorMessage: "Too many login attempts.",
//   }), async (req, res) => { ... });
//
// The route handler calls `req.rateLimit.recordFailure()` on a failure
// (e.g. wrong password) and `req.rateLimit.clear()` on success.
const buildRateLimiter = ({ store, windowMs, lockoutMs, maxAttempts, keyFn, errorMessage }) => {
  const prune = (entry, now) => {
    if (!entry) return null;
    if (entry.lockedUntil && entry.lockedUntil <= now) {
      return { count: 0, firstAt: now, lockedUntil: 0 };
    }
    if (entry.firstAt && now - entry.firstAt > windowMs && !entry.lockedUntil) {
      return { count: 0, firstAt: now, lockedUntil: 0 };
    }
    return entry;
  };

  return (req, res, next) => {
    const now = Date.now();
    const key = keyFn(req);
    const entry = prune(store.get(key), now);

    if (entry && entry.lockedUntil && entry.lockedUntil > now) {
      const retryAfter = Math.ceil((entry.lockedUntil - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: `${errorMessage} Try again in ${retryAfter}s.`,
        retryAfter,
      });
    }

    req.rateLimit = {
      recordFailure: () => {
        const next = entry || { count: 0, firstAt: now, lockedUntil: 0 };
        next.count = (next.count || 0) + 1;
        if (next.firstAt == null) next.firstAt = now;
        if (next.count >= maxAttempts) {
          next.lockedUntil = now + lockoutMs;
        }
        store.set(key, next);
      },
      clear: () => {
        store.delete(key);
      },
    };

    next();
  };
};
const pendingWrites = new Map();

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const getDataFilePath = (filename) => path.join(DATA_DIR, filename);
const getTempFilePath = (filename) => path.join(DATA_DIR, `${filename}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

const readJson = async (filename) => {
  const filePath = getDataFilePath(filename);
  // Read-your-writes: if there's an in-flight write to this same path, await it
  // so the read observes the latest committed state. Without this, a concurrent
  // reader can bypass a write that's mid-rename and see stale data — which
  // breaks atomic checkout (validate stock against current stock).
  await pendingWrites.get(filePath);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    if (err instanceof SyntaxError || /Unexpected token|Unexpected end of JSON input/.test(err.message)) {
      const backupPath = path.join(DATA_DIR, `${filename}.corrupt.${Date.now()}.bak`);
      await fs.copyFile(filePath, backupPath).catch(() => {});
      console.error(`Data corruption detected in ${filename}. Backed up corrupted file to ${backupPath}.`);
      const error = new Error(`Data file ${filename} is corrupted. Restore from backup ${path.basename(backupPath)}.`);
      error.status = 500;
      throw error;
    }
    throw err;
  }
};

const writeJson = async (filename, data) => {
  const filePath = getDataFilePath(filename);
  const tempFilePath = getTempFilePath(filename);
  const payload = JSON.stringify(data, null, 2);

  // Why we write to a sibling temp file then rename (and the Windows fix below):
  //   - Atomic write semantics: readers either see the previous content or the
  //     new content, never a half-written file.
  //   - On POSIX, rename() is atomic by spec — works fine.
  //   - On Windows, rename() across the same directory is *usually* atomic, but
  //     antivirus / indexer / another open handle can hold the target briefly
  //     and fail with EPERM. We've seen this spam the logs in dev.
  //
  // Strategy:
  //   1. Try temp+rename (fast path on POSIX + clean Windows).
  //   2. If rename fails with EPERM/EBUSY, fall back to a direct overwrite of
  //      the target file. Direct writes still truncate-then-write atomically
  //      enough for our single-writer-per-store scenario, and they survive
  //      Windows' handle contention where rename doesn't.
  //   3. Always clean up the temp file in finally.
  const writeOp = async () => {
    await fs.writeFile(tempFilePath, payload, "utf8");
    try {
      await fs.rename(tempFilePath, filePath);
    } catch (renameErr) {
      const code = renameErr && renameErr.code;
      const isWindowsLock =
        code === "EPERM" || code === "EBUSY" || code === "EACCES";
      if (!isWindowsLock) throw renameErr;

      // Fallback: direct overwrite. Open with 'w' to truncate, then write.
      const handle = await fs.open(filePath, "w");
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync().catch(() => {});
      } finally {
        await handle.close().catch(() => {});
      }
    }
  };

  const previous = pendingWrites.get(filePath) || Promise.resolve();
  const next = previous.finally(async () => {
    try {
      await writeOp();
    } finally {
      // Always clean up any leftover temp file regardless of outcome.
      await fs.rm(tempFilePath, { force: true }).catch(() => {});
    }
  });

  pendingWrites.set(filePath, next);
  next.finally(() => {
    if (pendingWrites.get(filePath) === next) {
      pendingWrites.delete(filePath);
    }
  });

  return next;
};

const sanitizeUser = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
};

const getUserFromSession = async (req) => {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) return null;
  const userId = sessions.get(sessionId);
  if (!userId) return null;
  const users = await readJson(resourceFiles.users);
  return users.find((u) => u.id === userId) || null;
};

const ensureAuth = async (req, res, next) => {
  const user = await getUserFromSession(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.user = user;
  next();
};

const queryToItemKey = {
  storeType: "_storeType",
  storeId: "_storeId",
  email: "_userEmail",
};

const matchesStoreScope = (item, storeType, storeId) => {
  if (String(item._storeType || item.storeType || "").trim() !== String(storeType || "").trim()) {
    return false;
  }
  if (storeId !== undefined && storeId !== null && String(storeId).trim() !== "") {
    if (item._storeId !== undefined && String(item._storeId).trim() !== String(storeId).trim()) {
      return false;
    }
    if (item.storeId !== undefined && String(item.storeId).trim() !== String(storeId).trim()) {
      return false;
    }
  }
  return true;
};

const filterByQuery = (items, query) => {
  const queryKeys = Object.keys(query).filter((key) => query[key] !== undefined && query[key] !== "");
  if (!queryKeys.length) return items;
  return items.filter((item) => {
    return queryKeys.every((key) => {
      const mappedKey = queryToItemKey[key] || key;
      const value = query[key];
      if (mappedKey === "_storeType" || mappedKey === "_storeId" || mappedKey === "_userEmail") {
        return String(item[mappedKey] || item[key] || "") === String(value);
      }
      if (typeof item[mappedKey] === "object") {
        return JSON.stringify(item[mappedKey]) === JSON.stringify(value);
      }
      return String(item[mappedKey]) === String(value);
    });
  });
};

const getRequestScope = (req) => {
  const storeType = String(req.query.storeType || req.user?.storeType || "").trim();
  const storeId = req.query.storeId !== undefined && req.query.storeId !== null
    ? String(req.query.storeId).trim() || storeType
    : String(req.user?.storeId || req.user?.storeType || "").trim();
  const email = String(req.query.email || req.user?.email || "").trim();
  return { storeType, storeId, email };
};

const isScopedStoreSettingsData = (data) => {
  return data && typeof data === "object" && !Array.isArray(data) && Object.keys(data).some((key) => key.startsWith("store-settings:"));
};

const getStoreSettingsScopeKey = (req) => {
  const { storeType, storeId } = getRequestScope(req);
  const keyType = storeType || req.user?.storeType || "system";
  const keyId = storeId || keyType || "global";
  return `store-settings:${keyType}:${keyId}`;
};

const getCookieOptions = () => ({
  httpOnly: true,
  sameSite: "none",
  // SameSite=None cookies must also be Secure in modern browsers.
  // Localhost is treated as a secure context in most browsers, so this works for local dev.
  secure: true,
  maxAge: 1000 * 60 * 60 * 24,
  path: "/",
  sameParty: false,
});

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      return callback(new Error(`CORS origin denied: ${origin}`));
    },
    credentials: true,
  })
);
app.options("*", cors({
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS origin denied: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// CSRF protection — double-submit cookie pattern. On login the server sets
// an `XSRF-TOKEN` cookie (NOT HttpOnly so JS can read it). The frontend
// echoes the cookie value in an `X-CSRF-Token` header on every non-GET
// request. A cross-site attacker can't read the cookie, so they can't
// produce the header. Public endpoints (login/register/password-reset) are
// exempt because they don't yet have an authenticated session to protect.
//
// Trade-off: assumes frontend + backend share the same host (different
// ports OK). For multi-domain deployments the cookie's Domain attribute
// must be set to the parent domain — tracked as a follow-up.
const CSRF_PUBLIC_PATHS = new Set([
  "/api/login",
  "/api/register",
  "/api/register/available",
  "/api/password-reset/request",
  "/api/password-reset/confirm",
]);

const csrfProtection = (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return next();
  }
  if (CSRF_PUBLIC_PATHS.has(req.path)) {
    return next();
  }
  const cookieToken = req.cookies && req.cookies["XSRF-TOKEN"];
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: "CSRF token mismatch" });
  }
  next();
};

app.use(csrfProtection);

// Per-endpoint rate-limit stores. Each gets its own Map so a flood on one
// endpoint doesn't impact another.
const loginAttempts = new Map();
const registerAttempts = new Map();
const resetRequestAttempts = new Map();

const loginLimiter = buildRateLimiter({
  store: loginAttempts,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
  maxAttempts: 5,
  keyFn: (req) => `${String(req.body?.email || "").trim().toLowerCase()}:${req.ip}`,
  errorMessage: "Too many login attempts.",
});

const registerLimiter = buildRateLimiter({
  store: registerAttempts,
  windowMs: 60 * 60 * 1000,
  lockoutMs: 60 * 60 * 1000,
  maxAttempts: 10,
  keyFn: (req) => `register:${req.ip}`,
  errorMessage: "Too many registration attempts.",
});

const resetRequestLimiter = buildRateLimiter({
  store: resetRequestAttempts,
  windowMs: 60 * 60 * 1000,
  lockoutMs: 60 * 60 * 1000,
  maxAttempts: 5,
  keyFn: (req) => `reset:${req.ip}`,
  errorMessage: "Too many password reset requests.",
});

app.post("/api/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const user = await usersQueries.findByEmailWithPassword(email);
  if (!user) {
    req.rateLimit.recordFailure();
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const matches = bcrypt.compareSync(password, user.password || "");
  if (!matches) {
    req.rateLimit.recordFailure();
    return res.status(401).json({ error: "Invalid email or password" });
  }

  if (!user.approved) {
    return res.status(403).json({ error: "Account not approved" });
  }

  // Successful login — clear any accumulated attempts for this key.
  req.rateLimit.clear();

  const sessionId = crypto.randomBytes(24).toString("hex");
  sessions.set(sessionId, user.id);
  await persistSessions();
  res.cookie("sessionId", sessionId, getCookieOptions());
  // XSRF token cookie: same lifetime/flags as the session cookie but JS-
  // readable (not HttpOnly). The frontend echoes it as the X-CSRF-Token
  // header on every non-GET request. Cross-site attackers can't read it.
  const csrfToken = crypto.randomBytes(24).toString("hex");
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    sameSite: "none",
    secure: true,
    maxAge: 1000 * 60 * 60 * 24,
    path: "/",
  });
  res.json(sanitizeUser(user));
});

app.post("/api/logout", async (req, res) => {
  if (req.cookies.sessionId) {
    sessions.delete(req.cookies.sessionId);
    try {
      await persistSessions();
    } catch (err) {
      console.warn("Failed to persist sessions after logout:", err.message);
    }
  }
  res.clearCookie("sessionId", { path: "/" });
  res.json({ ok: true });
});

app.get("/api/auth/user", ensureAuth, async (req, res) => {
  res.json(sanitizeUser(req.user));
});

app.get("/api/register/available", async (req, res) => {
  const totalUsers = await usersQueries.count();
  const available = totalUsers === 0;
  res.json({ available, isFirstUser: available });
});

app.post("/api/register", registerLimiter, async (req, res) => {
  // Every register attempt counts toward the lockout, regardless of outcome.
  // A misbehaving client spamming random emails still consumes its quota.
  req.rateLimit.recordFailure();

  const { email, password, ...rest } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  const totalUsers = await usersQueries.count();
  const isFirstUser = totalUsers === 0;

  if (await usersQueries.existsByEmail(email)) {
    return res.status(400).json({ error: "Email already exists" });
  }

  const hashed = bcrypt.hashSync(password, 10);

  const created = await usersQueries.create({
    email,
    passwordHash: hashed,
    role: isFirstUser ? "SUPER_OWNER" : rest.role || "STORE_ADMIN",
    storeType: isFirstUser ? "system" : String(rest.storeType || "retail"),
    storeId: isFirstUser ? null : rest.storeId || rest.storeType || null,
    approved: true,
    status: "approved",
    name: rest.name || null,
    phone: rest.phone || null,
    address: rest.address || null,
  });

  if (!created) {
    // UNIQUE constraint race (two concurrent registers). Treat as duplicate.
    return res.status(400).json({ error: "Email already exists" });
  }

  res.json(sanitizeUser(created));
});

const ROLE_MANAGEMENT = {
  SUPER_OWNER: ["SUPER_OWNER", "ADMIN", "STORE_ADMIN", "CASHIER"],
  ADMIN: ["STORE_ADMIN", "CASHIER"],
  STORE_ADMIN: ["CASHIER"],
};

const sanitizeUsers = (users) => users.map(sanitizeUser);

const canManageRole = (currentRole, targetRole) => {
  if (!currentRole || !targetRole) return false;
  return ROLE_MANAGEMENT[currentRole]?.includes(targetRole) || false;
};

const getOwnershipFields = (currentUser) => {
  if (!currentUser) return {};
  const rootOwnerEmail = currentUser.role === "SUPER_OWNER" ? currentUser.email : currentUser.rootOwnerEmail || currentUser.email;
  const ownerEmail = currentUser.role === "SUPER_OWNER" ? currentUser.email : currentUser.email;
  return { ownerEmail, rootOwnerEmail };
};

app.get("/api/users", ensureAuth, async (req, res) => {
  const users = await readJson(resourceFiles.users);
  let filteredUsers = users;

  if (req.user.role === "SUPER_OWNER") {
    filteredUsers = users;
  } else {
    filteredUsers = users.filter((user) => {
      return (
        String(user.storeType) === String(req.user.storeType) &&
        String(user.storeId) === String(req.user.storeId)
      );
    });
  }

  return res.json(sanitizeUsers(filteredUsers));
});

app.post("/api/users", ensureAuth, async (req, res) => {
  const currentUser = req.user;
  let { email, password, role, storeType, storeId, approved = false, ...rest } = req.body || {};

  if (!email || !password || !role) {
    return res.status(400).json({ error: "Email, password, and role are required" });
  }

  if (!canManageRole(currentUser.role, role)) {
    return res.status(403).json({ error: "Insufficient permissions to create this role" });
  }

  if (currentUser.role !== "SUPER_OWNER") {
    storeType = currentUser.storeType;
    storeId = currentUser.storeId;
  }

  if (role !== "SUPER_OWNER" && !storeType) {
    return res.status(400).json({ error: "Store type is required for non-super-owner users" });
  }

  if (role !== "SUPER_OWNER" && !storeId) {
    return res.status(400).json({ error: "Store ID is required for non-super-owner users" });
  }

  const users = await readJson(resourceFiles.users);
  if (users.some((u) => String(u.email).toLowerCase() === String(email).toLowerCase())) {
    return res.status(400).json({ error: "Email already exists" });
  }

  const now = new Date().toISOString();
  const hashed = bcrypt.hashSync(password, 10);
  const ownership = getOwnershipFields(currentUser);

  const status = approved ? "approved" : "pending";

  const newUser = {
    id: Date.now(),
    email: String(email).toLowerCase(),
    password: hashed,
    role,
    storeType: role === "SUPER_OWNER" ? "system" : String(storeType),
    storeId: role === "SUPER_OWNER" ? null : String(storeId),
    approved,
    status,
    createdAt: now,
    updatedAt: now,
    ...ownership,
    ...rest,
  };

  users.push(newUser);
  await writeJson(resourceFiles.users, users);
  return res.json(sanitizeUser(newUser));
});

app.put("/api/users/:id", ensureAuth, async (req, res) => {
  const currentUser = req.user;
  const { id } = req.params;
  const updates = req.body || {};
  const users = await readJson(resourceFiles.users);
  const index = users.findIndex((user) => String(user.id) === String(id));

  if (index === -1) {
    return res.status(404).json({ error: "User not found" });
  }

  const targetUser = users[index];
  if (!canManageRole(currentUser.role, targetUser.role) && currentUser.role !== "SUPER_OWNER") {
    return res.status(403).json({ error: "Insufficient permissions to update this user" });
  }

  if (updates.email && updates.email !== targetUser.email) {
    if (users.some((u) => String(u.email).toLowerCase() === String(updates.email).toLowerCase() && String(u.id) !== String(id))) {
      return res.status(400).json({ error: "Email already exists" });
    }
  }

  if (updates.password) {
    updates.password = bcrypt.hashSync(updates.password, 10);
  }

  users[index] = {
    ...targetUser,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  await writeJson(resourceFiles.users, users);
  return res.json(sanitizeUser(users[index]));
});

app.delete("/api/users/:id", ensureAuth, async (req, res) => {
  const currentUser = req.user;
  const { id } = req.params;
  const users = await readJson(resourceFiles.users);
  const targetUser = users.find((user) => String(user.id) === String(id));

  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!canManageRole(currentUser.role, targetUser.role) && currentUser.role !== "SUPER_OWNER") {
    return res.status(403).json({ error: "Insufficient permissions to delete this user" });
  }

  const nextUsers = users.filter((user) => String(user.id) !== String(id));
  await writeJson(resourceFiles.users, nextUsers);
  return res.json({ ok: true });
});

app.post("/api/password-reset/request", resetRequestLimiter, async (req, res) => {
  // Every reset-request attempt counts toward the lockout — there's no
  // "success/failure" distinction from the request side (the response is
  // always generic to prevent enumeration), so we record unconditionally.
  req.rateLimit.recordFailure();

  const { email } = req.body || {};
  const normalized = String(email || "").trim().toLowerCase();
  // Always return success regardless of whether the email exists, to prevent
  // account enumeration. The devToken field is only included when the email
  // matches an existing user; in production this would be sent via SMTP
  // instead of echoed in the response.
  const generic = {
    ok: true,
    message: "If that email exists, a reset link has been sent.",
  };

  if (!normalized) return res.json(generic);

  const users = await readJson(resourceFiles.users);
  const user = users.find((u) => String(u.email).toLowerCase() === normalized);
  if (!user) return res.json(generic);

  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + PASSWORD_RESET_TTL_MS;
  resetTokens.set(token, { email: normalized, expiresAt });

  // Log so a developer reading server output can grab the token without
  // needing to inspect the response. Production: send via SMTP instead.
  console.log(`[password-reset] token for ${normalized}: ${token} (expires ${new Date(expiresAt).toISOString()})`);

  // Only echo the token back in the response in dev mode. In production
  // this is omitted so an attacker can't enumerate registered emails by
  // checking for the field's presence.
  const isDev = process.env.NODE_ENV !== "production";
  res.json(isDev ? { ...generic, devToken: token } : generic);
});

app.post("/api/password-reset/confirm", async (req, res) => {
  const { email, token, newPassword } = req.body || {};
  const normalized = String(email || "").trim().toLowerCase();
  const trimmedToken = String(token || "").trim();

  if (!normalized || !trimmedToken || !newPassword) {
    return res.status(400).json({ error: "Email, token, and new password are required" });
  }

  // Minimal password policy — matches the frontend regex (Login.jsx).
  // Keeping this on the server is essential: the client can be bypassed.
  if (!/^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[@$!%*?#&]).{8,}$/.test(newPassword)) {
    return res.status(400).json({
      error:
        "Password must be at least 8 characters and include uppercase, lowercase, a digit, and a special character.",
    });
  }

  const entry = resetTokens.get(trimmedToken);
  if (!entry) {
    return res.status(400).json({ error: "Invalid or already-used reset token" });
  }
  if (Date.now() > entry.expiresAt) {
    resetTokens.delete(trimmedToken);
    return res.status(400).json({ error: "Reset token has expired" });
  }
  if (entry.email !== normalized) {
    // Token was issued for a different email — treat as invalid.
    return res.status(400).json({ error: "Token does not match the supplied email" });
  }

  const users = await readJson(resourceFiles.users);
  const index = users.findIndex((u) => String(u.email).toLowerCase() === normalized);
  if (index === -1) {
    // Edge case: user was deleted between request and confirm.
    resetTokens.delete(trimmedToken);
    return res.status(404).json({ error: "User no longer exists" });
  }

  users[index] = {
    ...users[index],
    password: bcrypt.hashSync(newPassword, 10),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(resourceFiles.users, users);

  // Single-use: invalidate the token immediately so a leaked token can't be
  // replayed after a successful reset.
  resetTokens.delete(trimmedToken);

  res.json({ ok: true, message: "Password has been reset. Please log in." });
});

app.get("/api/store-settings", ensureAuth, async (req, res) => {
  const settings = await readJson(resourceFiles["store-settings"]);
  if (isScopedStoreSettingsData(settings)) {
    const scopeKey = getStoreSettingsScopeKey(req);
    return res.json(settings[scopeKey] || settings.global || {});
  }
  res.json(settings);
});

app.post("/api/store-settings", ensureAuth, async (req, res) => {
  const payload = req.body || {};
  const existing = await readJson(resourceFiles["store-settings"]);
  const scopeKey = getStoreSettingsScopeKey(req);
  const hasScopeFromQuery = Boolean(req.query.storeType || req.query.storeId);

  if (isScopedStoreSettingsData(existing)) {
    const next = { ...existing, [scopeKey]: payload };
    await writeJson(resourceFiles["store-settings"], next);
    return res.json(payload);
  }

  if (hasScopeFromQuery) {
    const next = { global: existing, [scopeKey]: payload };
    await writeJson(resourceFiles["store-settings"], next);
    return res.json(payload);
  }

  await writeJson(resourceFiles["store-settings"], payload);
  res.json(payload);
});

app.get("/api/hotel/checkout-history", ensureAuth, (req, res) => {
  res.json(hotelStore.checkoutHistory);
});

app.get("/api/hotel/dining-bills", ensureAuth, (req, res) => {
  res.json(hotelStore.diningBills);
});

app.get("/api/hotel/:resource", ensureAuth, (req, res) => {
  const resource = resolveHotelResource(req.params.resource);
  if (!Object.prototype.hasOwnProperty.call(hotelStore, resource)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(hotelStore[resource]);
});

app.post("/api/hotel/:resource", ensureAuth, async (req, res) => {
  const resource = resolveHotelResource(req.params.resource);
  if (!Object.prototype.hasOwnProperty.call(hotelStore, resource)) {
    return res.status(404).json({ error: "Not found" });
  }
  const item = { id: Date.now(), ...req.body };
  hotelStore[resource].push(item);
  await persistHotelStore();
  res.json(item);
});

app.delete("/api/hotel/checkout-history", ensureAuth, async (req, res) => {
  hotelStore.checkoutHistory = [];
  await persistHotelStore();
  res.json({ ok: true });
});

app.delete("/api/hotel/:resource/:id", ensureAuth, async (req, res) => {
  const resource = resolveHotelResource(req.params.resource);
  if (!Object.prototype.hasOwnProperty.call(hotelStore, resource)) {
    return res.status(404).json({ error: "Not found" });
  }
  hotelStore[resource] = hotelStore[resource].filter((item) => String(item.id) !== String(req.params.id));
  await persistHotelStore();
  res.json({ ok: true });
});

app.put("/api/hotel/dining-bills/:tableId", ensureAuth, async (req, res) => {
  const { tableId } = req.params;
  const payload = req.body || {};
  const existing = hotelStore.diningBills.find((item) => String(item.id) === String(tableId));
  if (existing) {
    Object.assign(existing, payload);
    await persistHotelStore();
    return res.json(existing);
  }
  const item = { id: tableId, ...payload };
  hotelStore.diningBills.push(item);
  await persistHotelStore();
  res.json(item);
});

app.delete("/api/hotel/dining-bills/:tableId", ensureAuth, async (req, res) => {
  const { tableId } = req.params;
  hotelStore.diningBills = hotelStore.diningBills.filter((item) => String(item.id) !== String(tableId));
  await persistHotelStore();
  res.json({ ok: true });
});

app.get("/api/invoices/:invoiceNo", ensureAuth, async (req, res) => {
  const invoices = await readJson(resourceFiles.invoices);
  const invoice = invoices.find((item) => String(item.invoiceNo) === String(req.params.invoiceNo));
  if (!invoice) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(invoice);
});

// POST /api/invoices/checkout
// Atomically validates and decrements stock for every line item in the
// invoice, then persists the invoice. This replaces the client-side approach
// of firing N parallel PUT /api/products/:id calls per cart mutation, which
// was race-prone across concurrent cashiers.
//
// Flow:
//   1. readJson(products) chains on pendingWrites (see readJson) so we see
//      the latest committed stock.
//   2. Validate stock per line item. Any failure → 409 with no writes.
//   3. writeJson(products, decremented) — chained behind any in-flight write.
//   4. writeJson(invoices, [...existing, newInvoice]).
//
// Failure modes:
//   - 409 insufficient stock → nothing mutated.
//   - 500 between steps 3 and 4 → stock decremented but invoice not saved.
//     The reverse order (invoice first, products second) would be worse: a
//     customer is charged for an item that wasn't actually deducted.
const resolveCheckoutQuantity = (item) => {
  const unit = String(item.unit || "").toLowerCase();
  if (unit === "kg") {
    return Number(item.qtyKg) || 0;
  }
  return Number(item.qty) || 0;
};

// Server-authoritative discount validation. The client computes its own
// totals using its own copy of the line items + discounts, but the server
// refuses to persist any discount that obviously makes no sense. This
// closes the most blatant abuse (negative prices, percentages above 100%)
// without forcing full server-side totals recomputation — that's a
// follow-up. A misbehaving client can still tweak totals in flight, but
// it can't crash the math.
const validateDiscount = (discount, label) => {
  if (!discount) return null;
  if (typeof discount !== "object") return `${label}: must be an object`;
  const v = Number(discount.value);
  if (!Number.isFinite(v)) return `${label}: value must be a number`;
  if (v < 0) return `${label}: value cannot be negative`;
  if (discount.type === "percent" && v > 100) return `${label}: percentage cannot exceed 100`;
  if (discount.type !== "percent" && discount.type !== "flat") {
    return `${label}: type must be "percent" or "flat"`;
  }
  return null;
};

app.post("/api/invoices/checkout", ensureAuth, async (req, res) => {
  const invoice = req.body || {};
  const items = Array.isArray(invoice.items) ? invoice.items : [];

  if (items.length === 0) {
    return res.status(400).json({ error: "Invoice has no line items" });
  }
  if (!invoice.invoiceNo) {
    return res.status(400).json({ error: "invoiceNo is required" });
  }

  // Validate bill-level + per-line discounts up-front. No writes happen
  // here, so failing is cheap.
  const billDiscErr = validateDiscount(invoice.discount, "Bill discount");
  if (billDiscErr) return res.status(400).json({ error: billDiscErr });
  const lineDiscs = Array.isArray(invoice.discountBreakdown?.line)
    ? invoice.discountBreakdown.line
    : [];
  for (const ld of lineDiscs) {
    const err = validateDiscount(ld.discount, `Line discount on ${ld.productName || ld.productId || "item"}`);
    if (err) return res.status(400).json({ error: err });
  }

  const scope = getRequestScope(req);
  try {
    const result = await invoicesQueries.createWithStockDecrement(
      invoice,
      resolveCheckoutQuantity,
      scope
    );
    return res.status(201).json(result);
  } catch (err) {
    // Map domain errors thrown by the queries module to HTTP responses.
    // Anything else is a 500 (handled by the global error handler below).
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message,
      productId: err.productId,
      productName: err.productName,
      requested: err.requested,
      available: err.available,
    });
  }
});

app.get("/api/:resource", ensureAuth, async (req, res) => {
  const { resource } = req.params;
  // MySQL-backed resources short-circuit here. Everything else still goes
  // through the JSON path. Add new MySQL resources by extending this block.
  if (resource === "products") {
    const scope = getRequestScope(req);
    const items = await productsQueries.list(scope, req.query);
    return res.json(items);
  }
  const filename = resourceFiles[resource];
  if (!filename) {
    return res.status(404).json({ error: "Not found" });
  }
  const items = await readJson(filename);
  res.json(filterByQuery(items, req.query));
});

app.post("/api/:resource", ensureAuth, async (req, res) => {
  const { resource } = req.params;
  if (resource === "products") {
    const scope = getRequestScope(req);
    const created = await productsQueries.create(req.body || {}, scope);
    return res.json(created);
  }
  const filename = resourceFiles[resource];
  if (!filename) {
    return res.status(404).json({ error: "Not found" });
  }
  const items = await readJson(filename);
  const now = new Date().toISOString();
  const { storeType, storeId, email } = getRequestScope(req);
  const item = {
    id: Date.now(),
    createdAt: now,
    updatedAt: now,
    ...req.body,
  };
  if (storeType) item._storeType = storeType;
  if (storeId) item._storeId = storeId;
  if (email) item._userEmail = email;
  items.push(item);
  await writeJson(filename, items);
  res.json(item);
});

app.put("/api/:resource/:id", ensureAuth, async (req, res) => {
  const { resource, id } = req.params;
  if (resource === "products") {
    const scope = getRequestScope(req);
    const existing = await productsQueries.findByIdScoped(id, scope);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const updated = await productsQueries.update(id, req.body || {});
    return res.json(updated);
  }
  const filename = resourceFiles[resource];
  if (!filename) {
    return res.status(404).json({ error: "Not found" });
  }
  const items = await readJson(filename);
  const { storeType, storeId, email } = getRequestScope(req);
  const index = items.findIndex((item) => {
    if (String(item.id) !== String(id)) return false;
    if (!matchesStoreScope(item, storeType, storeId)) return false;
    if (email && String(item._userEmail || item.email || "") !== String(email)) return false;
    return true;
  });
  if (index === -1) {
    return res.status(404).json({ error: "Not found" });
  }
  items[index] = {
    ...items[index],
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(filename, items);
  res.json(items[index]);
});

app.delete("/api/:resource/:id", ensureAuth, async (req, res) => {
  const { resource, id } = req.params;
  if (resource === "products") {
    const scope = getRequestScope(req);
    const existing = await productsQueries.findByIdScoped(id, scope);
    if (!existing) return res.status(404).json({ error: "Not found" });
    const deleted = await productsQueries.deleteById(id);
    return res.json({ ok: deleted });
  }
  const filename = resourceFiles[resource];
  if (!filename) {
    return res.status(404).json({ error: "Not found" });
  }
  const { storeType, storeId, email } = getRequestScope(req);
  const items = await readJson(filename);
  const nextItems = items.filter((item) => {
    if (String(item.id) !== String(id)) return true;
    if (!matchesStoreScope(item, storeType, storeId)) return true;
    if (email && String(item._userEmail || item.email || "") !== String(email)) return true;
    return false;
  });
  await writeJson(filename, nextItems);
  res.json({ ok: true });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled backend error:", err);
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || 500;
  res.status(status).json({ error: err.message || "Internal Server Error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

const startServer = async () => {
  await loadSessions();
  await loadHotelStore();
  app.listen(PORT, () => {
    console.log(`Backend scaffold listening on http://localhost:${PORT}`);
    console.log(`Frontend origin allowed: ${FRONTEND_ORIGIN}`);
    console.log("Sessions loaded from disk.");
    console.log("Hotel state loaded from disk.");
  });
};

startServer().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
