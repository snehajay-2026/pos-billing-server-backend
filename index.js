
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
const servicesQueries = require("./db/queries/services");
const expensesQueries = require("./db/queries/expenses");
const ordersQueries = require("./db/queries/orders");
const customersQueries = require("./db/queries/customers");
const customerCreditsQueries = require("./db/queries/customer-credits");
const notificationsQueries = require("./db/queries/notifications");
const storeSettingsQueries = require("./db/queries/store-settings");
const hotelQueries = require("./db/queries/hotel");
const hotelBookingsQueries = require("./db/queries/hotel-bookings");
const realtimeHub = require("./realtime/hub");
const sseHandler = require("./realtime/sse");
const sessionsQueries = require("./db/queries/sessions");
const shiftsQueries = require("./db/queries/shifts");
const hotelModuleLocksQueries = require("./db/queries/hotel-module-locks");
const paymentsQueries = require("./db/queries/payments");
const reportsQueries = require("./db/queries/reports");
const inventoryQueries = require("./db/queries/inventory");
const laundryQueries = require("./db/queries/laundry");
const auditLogQueries = require("./db/queries/audit-log");
const { sanitizePublicInvoice, getPublicStoreChrome } = require("./lib/publicInvoice");

// Map of MySQL-backed resources to their query modules. The handlers
// below check this map and short-circuit to the queries module if found.
// Everything else still falls through to the JSON path.
const mysqlResources = {
  products: productsQueries,
  services: servicesQueries,
  expenses: expensesQueries,
  orders: ordersQueries,
  invoices: invoicesQueries,
  customers: customersQueries,
  "customer-credits": customerCreditsQueries,
  notifications: notificationsQueries,
};

const app = express();
const PORT = process.env.PORT || 4000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

const isAllowedOrigin = (origin) => {
  if (!origin) return false;

  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname;
    const protocol = parsed.protocol;

    if (origin === FRONTEND_ORIGIN) {
      return true;
    }

    // Allow origins that match FRONTEND_ORIGIN after normalization. The
    // env var on Render was set without the https:// prefix once and the
    // browser sends it with the protocol — comparing parsed (protocol,
    // hostname) handles both forms.
    if (FRONTEND_ORIGIN) {
      // FRONTEND_ORIGIN may be set with or without a scheme ("example.com"
      // vs "https://example.com"). Normalize to a hostname for comparison.
      const envValue = String(FRONTEND_ORIGIN).trim();
      const envHostname = envValue.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      if (envHostname && hostname === envHostname) {
        return true;
      }
    }

    if ((hostname === "localhost" || hostname === "127.0.0.1") && (protocol === "http:" || protocol === "https:")) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
};

const hotelResourceMap = {
  "checkout-history": "checkoutHistory",
  "dining-bills": "diningBills",
  tables: "tables",
  waiting: "waiting",
  "dining-waiting": "diningWaiting",
  "lodging-waiting": "lodgingWaiting",
};

const resolveHotelResource = (resource) => hotelResourceMap[resource] || resource;

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

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const sanitizeUser = (user) => {
  if (!user) return null;
  const { password, ...rest } = user;
  return rest;
};

const getUserFromSession = async (req) => {
  const sessionId = req.cookies.sessionId;
  if (!sessionId) return null;
  const userId = await sessionsQueries.get(sessionId);
  if (!userId) return null;
  return usersQueries.findById(userId);
};

const ensureAuth = async (req, res, next) => {
  const user = await getUserFromSession(req);
  if (!user) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  req.user = user;
  next();
};

const getRequestScope = (req) => {
  // SUPER_OWNER is unscoped: they see data across all stores. The query-
  // string storeType/storeId overrides win for explicit filtering.
  if (req.user?.role === "SUPER_OWNER" && !req.query.storeType) {
    return { storeType: null, storeId: null, email: null };
  }
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
  // 30 days — long enough that Safari's ITP doesn't drop the cookie
  // during typical idle sessions (which has a hard 7-day cap for
  // cross-site cookies without explicit user interaction). The server
  // is the source of truth for session expiry (sessions table); this
  // is just the browser-side retention.
  maxAge: 1000 * 60 * 60 * 24 * 30,
  path: "/",
  sameParty: false,
  // Priority=High hint asks the browser to retain the cookie in memory
  // rather than evict it under storage pressure. Chrome supports this
  // natively; Safari ignores unknown priority attributes (harmless).
  priority: "high",
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
  await sessionsQueries.put(sessionId, user.id);
  res.cookie("sessionId", sessionId, getCookieOptions());
  // XSRF token cookie: same lifetime/flags as the session cookie but JS-
  // readable (not HttpOnly). The frontend echoes it as the X-CSRF-Token
  // header on every non-GET request. Cross-site attackers can't read it.
  const csrfToken = crypto.randomBytes(24).toString("hex");
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    sameSite: "none",
    secure: true,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: "/",
  });
  res.json({ ...sanitizeUser(user), csrfToken });
});

app.post("/api/logout", async (req, res) => {
  if (req.cookies.sessionId) {
    try {
      await sessionsQueries.remove(req.cookies.sessionId);
    } catch (err) {
      console.warn("Failed to remove session after logout:", err.message);
    }
  }
  res.clearCookie("sessionId", { path: "/" });
  res.json({ ok: true });
});

// Render health check — the platform probes GET / and marks a deploy as
// "Failed" if it returns anything but 200.
app.get("/", (req, res) => {
  res.json({ ok: true, service: "pos-billing-backend" });
});

