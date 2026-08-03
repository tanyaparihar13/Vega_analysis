const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
require('dotenv').config();

/**
 * `status` travels in the token alongside `role`.
 *
 * Access is granted by ADMIN APPROVAL, not by the legacy free/premium tier —
 * see middleware/auth.js requirePremium. The gate therefore needs the approval
 * state on every request, and re-reading the users row on each call just to
 * learn it would put a query in front of every endpoint.
 *
 * Consequence worth knowing: a JWT is immutable once signed, so changing a
 * user's role or status in the database does NOT affect tokens already issued.
 * They pick up the change on their next login (or when the token expires,
 * JWT_EXPIRES_IN).
 */
function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, status: user.status },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '1d' }
  );
}

async function recordLogin(userId, req, success = true) {
  await db.query(
    `INSERT INTO login_history (user_id, ip_address, user_agent, success)
     VALUES (:userId, :ip, :ua, :success)`,
    {
      userId,
      ip: req.ip,
      ua: req.headers['user-agent'] || null,
      success,
    }
  );
}

/**
 * Demat brokers offered on the registration form.
 *
 * Keys are what gets stored; labels are what the WhatsApp message shows. This
 * list MUST stay in sync with the `broker` ENUM in schema.sql — a key here that
 * the column does not accept makes the INSERT fail at registration time.
 */
const BROKERS = {
  zerodha: 'Zerodha',
  angelone: 'Angel One',
  dhan: 'Dhan',
  upstox: 'Upstox',
  groww: 'Groww',
};

/** IST timestamp for the approval message — the admin reads it in IST. */
function istTimestamp(d = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
  }).format(d);
}

/**
 * Builds the prefilled WhatsApp handoff link.
 *
 * Deliberately NOT the WhatsApp Business API — this is the documented
 * click-to-chat URL. It only OPENS a chat with the message typed in; the user
 * still presses Send themselves, so nothing is sent on their behalf and no
 * API credentials or approvals are involved.
 */
function buildWhatsAppUrl({ name, email, mobile, broker }) {
  const number = String(process.env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (!number) return null;

  const text =
    `Hello, I have registered on Vega Analysis and would like my account approved.\n\n` +
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `Mobile: ${mobile || '-'}\n` +
    `Demat Broker: ${BROKERS[broker] || '-'}\n` +
    `Registered: ${istTimestamp()} IST\n\n` +
    `Status: Pending approval`;

  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/**
 * POST /api/auth/register  (public — always role 'free', status 'pending')
 *
 * Returns NO JWT. A pending account cannot log in, so handing back a token
 * would let a brand-new signup straight into the dashboard and make the whole
 * approval gate decorative.
 */
async function register(req, res) {
  try {
    const { name, email, password } = req.body;
    // The form labels this "Mobile"; the column has always been `phone`.
    const mobile = req.body.mobile ?? req.body.phone ?? null;
    const broker = req.body.broker ? String(req.body.broker).toLowerCase() : null;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    if (!mobile) {
      return res.status(400).json({ message: 'mobile number is required' });
    }
    if (!broker) {
      return res.status(400).json({ message: 'demat broker is required' });
    }
    // Whitelisted before it reaches SQL. Without this an unknown value hits the
    // ENUM and MySQL either truncates it to '' or errors, depending on strict
    // mode — both of which surface as an opaque 500 to someone signing up.
    if (!Object.prototype.hasOwnProperty.call(BROKERS, broker)) {
      return res.status(400).json({
        message: `broker must be one of: ${Object.keys(BROKERS).join(', ')}`,
      });
    }

    const [existing] = await db.query('SELECT id FROM users WHERE email = :email', { email });
    if (existing.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [result] = await db.query(
      `INSERT INTO users (name, email, password_hash, phone, broker, role, is_active, status)
       VALUES (:name, :email, :passwordHash, :phone, :broker, 'free', 1, 'pending')`,
      { name, email, passwordHash, phone: mobile, broker }
    );

    res.status(201).json({
      status: 'pending',
      message: 'Registration received. An administrator must approve your account before you can sign in.',
      user: {
        id: result.insertId, name, email, mobile,
        broker, brokerLabel: BROKERS[broker], status: 'pending',
      },
      whatsappUrl: buildWhatsAppUrl({ name, email, mobile, broker }),
    });
  } catch (err) {
    console.error('[register] error:', err.message);
    res.status(500).json({ message: 'Registration failed' });
  }
}

/**
 * Maps a non-approved status to the message the user sees. Returns null when
 * the account is allowed through.
 */
function blockedReason(status) {
  switch (status) {
    case 'approved':
      return null;
    case 'pending':
      return 'Your account is awaiting administrator approval. You will be able to sign in once it is approved.';
    case 'rejected':
      return 'Your registration was not approved. Please contact the administrator.';
    case 'blocked':
      return 'This account has been blocked. Please contact the administrator.';
    default:
      return 'This account cannot sign in. Please contact the administrator.';
  }
}

// POST /api/auth/login  (used by both free/premium users and admin)
async function login(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const [rows] = await db.query(
      'SELECT id, name, email, password_hash, role, is_active, status FROM users WHERE email = :email',
      { email }
    );
    const user = rows[0];

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }
    if (!user.is_active) {
      return res.status(403).json({ message: 'This account has been deactivated. Contact support.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await recordLogin(user.id, req, false);
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    // Approval gate — checked only AFTER the password verifies, so this cannot
    // be used to enumerate which addresses are registered.
    const blocked = blockedReason(user.status);
    if (blocked) {
      await recordLogin(user.id, req, false);
      return res.status(403).json({ message: blocked, status: user.status });
    }

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = :id', { id: user.id });
    await recordLogin(user.id, req, true);

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error('[login] error:', err.message);
    res.status(500).json({ message: 'Login failed' });
  }
}

// POST /api/auth/admin-login  (same flow, but rejects non-admin accounts)
async function adminLogin(req, res) {
  try {
    const { email, password } = req.body;
    const [rows] = await db.query(
      'SELECT id, name, email, password_hash, role, is_active, status FROM users WHERE email = :email',
      { email }
    );
    const user = rows[0];

    if (!user || user.role !== 'admin') {
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }
    if (!user.is_active) {
      return res.status(403).json({ message: 'This admin account is deactivated' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      await recordLogin(user.id, req, false);
      return res.status(401).json({ message: 'Invalid admin credentials' });
    }

    const blocked = blockedReason(user.status);
    if (blocked) {
      await recordLogin(user.id, req, false);
      return res.status(403).json({ message: blocked, status: user.status });
    }

    await db.query('UPDATE users SET last_login_at = NOW() WHERE id = :id', { id: user.id });
    await recordLogin(user.id, req, true);

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: 'admin' } });
  } catch (err) {
    console.error('[adminLogin] error:', err.message);
    res.status(500).json({ message: 'Admin login failed' });
  }
}

// GET /api/auth/me
async function me(req, res) {
  const [rows] = await db.query(
    'SELECT id, name, email, phone, broker, role, is_active, status, created_at FROM users WHERE id = :id',
    { id: req.user.id }
  );
  if (!rows[0]) return res.status(404).json({ message: 'User not found' });
  res.json({ user: rows[0] });
}

/**
 * GET /api/auth/config  (public)
 * Lets the register/pending screens build the WhatsApp link from the single
 * source of truth in .env instead of hardcoding the number in the bundle.
 */
function publicConfig(req, res) {
  const number = String(process.env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  res.json({ adminWhatsappNumber: number || null });
}

module.exports = { register, login, adminLogin, me, publicConfig, buildWhatsAppUrl, BROKERS };
