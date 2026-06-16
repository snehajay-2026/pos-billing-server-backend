const dotenv = require('dotenv');
dotenv.config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_DIR = path.join(__dirname, 'data');
const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS) || 10;
const LOGIN_ATTEMPT_WINDOW_MS = Number(process.env.LOGIN_ATTEMPT_WINDOW_MS) || 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = Number(process.env.MAX_LOGIN_ATTEMPTS) || 5;
const PASSWORD_RESET_EXPIRY_MS = Number(process.env.PASSWORD_RESET_EXPIRY_MS) || 60 * 60 * 1000;
const ENABLE_REGISTRATION = process.env.ENABLE_REGISTRATION === 'true';
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const SENDGRID_FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "no-reply@yourdomain.com";
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const NOTIFICATIONS_FILE = 'notifications.json';

const loginAttempts = new Map();

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(
  session({
    name: 'pos_session',
    secret: process.env.SESSION_SECRET || 'pos-billing-secret',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
    },
  })
);

const ensureDataDir = () => {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
};

const readData = (filename, defaultValue = []) => {
  ensureDataDir();
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    fs.writeFileSync(filepath, JSON.stringify(defaultValue, null, 2));
    return defaultValue;
  }
  const raw = fs.readFileSync(filepath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    return defaultValue;
  }
};

const writeData = (filename, data) => {
  ensureDataDir();
  const filepath = path.join(DATA_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
};

const addNotification = (notification) => {
  const notifications = readData(NOTIFICATIONS_FILE, []);
  notifications.unshift({
    id: Date.now(),
    createdAt: new Date().toISOString(),
    read: false,
    ...notification,
  });
  writeData(NOTIFICATIONS_FILE, notifications);
};

const isEmailEnabled = Boolean(SENDGRID_API_KEY && SENDGRID_FROM_EMAIL);

let sgMail;
if (isEmailEnabled) {
  sgMail = require('@sendgrid/mail');
  sgMail.setApiKey(SENDGRID_API_KEY);
}

const sendPasswordResetEmail = async (email, token) => {
  if (!isEmailEnabled) {
    return false;
  }

  const resetUrl = `${APP_URL.replace(/\/$/, '')}/password-reset`;
  const message = {
    to: email,
    from: SENDGRID_FROM_EMAIL,
    subject: 'Reset your password',
    text: `You requested a password reset. Use this code to continue:\n\n${token}\n\nVisit ${resetUrl} to complete the reset.`,
    html: `<p>You requested a password reset.</p><p>Use this code to continue:</p><p><strong>${token}</strong></p><p>Visit <a href="${resetUrl}">${resetUrl}</a> to complete the reset.</p>`,
  };

  await sgMail.send(message);
  return true;
};

const markNotificationRead = (id) => {
  const notifications = readData(NOTIFICATIONS_FILE, []);
  const updated = notifications.map((note) => note.id === id ? { ...note, read: true } : note);
  writeData(NOTIFICATIONS_FILE, updated);
};

const parseJson = (value) => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const getSessionUser = (req) => {
  return req.session && req.session.user ? req.session.user : null;
};

const getUserMeta = (req) => {
  const sessionUser = getSessionUser(req);
  return {
    role: sessionUser?.role || 'GUEST',
    storeType: sessionUser?.storeType || 'nostore',
    storeId: sessionUser?.storeId || sessionUser?.storeType || null,
    email: sessionUser?.email || 'nouser',
    ownerEmail: sessionUser?.ownerEmail || null,
    rootOwnerEmail: sessionUser?.rootOwnerEmail || sessionUser?.ownerEmail || null,
  };
};

const requireSecureSession = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.session.user.lockedUntil && new Date(req.session.user.lockedUntil) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked due to failed login attempts' });
  }
  next();
};

const getUserScope = (userMeta) => {
  return userMeta?.storeId || userMeta?.storeType || null;
};

const isRole = (req, allowed) => {
  const user = getSessionUser(req);
  return user && allowed.includes(user.role);
};