app.get("/api/auth/user", ensureAuth, async (req, res) => {
  // Echo a freshly-minted CSRF token on every session re-validation so
  // tabs that boot from the session cookie (without going through the
  // /api/login flow) still have a valid token to echo back. The cookie
  // is also refreshed so subsequent POSTs see a matching pair.
  const csrfToken = crypto.randomBytes(24).toString("hex");
  res.cookie("XSRF-TOKEN", csrfToken, {
    httpOnly: false,
    sameSite: "none",
    secure: true,
    maxAge: 1000 * 60 * 60 * 24 * 30,
    path: "/",
  });
  res.json({ ...sanitizeUser(req.user), csrfToken });
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
  if (req.user.role === "SUPER_OWNER") {
    return res.json(sanitizeUsers(await usersQueries.listAll()));
  }
  return res.json(
    sanitizeUsers(await usersQueries.listByStore(req.user.storeType, req.user.storeId))
  );
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

  if (await usersQueries.existsByEmail(email)) {
    return res.status(400).json({ error: "Email already exists" });
  }

  const hashed = bcrypt.hashSync(password, 10);
  const ownership = getOwnershipFields(currentUser);
  const status = approved ? "approved" : "pending";

  const created = await usersQueries.create({
    email,
    passwordHash: hashed,
    role,
    storeType: role === "SUPER_OWNER" ? "system" : String(storeType),
    storeId: role === "SUPER_OWNER" ? null : String(storeId),
    approved,
    status,
    ownerEmail: ownership.ownerEmail,
    rootOwnerEmail: ownership.rootOwnerEmail,
    name: rest.name,
    phone: rest.phone,
    address: rest.address,
  });

  if (!created) {
    // UNIQUE-constraint race
    return res.status(400).json({ error: "Email already exists" });
  }
  return res.json(sanitizeUser(created));
});

app.put("/api/users/:id", ensureAuth, async (req, res) => {
  const currentUser = req.user;
  const { id } = req.params;
  const updates = req.body || {};

  const targetUser = await usersQueries.findById(id);
  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!canManageRole(currentUser.role, targetUser.role) && currentUser.role !== "SUPER_OWNER") {
    return res.status(403).json({ error: "Insufficient permissions to update this user" });
  }

  if (updates.email && updates.email !== targetUser.email) {
    if (await usersQueries.existsByEmail(updates.email)) {
      return res.status(400).json({ error: "Email already exists" });
    }
  }

  // Map camelCase → snake_case for the queries module.
  const patch = {};
  if (updates.email) patch.email = String(updates.email).toLowerCase();
  if (updates.role) patch.role = updates.role;
  if (updates.storeType !== undefined) patch.store_type = updates.storeType;
  if (updates.storeId !== undefined) patch.store_id = updates.storeId;
  if (updates.ownerEmail !== undefined) patch.owner_email = updates.ownerEmail;
  if (updates.rootOwnerEmail !== undefined) patch.root_owner_email = updates.rootOwnerEmail;
  if (updates.approved !== undefined) patch.approved = !!updates.approved;
  if (updates.status) patch.status = updates.status;
  if (updates.name !== undefined) patch.name = updates.name;
  if (updates.phone !== undefined) patch.phone = updates.phone;
  if (updates.address !== undefined) patch.address = updates.address;
  if (updates.password) patch.password = bcrypt.hashSync(updates.password, 10);

  const updated = await usersQueries.update(id, patch);
  return res.json(sanitizeUser(updated));
});

app.delete("/api/users/:id", ensureAuth, async (req, res) => {
  const currentUser = req.user;
  const { id } = req.params;
  const targetUser = await usersQueries.findById(id);

  if (!targetUser) {
    return res.status(404).json({ error: "User not found" });
  }

  if (!canManageRole(currentUser.role, targetUser.role) && currentUser.role !== "SUPER_OWNER") {
    return res.status(403).json({ error: "Insufficient permissions to delete this user" });
  }

  await usersQueries.deleteById(id);
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

  // Existence check via MySQL — existence is all we need here; the token
  // is the only thing this endpoint hands out.
  const user = await usersQueries.findByEmailWithPassword(normalized);
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

  // Verify the user still exists, then update the password via MySQL.
  const user = await usersQueries.findByEmailWithPassword(normalized);
  if (!user) {
    // Edge case: user was deleted between request and confirm.
    resetTokens.delete(trimmedToken);
    return res.status(404).json({ error: "User no longer exists" });
  }
  await usersQueries.update(user.id, {
    password: bcrypt.hashSync(newPassword, 10),
  });

  // Single-use: invalidate the token immediately so a leaked token can't be
  // replayed after a successful reset.
  resetTokens.delete(trimmedToken);

  res.json({ ok: true, message: "Password has been reset. Please log in." });
});

app.get("/api/store-settings", ensureAuth, async (req, res) => {
  const scopeKey = getStoreSettingsScopeKey(req);
  // Try the requested scope first, then fall back to 'global' so the
  // first GET after a fresh install returns an empty object instead of
  // a 404-shaped response.
  const payload =
    (await storeSettingsQueries.getPayloadByScopeKey(scopeKey)) ??
    (await storeSettingsQueries.getPayloadByScopeKey("global")) ??
    {};
  res.json(payload);
});

app.post("/api/store-settings", ensureAuth, async (req, res) => {
  const payload = req.body || {};
  const scopeKey = getStoreSettingsScopeKey(req);
  const { storeType, storeId } = getRequestScope(req);
  const scopeType = scopeKey === "global" ? "global" : "store";
  const saved = await storeSettingsQueries.upsert({
    scopeKey,
    scopeType,
    storeType,
    storeId,
    payload,
  });
  res.json(saved ?? {});
});