const SUPPORTED_USER_ROLES = ['SUPER_OWNER', 'STORE_ADMIN', 'ADMIN', 'CASHIER'];
const STORE_ADMIN_ROLES = ['SUPER_OWNER', 'STORE_ADMIN', 'ADMIN'];
const USER_MANAGER_ROLES = ['SUPER_OWNER', 'STORE_ADMIN', 'ADMIN'];
const USER_VIEWER_ROLES = ['SUPER_OWNER', 'STORE_ADMIN', 'ADMIN'];

const isSuperOwner = (req) => isRole(req, ['SUPER_OWNER']);
const isStoreLevelAdmin = (req) => isRole(req, STORE_ADMIN_ROLES);
const isAdminOnly = (req) => isRole(req, ['ADMIN']);
const isStoreAdminOnly = (req) => isRole(req, ['STORE_ADMIN']);
const canManageUsers = (req) => isRole(req, USER_MANAGER_ROLES);
const canViewUsers = (req) => isRole(req, USER_VIEWER_ROLES);

const requireRole = (allowed) => (req, res, next) => {
  if (!req.session?.user || !allowed.includes(req.session.user.role)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  next();
};

const requireStoreManager = requireRole(STORE_ADMIN_ROLES);
const requireCashierOrAbove = requireRole(SUPPORTED_USER_ROLES);

const requireAdmin = (req, res, next) => {
  if (!isStoreLevelAdmin(req)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const requireUserManager = (req, res, next) => {
  if (!canManageUsers(req)) {
    return res.status(403).json({ error: 'User management access required' });
  }
  next();
};

const requireUserViewer = (req, res, next) => {
  if (!canViewUsers(req)) {
    return res.status(403).json({ error: 'User view access required' });
  }
  next();
};

const getLoginKey = (req) => `${req.ip}:${String(req.body.email || '').toLowerCase()}`;

const isLoginBlocked = (req) => {
  const key = getLoginKey(req);
  const entry = loginAttempts.get(key);
  if (!entry) return false;
  const age = Date.now() - entry.firstAttemptAt;
  if (age > LOGIN_ATTEMPT_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return entry.count >= MAX_LOGIN_ATTEMPTS;
};

const getLoginLockMessage = (req) => {
  const key = getLoginKey(req);
  const entry = loginAttempts.get(key);
  if (!entry) return null;
  const remaining = Math.max(0, LOGIN_ATTEMPT_WINDOW_MS - (Date.now() - entry.firstAttemptAt));
  return `Too many login attempts. Try again in ${Math.ceil(remaining / 60000)} minute(s).`;
};

const recordLoginAttempt = (req, success) => {
  const key = getLoginKey(req);
  const entry = loginAttempts.get(key) || { count: 0, firstAttemptAt: Date.now() };
  if (success) {
    loginAttempts.delete(key);
    return;
  }
  if (Date.now() - entry.firstAttemptAt > LOGIN_ATTEMPT_WINDOW_MS) {
    entry.count = 0;
    entry.firstAttemptAt = Date.now();
  }
  entry.count += 1;
  entry.lastAttemptAt = new Date().toISOString();

  const email = String(req.body.email || '').toLowerCase();
  const users = readData('users.json', []);
  const index = users.findIndex((u) => String(u.email).toLowerCase() === email);
  if (index >= 0 && entry.count >= MAX_LOGIN_ATTEMPTS) {
    users[index] = {
      ...users[index],
      lockedUntil: new Date(Date.now() + LOGIN_ATTEMPT_WINDOW_MS).toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeData('users.json', users);
    addNotification({
      email: users[index].email,
      type: 'account_locked',
      message: 'Your account has been temporarily locked due to repeated failed login attempts.',
    });
  }

  loginAttempts.set(key, entry);
};

const requireLogin = (req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

const cleanUser = (user) => {
  if (!user) return null;
  const { password, resetToken, resetTokenExpiry, lockedUntil, ...safeUser } = user;
  return safeUser;
};

const matchesStoreScope = (item, storeType, storeId) => {
  if (item._storeType !== storeType) return false;
  if (storeId && item._storeId !== undefined && item._storeId !== storeId) return false;
  return true;
};

const filterByUser = (items, storeType, email, storeId) =>
  items.filter((item) => matchesStoreScope(item, storeType, storeId) && item._userEmail === email);

app.post('/api/register', (req, res) => {
  const { email, password, role, storeType, storeId } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Missing registration fields' });
  }

  const users = readData('users.json', []);
  const existing = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const isFirstUser = users.length === 0;
  if (!ENABLE_REGISTRATION && !isFirstUser) {
    return res.status(403).json({ error: 'Registration is disabled. Contact administrator.' });
  }

  const nextUser = {
    id: Date.now(),
    email: String(email).toLowerCase(),
    password: bcrypt.hashSync(String(password), BCRYPT_SALT_ROUNDS),
    role: isFirstUser ? 'SUPER_OWNER' : (role || 'CASHIER'),
    storeType: isFirstUser ? 'system' : storeType || 'retail',
    storeId: isFirstUser ? null : storeId || storeType || null,
    name: '',
    phone: '',
    address: '',
    approved: isFirstUser,
    status: isFirstUser ? 'approved' : 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  users.push(nextUser);
  writeData('users.json', users);
  res.status(201).json({
    email: nextUser.email,
    role: nextUser.role,
    storeType: nextUser.storeType,
    storeId: nextUser.storeId,
    name: nextUser.name,
    status: nextUser.status,
  });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (isLoginBlocked(req)) {
    return res.status(429).json({ error: getLoginLockMessage(req) || 'Too many login attempts. Please try again later.' });
  }

  const users = readData('users.json', []);
  const user = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  const passwordMatches = user && bcrypt.compareSync(String(password), user.password);

  if (!user || !passwordMatches) {
    recordLoginAttempt(req, false);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked due to failed login attempts' });
  }

  if (!user.approved) {
    recordLoginAttempt(req, false);
    addNotification({
      email: user.email,
      type: 'approval_required',
      message: 'Your account is awaiting administrator approval.',
    });
    return res.status(403).json({ error: 'Account pending approval. Contact administrator.' });
  }

  recordLoginAttempt(req, true);
  const sessionUser = {
    email: user.email,
    role: user.role,
    storeType: user.storeType,
    storeId: user.storeId || null,
    ownerEmail: user.ownerEmail || null,
    rootOwnerEmail: user.rootOwnerEmail || user.ownerEmail || null,
    name: user.name || '',
    phone: user.phone || '',
    address: user.address || '',
    lockedUntil: user.lockedUntil || null,
  };
  req.session.user = sessionUser;
  req.session.regenerate(() => {
    req.session.user = sessionUser;
    res.json(sessionUser);
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/auth/user', (req, res) => {
  res.json(getSessionUser(req));
});

app.post('/api/password-reset/request', (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const users = readData('users.json', []);
  const userIndex = users.findIndex((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  if (userIndex === -1) {
    return res.status(200).json({ message: 'If the account exists, password reset instructions were sent.' });
  }

  const resetToken = crypto.randomBytes(24).toString('hex');
  const resetTokenExpiry = Date.now() + PASSWORD_RESET_EXPIRY_MS;
  users[userIndex] = {
    ...users[userIndex],
    resetToken,
    resetTokenExpiry,
  };
  writeData('users.json', users);

  addNotification({
    email: users[userIndex].email,
    type: 'password_reset_requested',
    message: 'Password reset requested. Please check your email or contact support for the reset token.',
  });

  const emailDelivered = isEmailEnabled
    ? await sendPasswordResetEmail(users[userIndex].email, resetToken).catch((err) => {
        console.error('SendGrid error', err);
        return false;
      })
    : false;

  const responsePayload = {
    message: emailDelivered
      ? 'Password reset requested. Please check your email for the reset token.'
      : 'Password reset requested. Email delivery is unavailable. Contact support or use the fallback token in development.',
  };

  if (!isEmailEnabled) {
    responsePayload.resetToken = resetToken;
  }

  res.json(responsePayload);
});

app.post('/api/password-reset/confirm', (req, res) => {
  const { email, token, password } = req.body || {};
  if (!email || !token || !password) {
    return res.status(400).json({ error: 'Email, token, and new password are required' });
  }

  const users = readData('users.json', []);
  const userIndex = users.findIndex(
    (u) => String(u.email).toLowerCase() === String(email).toLowerCase() && u.resetToken === token
  );
  if (userIndex === -1) {
    return res.status(400).json({ error: 'Invalid reset token or email' });
  }

  if (!users[userIndex].resetTokenExpiry || Date.now() > users[userIndex].resetTokenExpiry) {
    return res.status(400).json({ error: 'Reset token has expired' });
  }

  users[userIndex] = {
    ...users[userIndex],
    password: bcrypt.hashSync(String(password), BCRYPT_SALT_ROUNDS),
    resetToken: null,
    resetTokenExpiry: null,
    updatedAt: new Date().toISOString(),
  };
  writeData('users.json', users);

  addNotification({
    email: users[userIndex].email,
    type: 'password_reset_success',
    message: 'Your password was reset successfully.',
  });

  res.json({ message: 'Password updated successfully' });
});

app.get('/api/notifications', requireLogin, (req, res) => {
  const current = getUserMeta(req);
  const notifications = readData(NOTIFICATIONS_FILE, []);
  const visible = notifications.filter((note) => String(note.email).toLowerCase() === String(current.email).toLowerCase());
  res.json(visible);
});

app.post('/api/notifications/:id/read', requireLogin, (req, res) => {
  const id = Number(req.params.id);
  if (!id) {
    return res.status(400).json({ error: 'Notification ID is required' });
  }
  markNotificationRead(id);
  res.json({ success: true });
});

app.get('/api/register/available', (req, res) => {
  const users = readData('users.json', []);
  const isFirstUser = users.length === 0;
  const available = ENABLE_REGISTRATION || isFirstUser;
  res.json({ available, isFirstUser });
});

app.use('/api', requireSecureSession);
app.use('/api', requireCashierOrAbove);

app.get('/api/users', requireUserViewer, (req, res) => {
  const users = readData('users.json', []);
  const current = getUserMeta(req);

  const visibleUsers = current.role === 'SUPER_OWNER'
    ? users
    : users.filter((u) => {
        if (getUserScope(u) !== getUserScope(current)) return false;
        if (isStoreAdminOnly(req)) {
          return u.role === 'CASHIER' || u.email === current.email;
        }
        if (isAdminOnly(req)) {
          return ['STORE_ADMIN', 'CASHIER'].includes(u.role) || u.email === current.email;
        }
        return u.email === current.email;
      });

  res.json(visibleUsers.map(cleanUser));
});

app.post('/api/users', requireUserManager, (req, res) => {
  const { email, password, role, storeType, storeId, approved } = req.body || {};
  if (!email || !password || !role || !storeType) {
    return res.status(400).json({ error: 'Missing user fields' });
  }

  const current = getUserMeta(req);
  const requestedRole = String(role).toUpperCase();
  const requestedStoreType = String(storeType).toLowerCase();
  const requestedStoreId = storeId !== undefined ? storeId : null;

  if (!SUPPORTED_USER_ROLES.includes(requestedRole)) {
    return res.status(403).json({ error: `Role ${requestedRole} is not supported` });
  }
  if (!isSuperOwner(req)) {
    if (isStoreAdminOnly(req) && requestedRole !== 'CASHIER') {
      return res.status(403).json({ error: 'Store Admin can only create cashier users' });
    }
    if (isAdminOnly(req) && !['STORE_ADMIN', 'CASHIER'].includes(requestedRole)) {
      return res.status(403).json({ error: 'Admin can only create store admins and cashiers' });
    }
  }

  const users = readData('users.json', []);
  const existing = users.find((u) => String(u.email).toLowerCase() === String(email).toLowerCase());
  if (existing) {
    return res.status(409).json({ error: 'User already exists' });
  }

  const finalStoreType = isSuperOwner(req) ? requestedStoreType : current.storeType;
  const finalStoreId = isSuperOwner(req)
    ? requestedStoreId || requestedStoreType
    : current.storeId || current.storeType;

  const newUser = {
    id: Date.now(),
    email: String(email).toLowerCase(),
    password: bcrypt.hashSync(String(password), BCRYPT_SALT_ROUNDS),
    role: requestedRole,
    storeType: finalStoreType,
    storeId: finalStoreId,
    ownerEmail: current.email,
    rootOwnerEmail: current.rootOwnerEmail || current.ownerEmail || current.email,
    name: '',
    phone: '',
    address: '',
    approved: approved === true,
    status: approved === true ? 'approved' : 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  users.push(newUser);
  writeData('users.json', users);
  res.status(201).json(cleanUser(newUser));
});

app.put('/api/users/:id', requireUserManager, (req, res) => {
  const current = getUserMeta(req);
  const users = readData('users.json', []);
  const index = users.findIndex((u) => String(u.id) === String(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  const target = users[index];
  if (!isSuperOwner(req) && getUserScope(target) !== getUserScope(current)) {
    return res.status(403).json({ error: 'Cannot modify users outside your store' });
  }

  if (isStoreAdminOnly(req) && target.role !== 'CASHIER' && target.email !== current.email) {
    return res.status(403).json({ error: 'Store Admin can only manage cashiers in their store' });
  }

  if (isAdminOnly(req) && target.role === 'SUPER_OWNER') {
    return res.status(403).json({ error: 'Admin cannot manage super owner' });
  }

  if (isAdminOnly(req) && target.role === 'ADMIN' && target.email !== current.email) {
    return res.status(403).json({ error: 'Admin can only manage store admins and cashiers in their store' });
  }

  const updatedFields = { ...req.body };
  if (updatedFields.password) {
    updatedFields.password = bcrypt.hashSync(String(updatedFields.password), BCRYPT_SALT_ROUNDS);
  }
  if (typeof updatedFields.approved !== 'undefined') {
    updatedFields.status = updatedFields.approved ? 'approved' : 'pending';
  }
  if (!isSuperOwner(req) && updatedFields.role) {
    const newRole = String(updatedFields.role).toUpperCase();
    if (isStoreAdminOnly(req) && newRole !== 'CASHIER') {
      return res.status(403).json({ error: 'Store Admin can only assign cashier role' });
    }
    if (isAdminOnly(req) && !['STORE_ADMIN', 'CASHIER'].includes(newRole)) {
      return res.status(403).json({ error: 'Admin can only assign store admin or cashier role' });
    }
  }

  const finalStoreType = isSuperOwner(req)
    ? updatedFields.storeType || target.storeType
    : target.storeType;
  const finalStoreId = isSuperOwner(req)
    ? updatedFields.storeId !== undefined ? updatedFields.storeId : target.storeId
    : target.storeId || current.storeType;

  users[index] = {
    ...target,
    ...updatedFields,
    email: String(updatedFields.email || target.email).toLowerCase(),
    role: updatedFields.role || target.role,
    storeType: finalStoreType,
    storeId: finalStoreId,
    updatedAt: new Date().toISOString(),
  };

  writeData('users.json', users);
  res.json(cleanUser(users[index]));
});

app.delete('/api/users/:id', requireUserManager, (req, res) => {
  const current = getUserMeta(req);
  const users = readData('users.json', []);
  const target = users.find((u) => String(u.id) === String(req.params.id));
  if (!target) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (!isSuperOwner(req) && getUserScope(target) !== getUserScope(current)) {
    return res.status(403).json({ error: 'Cannot remove users outside your store' });
  }
  if (isStoreAdminOnly(req) && target.role !== 'CASHIER') {
    return res.status(403).json({ error: 'Store Admin can only remove cashier users' });
  }
  if (isAdminOnly(req) && ['SUPER_OWNER', 'ADMIN'].includes(target.role)) {
    return res.status(403).json({ error: 'Admin can only remove store admins or cashiers in their store' });
  }
  if (!isSuperOwner(req) && target.role === 'SUPER_OWNER') {
    return res.status(403).json({ error: 'Cannot remove super owner' });
  }

  const filtered = users.filter((u) => String(u.id) !== String(req.params.id));
  writeData('users.json', filtered);
  res.json({ success: true });
});

app.post('/api/users/:id/approve', requireUserManager, (req, res) => {
  const current = getUserMeta(req);
  const users = readData('users.json', []);
  const index = users.findIndex((u) => String(u.id) === String(req.params.id));
  if (index === -1) {
    return res.status(404).json({ error: 'User not found' });
  }

  const target = users[index];
  if (!isSuperOwner(req) && getUserScope(target) !== getUserScope(current)) {
    return res.status(403).json({ error: 'Cannot approve users outside your store' });
  }
  if (isStoreAdminOnly(req) && target.role !== 'CASHIER') {
    return res.status(403).json({ error: 'Store Admin can only approve cashier users' });
  }
  if (isAdminOnly(req) && ['SUPER_OWNER', 'ADMIN'].includes(target.role) && target.email !== current.email) {
    return res.status(403).json({ error: 'Admin can only approve cashier users or their own store admins' });
  }

  users[index] = {
    ...target,
    approved: true,
    status: 'approved',
    updatedAt: new Date().toISOString(),
  };
  writeData('users.json', users);

  addNotification({
    email: users[index].email,
    type: 'account_approved',
    message: 'Your account has been approved and is ready for login.',
  });

  res.json(cleanUser(users[index]));
});

const canViewStoreData = (req) => isRole(req, ['SUPER_OWNER', 'STORE_ADMIN', 'ADMIN']);

app.get('/api/services', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const services = readData('services.json');
  const visible = canViewStoreData(req)
    ? services.filter((service) => matchesStoreScope(service, storeType, storeId))
    : filterByUser(services, storeType, email, storeId);
  res.json(visible);
});

app.post('/api/services', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const service = req.body;
  if (!service || !service.name || service.rate === undefined) {
    return res.status(400).json({ error: 'Invalid service payload' });
  }
  const services = readData('services.json');
  const nextService = {
    id: Date.now(),
    name: service.name,
    description: service.description || '',
    rate: Number(service.rate),
    hours: Number(service.hours || 0),
    gst: Number(service.gst || 0),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _storeType: storeType,
    _storeId: storeId || storeType,
    _userEmail: email,
  };
  services.push(nextService);
  writeData('services.json', services);
  res.status(201).json(nextService);
});

app.put('/api/services/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const services = readData('services.json');
  const index = services.findIndex((s) => String(s.id) === String(req.params.id) && s._storeType === storeType && s._userEmail === email);
  if (index === -1) {
    return res.status(404).json({ error: 'Service not found' });
  }
  const updated = {
    ...services[index],
    ...req.body,
    rate: Number(req.body.rate || services[index].rate),
    hours: Number(req.body.hours || services[index].hours),
    gst: Number(req.body.gst || services[index].gst),
    updatedAt: new Date().toISOString(),
  };
  services[index] = updated;
  writeData('services.json', services);
  res.json(updated);
});

app.delete('/api/services/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const services = readData('services.json');
  const filtered = services.filter((s) => !(String(s.id) === String(req.params.id) && s._storeType === storeType && s._userEmail === email));
  writeData('services.json', filtered);
  res.json({ success: true });
});

app.get('/api/products', (req, res) => {
  const { storeType, storeId } = getUserMeta(req);
  const products = readData('products.json');
  res.json(products.filter((p) => matchesStoreScope(p, storeType, storeId) || (!p._storeType && !p._storeId)));
});

app.post('/api/products', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const product = req.body;
  if (!product || !product.name || !product.price || !product.barcode) {
    return res.status(400).json({ error: 'Invalid product payload' });
  }
  const products = readData('products.json');
  const nextProduct = {
    id: Date.now(),
    ...product,
    price: Number(product.price),
    gst: Number(product.gst || 0),
    stock: Number(product.stock || 0),
    _storeType: storeType,
    _storeId: storeId || storeType,
    _userEmail: email,
  };
  products.push(nextProduct);
  writeData('products.json', products);
  res.status(201).json(nextProduct);
});

app.put('/api/products/:id', (req, res) => {
  const { storeType, storeId, email } = getUserMeta(req);
  const updated = req.body;
  const products = readData('products.json');
  const index = products.findIndex((p) => {
    if (String(p.id) !== String(req.params.id) || p._storeType !== storeType) return false;
    if (storeId && p._storeId !== undefined && p._storeId !== storeId) return false;
    return p._userEmail === email || canViewStoreData(req);
  });
  if (index === -1) {
    return res.status(404).json({ error: 'Product not found' });
  }
  const nextProduct = {
    ...products[index],
    ...updated,
    price: Number(updated.price || products[index].price),
    gst: Number(updated.gst || products[index].gst),
    stock: Number(updated.stock || products[index].stock),
  };
  products[index] = nextProduct;
  writeData('products.json', products);
  res.json(nextProduct);
});

app.delete('/api/products/:id', (req, res) => {
  const { storeType, storeId, email } = getUserMeta(req);
  const products = readData('products.json');
  const filtered = products.filter((p) => {
    if (String(p.id) !== String(req.params.id) || p._storeType !== storeType) return true;
    if (storeId && p._storeId !== undefined && p._storeId !== storeId) return true;
    return !(p._userEmail === email || canViewStoreData(req));
  });
  writeData('products.json', filtered);
  res.json({ success: true });
});

app.get('/api/invoices', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const invoices = readData('invoices.json');
  const visible = canViewStoreData(req)
    ? invoices.filter((inv) => matchesStoreScope(inv, storeType, storeId))
    : invoices.filter((inv) => matchesStoreScope(inv, storeType, storeId) && inv._userEmail === email);
  res.json(visible);
});

app.post('/api/invoices', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const invoice = req.body;
  if (!invoice || !invoice.invoiceNo) {
    return res.status(400).json({ error: 'Invalid invoice payload' });
  }
  const invoices = readData('invoices.json');
  const nextInvoice = {
    id: Date.now(),
    ...invoice,
    _storeType: storeType,
    _storeId: storeId || storeType,
    _userEmail: email,
  };
  invoices.push(nextInvoice);
  writeData('invoices.json', invoices);
  res.status(201).json(nextInvoice);
});

app.get('/api/invoices/:invoiceNo', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const invoices = readData('invoices.json');
  const invoice = invoices.find((inv) => {
    const matchesInvoice = String(inv.invoiceNo).trim().toLowerCase() === String(req.params.invoiceNo).trim().toLowerCase();
    if (!matchesInvoice || inv._storeType !== storeType) return false;
    if (storeId && inv._storeId !== undefined && inv._storeId !== storeId) return false;
    if (canViewStoreData(req)) return true;
    return inv._userEmail === email;
  });
  if (!invoice) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  res.json(invoice);
});

app.get('/api/customer-credits', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const customers = readData('customerCredits.json');
  const visible = canViewStoreData(req)
    ? customers.filter((customer) => matchesStoreScope(customer, storeType, storeId))
    : filterByUser(customers, storeType, email, storeId);
  res.json(visible);
});

app.post('/api/customer-credits', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const customer = req.body;
  if (!customer || !customer.name || customer.amount === undefined) {
    return res.status(400).json({ error: 'Invalid customer payload' });
  }
  const customers = readData('customerCredits.json');
  const nextCustomer = {
    id: Date.now(),
    ...customer,
    amount: Number(customer.amount),
    note: customer.note || "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _storeType: storeType,
    _storeId: storeId || storeType,
    _userEmail: email,
  };
  customers.push(nextCustomer);
  writeData('customerCredits.json', customers);
  res.status(201).json(nextCustomer);
});

app.put('/api/customer-credits/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const customers = readData('customerCredits.json');
  const index = customers.findIndex((c) => String(c.id) === String(req.params.id) && c._storeType === storeType && c._userEmail === email);
  if (index === -1) {
    return res.status(404).json({ error: 'Customer credit not found' });
  }
  const updated = {
    ...customers[index],
    ...req.body,
    amount: Number(req.body.amount || customers[index].amount),
    updatedAt: new Date().toISOString(),
  };
  customers[index] = updated;
  writeData('customerCredits.json', customers);
  res.json(updated);
});

app.delete('/api/customer-credits/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const customers = readData('customerCredits.json');
  const filtered = customers.filter((c) => !(String(c.id) === String(req.params.id) && c._storeType === storeType && c._userEmail === email));
  writeData('customerCredits.json', filtered);
  res.json({ success: true });
});

app.get('/api/orders', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const { type } = req.query;
  const orders = readData('orders.json');
  let filtered = canViewStoreData(req)
    ? orders.filter((order) => matchesStoreScope(order, storeType, storeId))
    : orders.filter((order) => matchesStoreScope(order, storeType, storeId) && order._userEmail === email);
  if (type) {
    filtered = filtered.filter((order) => order.type === String(type));
  }
  res.json(filtered);
});

app.post('/api/orders', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const order = req.body;
  if (!order || !order.type) {
    return res.status(400).json({ error: 'Invalid order payload' });
  }
  const orders = readData('orders.json');
  const nextOrder = {
    id: Date.now(),
    ...order,
    status: order.status || 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _storeType: storeType,
    _storeId: storeId || storeType,
    _userEmail: email,
  };
  orders.push(nextOrder);
  writeData('orders.json', orders);
  res.status(201).json(nextOrder);
});

app.put('/api/orders/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const orders = readData('orders.json');
  const index = orders.findIndex((o) => String(o.id) === String(req.params.id) && o._storeType === storeType && o._userEmail === email);
  if (index === -1) {
    return res.status(404).json({ error: 'Order not found' });
  }
  const updated = {
    ...orders[index],
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  orders[index] = updated;
  writeData('orders.json', orders);
  res.json(updated);
});

app.delete('/api/orders/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const orders = readData('orders.json');
  const filtered = orders.filter((order) => !(String(order.id) === String(req.params.id) && order._storeType === storeType && order._userEmail === email));
  writeData('orders.json', filtered);
  res.json({ success: true });
});

app.get('/api/expenses', (req, res) => {
  const { storeType, email, storeId } = getUserMeta(req);
  const expenses = readData('expenses.json');
  const visible = canViewStoreData(req)
    ? expenses.filter((expense) => matchesStoreScope(expense, storeType, storeId))
    : expenses.filter((expense) => matchesStoreScope(expense, storeType, storeId) && expense._userEmail === email);
  res.json(visible);
});