app.get("/api/hotel/checkout-history", ensureAuth, async (req, res) => {
  res.json(await hotelQueries.getSlice("checkout-history"));
});

app.get("/api/hotel/dining-bills", ensureAuth, async (req, res) => {
  res.json(await hotelQueries.getSlice("dining-bills"));
});

// Hotel module-locks — must be registered BEFORE /api/hotel/:resource so
// Express doesn't route module-locks to the catch-all.
app.get("/api/hotel/module-locks", ensureAuth, async (req, res) => {
  if (req.user?.role !== "SUPER_OWNER") {
    return res.status(403).json({ error: "Only Super Owner can list all hotel module locks" });
  }
  res.json(await hotelModuleLocksQueries.listAll());
});

app.get("/api/hotel/module-locks/me", ensureAuth, async (req, res) => {
  res.json(await hotelModuleLocksQueries.getMyLocks(req.user.email));
});

app.put("/api/hotel/module-locks/:customerEmail/:module", ensureAuth, async (req, res) => {
  if (req.user?.role !== "SUPER_OWNER") {
    return res.status(403).json({ error: "Only Super Owner can flip hotel module locks" });
  }
  const { customerEmail, module } = req.params;
  const { locked } = req.body || {};
  if (typeof locked !== "boolean") {
    return res.status(400).json({ error: "Body must be {locked: true|false}" });
  }
  const updated = await hotelModuleLocksQueries.setLock(
    decodeURIComponent(customerEmail),
    module,
    locked,
    req.user.email
  );
  if (!updated) {
    return res.status(400).json({
      error: "Invalid module (must be lodging|dining|liveBill) or missing customerEmail",
    });
  }
  res.json(updated);
});

// === Hotel bookings (per-store, per-room-or-table) =========================
// Replaces the JSON-blob approach in hotel_state.tables. Each row is a
// real booking with proper store scoping so two devices logging into
// the same store see the same reservations.
//
// Routes are registered BEFORE /api/hotel/:resource catch-all so they
// don't fall through.

app.get("/api/hotel/bookings", ensureAuth, async (req, res) => {
  const bookings = await hotelBookingsQueries.listByStore({
    storeType: req.query.storeType,
    storeId: req.query.storeId,
    kind: req.query.kind,
    status: req.query.status,
  });
  res.json(bookings);
});

app.post("/api/hotel/bookings", ensureAuth, async (req, res) => {
  const body = req.body || {};
  if (!["dining", "lodging"].includes(String(body.kind))) {
    return res.status(400).json({ error: "kind must be 'dining' or 'lodging'" });
  }
  // scope comes from query params (frontend sends storeType + storeId on
  // every booking API call); fall back to the requesting user's store.
  const scope = {
    storeType: req.query.storeType || req.user?.storeType || "hotel",
    storeId: req.query.storeId || req.user?.storeId || "hotel",
  };
  const booking = await hotelBookingsQueries.upsert(
    {
      ...body,
      createdBy: body.createdBy || req.user?.email,
    },
    scope
  );
  // Broadcast to every connected client in the same store scope so the
  // booking appears instantly on every other device.
  realtimeHub.publish(
    realtimeHub.buildBookingEvent({
      action: booking && booking.status === "checked_out" ? "checked_out" : "upserted",
      booking,
      scope,
    })
  );
  res.json(booking);
});

app.put("/api/hotel/bookings/:id", ensureAuth, async (req, res) => {
  const updated = await hotelBookingsQueries.update(req.params.id, req.body || {});
  if (!updated) return res.status(404).json({ error: "Booking not found" });
  realtimeHub.publish(
    realtimeHub.buildBookingEvent({
      action: "updated",
      booking: updated,
      scope: { storeType: updated._storeType, storeId: updated._storeId },
    })
  );
  res.json(updated);
});

app.delete("/api/hotel/bookings/:id", ensureAuth, async (req, res) => {
  const ok = await hotelBookingsQueries.deleteById(req.params.id);
  if (!ok) return res.status(404).json({ error: "Booking not found" });
  realtimeHub.publish(
    realtimeHub.buildHotelEvent({
      action: "deleted",
      kind: "booking",
      storeType: req.query.storeType,
      storeId: req.query.storeId,
      data: { id: Number(req.params.id) },
    })
  );
  res.json({ ok: true });
});