app.post('/api/expenses', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const expense = req.body;
  if (!expense || !expense.description || expense.amount === undefined) {
    return res.status(400).json({ error: 'Invalid expense payload' });
  }
  const expenses = readData('expenses.json');
  const nextExpense = {
    id: Date.now(),
    description: expense.description,
    category: expense.category || 'Other',
    amount: Number(expense.amount),
    date: expense.date || new Date().toISOString().split('T')[0],
    notes: expense.notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    _storeType: storeType,
    _storeId: storeId || storeType,
    _userEmail: email,
  };
  expenses.push(nextExpense);
  writeData('expenses.json', expenses);
  res.status(201).json(nextExpense);
});

app.put('/api/expenses/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const expenses = readData('expenses.json');
  const index = expenses.findIndex((expense) => String(expense.id) === String(req.params.id) && expense._storeType === storeType && expense._userEmail === email);
  if (index === -1) {
    return res.status(404).json({ error: 'Expense not found' });
  }
  const updated = {
    ...expenses[index],
    ...req.body,
    amount: Number(req.body.amount || expenses[index].amount),
    updatedAt: new Date().toISOString(),
  };
  expenses[index] = updated;
  writeData('expenses.json', expenses);
  res.json(updated);
});

app.delete('/api/expenses/:id', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const expenses = readData('expenses.json');
  const filtered = expenses.filter((expense) => !(String(expense.id) === String(req.params.id) && expense._storeType === storeType && expense._userEmail === email));
  writeData('expenses.json', filtered);
  res.json({ success: true });
});

app.put('/api/invoices/:invoiceNo', (req, res) => {
  const { storeType, email } = getUserMeta(req);
  const invoices = readData('invoices.json');
  const index = invoices.findIndex(
    (inv) =>
      String(inv.invoiceNo).trim().toLowerCase() === String(req.params.invoiceNo).trim().toLowerCase() &&
      inv._storeType === storeType &&
      inv._userEmail === email
  );
  if (index === -1) {
    return res.status(404).json({ error: 'Invoice not found' });
  }
  const updated = {
    ...invoices[index],
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  invoices[index] = updated;
  writeData('invoices.json', invoices);
  res.json(updated);
});

app.get('/api/store-settings', (req, res) => {
  const settings = readData('storeSettings.json', {});
  res.json(settings);
});

app.post('/api/store-settings', (req, res) => {
  const settings = req.body;
  writeData('storeSettings.json', settings || {});
  res.json(settings);
});

app.use(express.static(path.join(__dirname, '..', 'build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