app.post("/api/hotel/bookings/:id/checkout", ensureAuth, async (req, res) => {
  const booking = await hotelBookingsQueries.checkout(req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  realtimeHub.publish(
    realtimeHub.buildBookingEvent({
      action: "checked_out",
      booking,
      scope: { storeType: booking._storeType, storeId: booking._storeId },
    })
  );
  res.json(booking);
});

// Free-up endpoint: marks a (kind, refId) booking as checked_out without
// needing the database id. Used when the cashier finishes a table or room.
app.post("/api/hotel/bookings/checkout-by-ref", ensureAuth, async (req, res) => {
  const { kind, refId, storeType, storeId } = req.body || {};
  if (!kind || !refId) {
    return res.status(400).json({ error: "kind and refId are required" });
  }
  const scope = {
    storeType: storeType || req.query.storeType,
    storeId: storeId || req.query.storeId,
  };
  await hotelBookingsQueries.clearByRefId(kind, refId, scope);
  realtimeHub.publish(
    realtimeHub.buildHotelEvent({
      action: "checked_out",
      kind: "booking",
      storeType: scope.storeType,
      storeId: scope.storeId,
      data: { kind, refId },
    })
  );
  res.json({ ok: true });
});

// === Real-time sync (SSE) ===================================================
// Native EventSource on the client. Long-lived HTTP/1.1 chunked response
// that survives proxies (Render, Cloudflare) better than WebSocket.
// One connection per browser tab. Client connects on app mount, listens
// for `booking` / `hotel` events, and merges them into local state.

app.get("/api/events", ensureAuth, sseHandler);

// Friendly alias for the SSE endpoint so we can disambiguate it from
// other /api/* in production logs and reverse proxies.
app.get("/api/sse", ensureAuth, sseHandler);

app.get("/api/hotel/:resource", ensureAuth, async (req, res) => {
  const resource = resolveHotelResource(req.params.resource);
  // module-locks has its own explicit routes above; if it slips through
  // here (e.g. /api/hotel/module-locks/extra), return 404 cleanly rather
  // than hitting hotelQueries.sliceToColumn with a non-mapped name.
  if (req.params.resource === "module-locks") {
    return res.status(404).json({ error: "Not found" });
  }
  if (!hotelQueries.sliceToColumn(resource)) {
    return res.status(404).json({ error: "Not found" });
  }
  res.json(await hotelQueries.getSlice(resource));
});

app.post("/api/hotel/:resource", ensureAuth, async (req, res) => {
  const resource = resolveHotelResource(req.params.resource);
  if (req.params.resource === "module-locks") {
    return res.status(404).json({ error: "Not found" });
  }
  if (!hotelQueries.sliceToColumn(resource)) {
    return res.status(404).json({ error: "Not found" });
  }
  const item = { id: Date.now(), ...req.body };
  await hotelQueries.pushItem(resource, item);
  res.json(item);
});

app.delete("/api/hotel/checkout-history", ensureAuth, async (req, res) => {
  await hotelQueries.clearSlice("checkout-history");
  res.json({ ok: true });
});

app.delete("/api/hotel/:resource/:id", ensureAuth, async (req, res) => {
  const resource = resolveHotelResource(req.params.resource);
  if (!hotelQueries.sliceToColumn(resource)) {
    return res.status(404).json({ error: "Not found" });
  }
  const removed = await hotelQueries.removeItem(resource, req.params.id);
  res.json({ ok: removed });
});

app.put("/api/hotel/dining-bills/:tableId", ensureAuth, async (req, res) => {
  const { tableId } = req.params;
  const payload = req.body || {};
  const bills = await hotelQueries.getSlice("dining-bills");
  const existing = bills.find((item) => String(item.id) === String(tableId));
  let next;
  if (existing) {
    next = { ...existing, ...payload };
    const filtered = bills.filter((b) => String(b.id) !== String(tableId));
    filtered.push(next);
    await hotelQueries.replaceSlice("dining-bills", filtered);
  } else {
    next = { id: tableId, ...payload };
    bills.push(next);
    await hotelQueries.replaceSlice("dining-bills", bills);
  }
  // Live-bill change broadcasts to every connected client in the same
  // store so the matching Room/Table + Live Bill item updates on every
  // device simultaneously.
  realtimeHub.publish(
    realtimeHub.buildHotelEvent({
      action: "live_bill_updated",
      kind: "live_bill",
      storeType: req.query.storeType,
      storeId: req.query.storeId,
      data: { tableId, bill: next },
    })
  );
  res.json(next);
});

app.delete("/api/hotel/dining-bills/:tableId", ensureAuth, async (req, res) => {
  const { tableId } = req.params;
  const removed = await hotelQueries.removeItem("dining-bills", tableId);
  realtimeHub.publish(
    realtimeHub.buildHotelEvent({
      action: "live_bill_cleared",
      kind: "live_bill",
      storeType: req.query.storeType,
      storeId: req.query.storeId,
      data: { tableId },
    })
  );
  res.json({ ok: removed });
});

// PUBLIC — no ensureAuth. Used by the WhatsApp/Email share link so
// customers can open their invoice without logging in. Returns a
// sanitized invoice (no internal `_store*` / `_user_email`, no cashier
// email, no `items[].meta`) plus the store chrome the thermal
// renderers need to display the real store name/address/GSTIN/logo.
app.get("/api/public/invoices/:invoiceNo", async (req, res) => {
  const row = await invoicesQueries.findByInvoiceNo(req.params.invoiceNo);
  if (!row) {
    return res.status(404).json({ error: "Not found" });
  }
  const invoice = sanitizePublicInvoice(row);
  // The row's `invoice_no` column may be NULL for legacy / partial rows
  // even though the URL clearly identifies the invoice. Fill `invoiceNo`
  // from the URL param so the public receipt renders the number the
  // customer actually sees in the browser address bar.
  if (!invoice.invoiceNo && req.params.invoiceNo) {
    invoice.invoiceNo = String(req.params.invoiceNo);
  }
  const store = await getPublicStoreChrome(row);
  res.json({ invoice, store });
});

app.get("/api/invoices/:invoiceNo", ensureAuth, async (req, res) => {
  const invoice = await invoicesQueries.findByInvoiceNo(req.params.invoiceNo);
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
//   1. SELECT ... FOR UPDATE locks each product row before validation,
//      serializing concurrent cashiers against the same stock.
//   2. Validate stock per line item. Any failure → 409, ROLLBACK, no writes.
//   3. UPDATE products SET stock = stock - ? WHERE id = ? per line.
//   4. INSERT INTO invoices ... in the same transaction.
//   5. COMMIT. On any thrown error the transaction rolls back and no
//      partial state is committed.
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
    // Broadcast the new invoice so other cashiers / admins in the same
    // store see live sales activity without polling.
    realtimeHub.publish(
      realtimeHub.buildInvoiceEvent({
        action: "created",
        invoice: result,
        scope,
      })
    );
    // After the decrement, peek at each line item and emit a stock event
    // for any product that just crossed (or sits at/below) its low_stock
    // threshold. One event per affected product so the client's toast
    // queue stays clean.
    const products = require("./db/queries/products");
    const affected = Array.isArray(result?.affectedProducts)
      ? result.affectedProducts
      : (Array.isArray(result?.items) ? result.items : []);
    for (const line of affected) {
      const productId = line.productId || line.id;
      if (!productId) continue;
      const product = await products.findById(productId);
      if (!product) continue;
      const stock = Number(product.stock) || 0;
      const lowStock = Number(product.lowStock) || 0;
      if (lowStock > 0 && stock <= lowStock) {
        realtimeHub.publish(
          realtimeHub.buildStockEvent({
            action: "created",
            movement: { source: "invoice-checkout", invoiceNo: invoice.invoiceNo, productId, type: "out", quantity: line.qty || line.quantity || 0 },
            product: { id: product.id, name: product.name, stock, lowStock },
            crossedLowStock: true,
            scope,
          })
        );
      }
    }
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

// === STUB ROUTES for endpoints planned but not yet ported to MySQL ===
// These return 501 Not Implemented with a clear message so the frontend
// gets a predictable shape instead of an unhelpful 404. Real handlers
// will replace these one-by-one as the corresponding query modules land.

const notImplemented = (resource) => (req, res) => {
  res.status(501).json({
    error: `Endpoint /api/${resource} not implemented yet`,
    resource,
    hint: "MySQL data layer is wired for the 8 core resources (products, services, expenses, orders, invoices, customers, customer-credits, notifications) plus users, store-settings, sessions, hotel slices. Shifts, module-locks, payments, reports, audit-log, laundry, inventory are planned but pending.",
  });
};

// === Shifts ================================================================
// /api/shifts/active is called on every page mount by the frontend's
// useShiftGate hook. /api/shifts is also used for the OpenShiftDialog.
//
// The cash-vertical rule is enforced in the route, not the query — the
// query module just reads whatever it gets. Routes return 409 for non-cash
// store types so the frontend can hide the shift UI without needing to
// know which verticals are cash-bearing.
//
// Cash verticals: retail, hotel, laundry, service, msme-service,
// inventory. Anything else (system, hospital, school) returns 409.

const CASH_VERTICALS = new Set([
  "retail",
  "hotel",
  "laundry",
  "service",
  "msme-service",
  "inventory",
]);

const requireCashVertical = (req, res) => {
  const scope = getRequestScope(req);
  // SUPER_OWNER impersonating without an explicit storeType → no shift UI.
  // Otherwise fall back to the user's own storeType.
  const storeType = scope.storeType || req.user?.storeType || "";
  if (!storeType || !CASH_VERTICALS.has(String(storeType).toLowerCase())) {
    res.status(409).json({
      error: "Shifts are not used in this store type",
      storeType: storeType || null,
    });
    return null;
  }
  return scope;
};

app.get("/api/shifts/active", ensureAuth, async (req, res) => {
  const scope = requireCashVertical(req, res);
  if (!scope) return;
  const shift = await shiftsQueries.getActiveForUser(
    req.user.id,
    scope.storeType,
    scope.storeId
  );
  res.json(shift || null);
});

app.get("/api/shifts", ensureAuth, async (req, res) => {
  const scope = requireCashVertical(req, res);
  if (!scope) return;
  const filters = { ...req.query };
  // Pass userId only when explicitly requested. By default scope list
  // shows all shifts in the store (not just the current user's), since
  // Admins/SuperOwners need to see cashier shifts for monitoring.
  const shifts = await shiftsQueries.list(scope, filters);
  res.json(shifts);
});

app.post("/api/shifts", ensureAuth, async (req, res) => {
  const scope = requireCashVertical(req, res);
  if (!scope) return;
  const { openingFloat = 0, notes = null } = req.body || {};
  // Refuse to open a second shift for the same user/store while one is open.
  const existing = await shiftsQueries.getActiveForUser(
    req.user.id,
    scope.storeType,
    scope.storeId
  );
  if (existing) {
    return res.status(409).json({
      error: "A shift is already open for this user/store",
      shift: existing,
    });
  }
  const shift = await shiftsQueries.open({
    userId: req.user.id,
    storeType: scope.storeType,
    storeId: scope.storeId,
    openingFloat,
    notes,
  });
  res.json(shift);
});

app.get("/api/shifts/:shiftId", ensureAuth, async (req, res) => {
  const shift = await shiftsQueries.findById(req.params.shiftId);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  res.json(shift);
});

app.post("/api/shifts/:shiftId/close", ensureAuth, async (req, res) => {
  const { closingCash = 0, closeNotes = null } = req.body || {};
  const shift = await shiftsQueries.close(req.params.shiftId, { closingCash, closeNotes });
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  res.json(shift);
});

app.get("/api/shifts/:shiftId/cash-movements", ensureAuth, async (req, res) => {
  const movements = await shiftsQueries.listCashMovements(req.params.shiftId);
  res.json(movements);
});

app.post("/api/shifts/:shiftId/cash-movements", ensureAuth, async (req, res) => {
  const { type, amount, reason = null } = req.body || {};
  const updated = await shiftsQueries.addCashMovement(req.params.shiftId, {
    type,
    amount,
    reason,
  });
  if (!updated) {
    return res
      .status(404)
      .json({ error: "Shift not found or already closed, or invalid movement type" });
  }
  res.json(updated);
});

app.get("/api/shifts/:shiftId/reconciliation", ensureAuth, async (req, res) => {
  const recon = await shiftsQueries.reconciliation(req.params.shiftId);
  if (!recon) return res.status(404).json({ error: "Shift not found" });
  res.json(recon);
});

app.get("/api/shifts/:shiftId/summary", ensureAuth, async (req, res) => {
  const summary = await shiftsQueries.summary(req.params.shiftId);
  if (!summary) return res.status(404).json({ error: "Shift not found" });
  res.json(summary);
});

// Hotel module-locks — single-user-at-a-time gate per hotel module.
// Handlers are registered earlier (before /api/hotel/:resource catch-all)
// so this stub block is intentionally empty — kept here as a marker for
// future contributors who might be looking for these endpoints.

// Payments — payment intents, mark-paid/failed, etc.
// payment_intents.id is client-generated (uuid-like). The same id can be
// POSTed twice safely: a duplicate INSERT returns the existing row.

const generateIntentId = () =>
  `pi_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

app.get("/api/payments/methods", ensureAuth, async (req, res) => {
  res.json(await paymentsQueries.listMethods());
});

app.post("/api/payments/intent", ensureAuth, async (req, res) => {
  const { amount, method = "upi", invoiceNo = null, note = null } = req.body || {};
  if (amount == null || Number.isNaN(Number(amount)) || Number(amount) <= 0) {
    return res.status(400).json({ error: "amount (positive number) is required" });
  }
  const scope = getRequestScope(req);
  const intent = await paymentsQueries.create({
    id: generateIntentId(),
    amount,
    method,
    invoiceNo,
    note,
    createdBy: req.user.id,
    storeType: scope.storeType,
    storeId: scope.storeId,
  });
  if (!intent) {
    return res.status(400).json({ error: "Invalid payment method" });
  }
  res.json(intent);
});

app.get("/api/payments/intent/:id", ensureAuth, async (req, res) => {
  const intent = await paymentsQueries.findById(req.params.id);
  if (!intent) return res.status(404).json({ error: "Intent not found" });
  res.json(intent);
});

app.post("/api/payments/intent/:id/mark-paid", ensureAuth, async (req, res) => {
  const { note = null } = req.body || {};
  const intent = await paymentsQueries.setStatus(req.params.id, "paid", note);
  if (!intent) return res.status(404).json({ error: "Intent not found or invalid status" });
  res.json(intent);
});

app.post("/api/payments/intent/:id/mark-failed", ensureAuth, async (req, res) => {
  const { note = null } = req.body || {};
  const intent = await paymentsQueries.setStatus(req.params.id, "failed", note);
  if (!intent) return res.status(404).json({ error: "Intent not found or invalid status" });
  res.json(intent);
});

// Dev-only — flips a pending intent to paid without a real gateway. Used
// by the payment dialog's "Simulate payment" button in mock mode.
app.post("/api/payments/intent/:id/simulate-payment", ensureAuth, async (req, res) => {
  const existing = await paymentsQueries.findById(req.params.id);
  if (!existing) return res.status(404).json({ error: "Intent not found" });
  if (existing.status !== "pending") {
    return res.status(409).json({ error: `Cannot simulate payment on a ${existing.status} intent` });
  }
  const intent = await paymentsQueries.setStatus(req.params.id, "paid", "simulated");
  res.json(intent);
});

// Reports — sales / GST / P&L + CSV export.
//
// Admin-only: CASHIER gets 403 (matches the docstring on reportService).
// SUPER_OWNER / ADMIN / STORE_ADMIN can read. The export endpoint streams
// CSV with a Content-Disposition header so the browser saves the file.
const requireReportAccess = (req, res) => {
  const role = String(req.user?.role || "").toUpperCase();
  if (role === "CASHIER") {
    res.status(403).json({ error: "Reports are admin-only" });
    return false;
  }
  return true;
};

const toCsv = (rows) => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => escape(r[h])).join(",")),
  ].join("\n");
};

app.get("/api/reports/sales", ensureAuth, async (req, res) => {
  if (!requireReportAccess(req, res)) return;
  res.json(await reportsQueries.salesReport(req.query));
});

app.get("/api/reports/gst", ensureAuth, async (req, res) => {
  if (!requireReportAccess(req, res)) return;
  res.json(await reportsQueries.gstReport(req.query));
});

app.get("/api/reports/pnl", ensureAuth, async (req, res) => {
  if (!requireReportAccess(req, res)) return;
  res.json(await reportsQueries.pnlReport(req.query));
});

app.get("/api/reports/export", ensureAuth, async (req, res) => {
  if (!requireReportAccess(req, res)) return;
  const type = String(req.query.type || "sales");
  let report;
  let filename;
  let rows;
  if (type === "sales") {
    report = await reportsQueries.salesReport(req.query);
    filename = `sales-${new Date().toISOString().slice(0, 10)}.csv`;
    rows = report.buckets.map((b) => ({
      day: b.day,
      invoice_count: b.invoiceCount,
      revenue: b.revenue,
      gst: b.gst,
    }));
  } else if (type === "gst") {
    report = await reportsQueries.gstReport(req.query);
    filename = `gst-${new Date().toISOString().slice(0, 10)}.csv`;
    rows = report.hsns.map((h) => ({
      hsn: h.hsn,
      item_count: h.itemCount,
      taxable: h.taxable,
      tax: h.tax,
    }));
  } else if (type === "pnl") {
    report = await reportsQueries.pnlReport(req.query);
    filename = `pnl-${new Date().toISOString().slice(0, 10)}.csv`;
    rows = report.expensesByCategory.map((e) => ({
      category: e.category,
      amount: e.amount,
    }));
    // Append a single-row totals row at the bottom so the spreadsheet has
    // the headline numbers.
    rows.push({
      category: "__TOTAL__",
      amount: report.totals.netProfit,
    });
  } else {
    return res.status(400).json({ error: "type must be one of sales|gst|pnl" });
  }

  const csv = toCsv(rows);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// Audit log — append-only event stream.
// Read-only via HTTP. Non-SUPER_OWNER roles are scoped to their own
// user_id (matches the docstring on auditLogService: the log is
// per-user, not per-store). SUPER_OWNER can pass userId explicitly to
// view other users' logs.

app.get("/api/audit-log", ensureAuth, async (req, res) => {
  const isSuperOwner = req.user?.role === "SUPER_OWNER";
  // Non-super-owners can only see their own entries; ignore any userId
  // they pass to avoid leaking other users' logs.
  const userId = isSuperOwner && req.query.userId
    ? Number(req.query.userId)
    : (isSuperOwner ? null : req.user.id);
  const result = await auditLogQueries.list({
    userId,
    action: req.query.action,
    entityType: req.query.entityType,
    entityId: req.query.entityId,
    since: req.query.since,
    until: req.query.until,
    limit: req.query.limit,
    offset: req.query.offset,
  });
  res.json(result);
});

// Laundry — token counter + ledger.
// Counter is per (day, storeType, storeId); idempotent on writes that
// wouldn't advance the value. Ledger is append-only, scoped to a store.

const getLaundryScope = (req) => {
  const scope = getRequestScope(req);
  return {
    storeType: scope.storeType || req.user?.storeType || null,
    storeId: scope.storeId || req.user?.storeId || null,
    email: scope.email || req.user?.email || null,
  };
};

app.get("/api/laundry/token-counter", ensureAuth, async (req, res) => {
  const s = getLaundryScope(req);
  res.json(await laundryQueries.getCounter({
    storeType: s.storeType,
    storeId: s.storeId,
    day: req.query.day,
  }));
});

app.post("/api/laundry/token-counter", ensureAuth, async (req, res) => {
  const s = getLaundryScope(req);
  const { value = 0, day } = req.body || {};
  res.json(await laundryQueries.setCounter({
    storeType: s.storeType,
    storeId: s.storeId,
    day,
    value,
  }));
});

app.get("/api/laundry/ledger", ensureAuth, async (req, res) => {
  const s = getLaundryScope(req);
  const limit = Number(req.query.limit) || 200;
  res.json(await laundryQueries.listLedger({
    storeType: s.storeType,
    storeId: s.storeId,
    limit,
  }));
});

app.post("/api/laundry/ledger", ensureAuth, async (req, res) => {
  const s = getLaundryScope(req);
  const entry = await laundryQueries.addLedgerEntry({
    ...(req.body || {}),
    storeType: s.storeType,
    storeId: s.storeId,
    userEmail: s.email,
  });
  if (!entry) return res.status(400).json({ error: "productName and numeric delta are required" });
  res.json(entry);
});

app.delete("/api/laundry/ledger", ensureAuth, async (req, res) => {
  const s = getLaundryScope(req);
  const deleted = await laundryQueries.clearLedger({
    storeType: s.storeType,
    storeId: s.storeId,
  });
  res.json({ ok: true, deleted });
});

// Inventory — suppliers, purchase orders, stock movements, low-stock alert.
// Admin-only writes; reads scoped by storeType/storeId. Receive PO bumps
// products.stock and appends one stock_movement (type='in') per item.

const requireInventoryAdmin = (req, res) => {
  const role = String(req.user?.role || "").toUpperCase();
  // CASHIER can read inventory but not write to it.
  if (req.method !== "GET" && role === "CASHIER") {
    res.status(403).json({ error: "Inventory writes are admin-only" });
    return false;
  }
  return true;
};

const getInvScope = (req) => {
  const scope = getRequestScope(req);
  return {
    storeType: scope.storeType || req.user?.storeType || null,
    storeId: scope.storeId || req.user?.storeId || null,
    email: scope.email || req.user?.email || null,
  };
};

// === Suppliers =============================================================

app.get("/api/suppliers", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  res.json(await inventoryQueries.listSuppliers(getInvScope(req)));
});

app.post("/api/suppliers", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const supplier = await inventoryQueries.createSupplier(req.body || {}, getInvScope(req));
  if (!supplier) return res.status(400).json({ error: "name is required" });
  res.json(supplier);
});

app.put("/api/suppliers/:id", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const supplier = await inventoryQueries.updateSupplier(req.params.id, req.body || {});
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.json(supplier);
});

app.delete("/api/suppliers/:id", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const ok = await inventoryQueries.deleteSupplier(req.params.id);
  if (!ok) return res.status(404).json({ error: "Supplier not found" });
  res.json({ ok: true });
});

// === Purchase Orders =======================================================

app.get("/api/purchase-orders", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  res.json(await inventoryQueries.listPurchaseOrders(getInvScope(req), req.query));
});

app.post("/api/purchase-orders", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const po = await inventoryQueries.createPurchaseOrder(req.body || {}, getInvScope(req));
  if (!po) return res.status(400).json({ error: "poNumber is required" });
  // Decorate with items so the frontend gets them in one shot.
  const items = await inventoryQueries.listPoItems(po.id);
  res.json({ ...po, items });
});

app.put("/api/purchase-orders/:id", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const po = await inventoryQueries.updatePurchaseOrder(req.params.id, req.body || {});
  if (!po) return res.status(404).json({ error: "Purchase order not found" });
  res.json(po);
});

app.delete("/api/purchase-orders/:id", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const ok = await inventoryQueries.deletePurchaseOrder(req.params.id);
  if (!ok) return res.status(404).json({ error: "Purchase order not found" });
  res.json({ ok: true });
});

app.post("/api/purchase-orders/:id/receive", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const po = await inventoryQueries.receivePurchaseOrder(req.params.id);
  if (!po) return res.status(404).json({ error: "Purchase order not found" });
  res.json(po);
});

// === Stock Movements =======================================================

app.get("/api/stock-movements", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  res.json(await inventoryQueries.listStockMovements(getInvScope(req), req.query));
});

app.post("/api/stock-movements", ensureAuth, async (req, res) => {
  if (!requireInventoryAdmin(req, res)) return;
  const scope = getInvScope(req);
  const movement = await inventoryQueries.createStockMovement(
    { ...(req.body || {}), createdBy: req.user.id },
    scope
  );
  if (!movement) {
    return res.status(400).json({ error: "productId, type (in|out|adjustment) and positive quantity required" });
  }

  // Look up the product's current stock + low-stock threshold so we can
  // tell the client whether this movement pushed the item under the
  // alert line. The client uses `crossedLowStock` to fire a toast.
  const products = require("./db/queries/products");
  const product = await products.findById(movement.productId);
  let crossedLowStock = false;
  if (product) {
    const stock = Number(product.stock) || 0;
    const lowStock = Number(product.lowStock) || 0;
    crossedLowStock = lowStock > 0 && stock <= lowStock;
  }

  realtimeHub.publish(
    realtimeHub.buildStockEvent({
      action: "created",
      movement,
      product: product ? { id: product.id, name: product.name, stock: product.stock, lowStock: product.lowStock } : null,
      crossedLowStock,
      scope,
    })
  );
  res.json(movement);
});

// === Low-stock alerts ======================================================

app.get("/api/inventory/low-stock", ensureAuth, async (req, res) => {
  res.json(await inventoryQueries.lowStockAlerts(getInvScope(req)));
});

app.get("/api/:resource", ensureAuth, async (req, res) => {
  const { resource } = req.params;
  // Every resource in this codebase has a MySQL-backed query module;
  // unknown resources return 501 with a clear "not implemented yet"
  // message rather than 404 — these endpoints are intentionally planned,
  // they just haven't been wired to MySQL yet (shifts, module-locks,
  // payments, reports, audit-log, laundry, inventory).
  const mysqlQueries = mysqlResources[resource];
  if (!mysqlQueries) {
    return res.status(501).json({
      error: `Endpoint /api/${resource} not implemented yet`,
      resource,
      hint: "This endpoint was ported from JSON storage but the MySQL data layer + route are still pending. See server/db/queries/ for the gap.",
    });
  }
  const scope = getRequestScope(req);
  const items = await mysqlQueries.list(scope, req.query);
  return res.json(items);
});

app.post("/api/:resource", ensureAuth, async (req, res) => {
  const { resource } = req.params;
  const mysqlQueries = mysqlResources[resource];
  if (!mysqlQueries) {
    return res.status(501).json({
      error: `Endpoint POST /api/${resource} not implemented yet`,
      resource,
    });
  }
  const scope = getRequestScope(req);
  const created = await mysqlQueries.create(req.body || {}, scope);
  return res.json(created);
});

app.put("/api/:resource/:id", ensureAuth, async (req, res) => {
  const { resource, id } = req.params;
  const mysqlQueries = mysqlResources[resource];
  if (!mysqlQueries) {
    return res.status(501).json({
      error: `Endpoint PUT /api/${resource}/:id not implemented yet`,
      resource,
    });
  }
  const scope = getRequestScope(req);
  if (typeof mysqlQueries.findByIdScoped !== "function") {
    // Some query modules only expose findById (no scope variant). Fall
    // back to that — no scope enforcement, matching the JSON path.
    const existing = await mysqlQueries.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
  } else {
    const existing = await mysqlQueries.findByIdScoped(id, scope);
    if (!existing) return res.status(404).json({ error: "Not found" });
  }
  const updated = await mysqlQueries.update(id, req.body || {});
  return res.json(updated);
});

app.delete("/api/:resource/:id", ensureAuth, async (req, res) => {
  const { resource, id } = req.params;
  const mysqlQueries = mysqlResources[resource];
  if (!mysqlQueries) {
    return res.status(501).json({
      error: `Endpoint DELETE /api/${resource}/:id not implemented yet`,
      resource,
    });
  }
  const scope = getRequestScope(req);
  if (typeof mysqlQueries.findByIdScoped === "function") {
    const existing = await mysqlQueries.findByIdScoped(id, scope);
    if (!existing) return res.status(404).json({ error: "Not found" });
  } else {
    const existing = await mysqlQueries.findById(id);
    if (!existing) return res.status(404).json({ error: "Not found" });
  }
  const deleted = await mysqlQueries.deleteById(id);
  return res.json({ ok: deleted });
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
  // Sessions live in MySQL (sessions table) — no in-memory load needed.
  // Hotel state lives in MySQL (hotel_state singleton) — no in-memory
  // load needed. The MySQL-backed routes read fresh on every request.
  app.listen(PORT, () => {
    console.log(`Backend (MySQL) listening on http://localhost:${PORT}`);
    console.log(`Frontend origin allowed: ${FRONTEND_ORIGIN}`);
  });
};

startServer().catch((err) => {
  console.error("Failed to start backend:", err);
  process.exit(1);
});
