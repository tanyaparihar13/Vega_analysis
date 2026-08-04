const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const mailService = require('../services/mailService');
require('dotenv').config();

/**
 * Password policy, in one place.
 *
 * The SAME rules are mirrored in client/src/components/auth/PasswordStrength.jsx
 * so the strength meter can never say "Strong" about a password the server is
 * about to reject. If you change one, change the other.
 *
 * Enforced on registration and on password reset. Existing stored passwords are
 * untouched — this gates what can be SET, not who can log in, so nobody is
 * locked out of an account they already have.
 */
const PASSWORD_MIN = 8;

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > 200) {
    // bcrypt only reads the first 72 bytes; the cap is here to stop a
    // multi-megabyte string burning CPU in the hash round.
    return 'Password must be 200 characters or fewer.';
  }
  if (!/[a-zA-Z]/.test(password)) return 'Password must include at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must include at least one number.';
  return null;
}

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
 * Builds the prefilled WhatsApp handoff link carrying the new registration to
 * the administrator.
 *
 * Deliberately NOT the WhatsApp Business API — this is the documented
 * click-to-chat URL. It only OPENS a chat with the message typed in; the user
 * still presses Send themselves, so nothing is sent on their behalf and no
 * API credentials, Meta approval or per-message cost are involved.
 *
 * NO PASSWORD, EVER. The message carries identity and account metadata only.
 * The password is bcrypt-hashed at cost 12 the moment it arrives and is never
 * held in plaintext beyond that one function call — it is not logged, not
 * returned in the response, and not put in this message. A WhatsApp thread is
 * a plaintext log sitting on two phones and a backup; nothing secret goes in.
 */
function buildWhatsAppUrl({ name, email, mobile, broker, userId, accountType }) {
  const number = String(process.env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (!number) return null;

  const text =
    `Hello, I have registered on Vega Analysis and would like my account approved.\n\n` +
    `Name: ${name}\n` +
    `Email: ${email}\n` +
    `Mobile: ${mobile || '-'}\n` +
    `Demat Broker: ${BROKERS[broker] || '-'}\n` +
    (userId ? `User ID: ${userId}\n` : '') +
    `Account Type: ${accountType || 'Free'}\n` +
    `Registered: ${istTimestamp()} IST\n\n` +
    `Status: Pending approval`;

  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
}

/**
 * How a new account is described to the admin.
 *
 * Registration always creates role 'free' / status 'pending' (see `register`),
 * so this is derived rather than guessed — if that ever changes, the message
 * changes with it instead of quietly lying.
 */
function accountTypeLabel(role = 'free', status = 'pending') {
  const tier = role === 'admin' ? 'Admin' : role === 'premium' ? 'Premium' : 'Free';
  return status === 'approved' ? tier : `${tier} (pending approval)`;
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
    // Server-side password policy. The form checks the same rules for feedback,
    // but a form check is a convenience, not a control — this is the one that
    // actually decides.
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
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

    const accountType = accountTypeLabel('free', 'pending');

    res.status(201).json({
      status: 'pending',
      message: 'Registration received. An administrator must approve your account before you can sign in.',
      user: {
        id: result.insertId, name, email, mobile,
        broker, brokerLabel: BROKERS[broker], status: 'pending',
        accountType,
      },
      whatsappUrl: buildWhatsAppUrl({
        name, email, mobile, broker, userId: result.insertId, accountType,
      }),
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

/* ==========================================================================
   PASSWORD RESET
   --------------------------------------------------------------------------
   Standard emailed-link flow, which is the only design that actually proves
   the requester controls the account:

     1. POST /forgot-password  { identifier }   email OR registered phone
        -> looks up the account, mints a random token, stores its SHA-256,
           emails the raw token as a link to the account's REGISTERED address.
     2. GET  /reset-password/:token/validate
        -> lets the page say "this link has expired" before the user types a
           new password twice for nothing.
     3. POST /reset-password  { token, password }
        -> re-checks the token, bcrypts the new password, marks the token used.

   FIVE THINGS THIS GETS RIGHT, each of which is a real attack if skipped:

   · The token is emailed, never returned in the HTTP response. Returning it
     would mean anyone who can type an email address owns that account.
   · Only the SHA-256 is stored, so a database dump yields no usable tokens.
   · Single use and 30 minutes. Requesting a new link invalidates outstanding
     ones, so a forwarded old email is inert.
   · The response never reveals whether an account exists. Same message, same
     shape, whether or not the address is registered — otherwise this endpoint
     is a free account-enumeration oracle.
   · The link always goes to the address ON THE ACCOUNT. Looking up by phone is
     a convenience for the user; it never redirects delivery.
   ========================================================================== */

const RESET_TOKEN_TTL_MINUTES = 30;

/** The response every /forgot-password call gets, found or not. */
const RESET_GENERIC_RESPONSE = {
  message:
    'If an account matches those details, a password reset link has been sent to its '
    + 'registered email address. The link is valid for 30 minutes.',
};

const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');

/** Where the emailed link points. CLIENT_URL is already used for CORS. */
function buildResetUrl(token) {
  const base = String(process.env.CLIENT_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${base}/reset-password/${token}`;
}

/**
 * POST /api/auth/forgot-password   (public)
 * Body: { identifier }  — an email address or a registered mobile number.
 */
async function forgotPassword(req, res) {
  try {
    const identifier = String(req.body.identifier || '').trim();
    if (!identifier) {
      return res.status(400).json({ message: 'Enter your email address or mobile number.' });
    }

    /**
     * Configuration is checked BEFORE the lookup and answered honestly.
     *
     * This is the one case where the generic response would be actively
     * harmful: telling someone "check your inbox" when no mail can be sent
     * leaves them waiting for an email that will never arrive. A misconfigured
     * server is the operator's problem to see, not a secret to keep.
     */
    if (!mailService.isConfigured()) {
      return res.status(503).json({
        message:
          'Password reset by email is not available right now. Please contact the '
          + 'administrator on WhatsApp to have your password reset.',
        code: 'RESET_EMAIL_UNAVAILABLE',
      });
    }

    // An address contains '@'; anything else is treated as a phone number and
    // compared on digits only, so "+91 98765 43210" matches a stored
    // "9876543210".
    const isEmail = identifier.includes('@');
    const [rows] = isEmail
      ? await db.query(
          'SELECT id, name, email, is_active FROM users WHERE email = :email LIMIT 1',
          { email: identifier }
        )
      : await db.query(
          `SELECT id, name, email, is_active FROM users
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '')
                  LIKE CONCAT('%', :digits)
            LIMIT 1`,
          { digits: identifier.replace(/\D/g, '') }
        );

    const user = rows[0];

    // Deactivated accounts get the same silence as unknown ones. A reset must
    // not be a way to find out that an address is registered but switched off.
    if (!user || !user.is_active) {
      return res.json(RESET_GENERIC_RESPONSE);
    }

    // Outstanding links die the moment a new one is asked for.
    await db.query(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = :id AND used_at IS NULL',
      { id: user.id }
    );

    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at, requested_ip)
       VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL :ttl MINUTE), :ip)`,
      {
        userId: user.id,
        tokenHash: sha256(token),
        ttl: RESET_TOKEN_TTL_MINUTES,
        ip: req.ip || null,
      }
    );

    try {
      await mailService.sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl: buildResetUrl(token),
        expiresMinutes: RESET_TOKEN_TTL_MINUTES,
      });
    } catch (mailErr) {
      // The token is already stored, so leaving it live after a failed send
      // would be a valid reset nobody can use and an attacker might guess at.
      await db.query(
        'UPDATE password_resets SET used_at = NOW() WHERE user_id = :id AND used_at IS NULL',
        { id: user.id }
      );
      console.error('[forgotPassword] send failed:', mailErr.message);
      return res.status(502).json({
        message: 'We could not send the reset email just now. Please try again shortly.',
      });
    }

    res.json(RESET_GENERIC_RESPONSE);
  } catch (err) {
    console.error('[forgotPassword] error:', err.message);
    res.status(500).json({ message: 'Could not process the request' });
  }
}

/** Looks up a live, unused, unexpired token. Returns the row or null. */
async function findLiveToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [rows] = await db.query(
    `SELECT pr.id, pr.user_id, u.email, u.name
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = :tokenHash
        AND pr.used_at IS NULL
        AND pr.expires_at > NOW()
        AND u.is_active = 1
      LIMIT 1`,
    { tokenHash: sha256(token) }
  );
  return rows[0] || null;
}

/**
 * GET /api/auth/reset-password/:token/validate   (public)
 *
 * Returns only whether the link is usable. Deliberately not the email address
 * it belongs to: anyone holding the link can already reset the account, but
 * echoing the address would turn a stolen link into a disclosed identity too.
 */
async function validateResetToken(req, res) {
  try {
    const row = await findLiveToken(req.params.token);
    res.json({ valid: !!row });
  } catch (err) {
    console.error('[validateResetToken] error:', err.message);
    res.status(500).json({ message: 'Could not validate the reset link' });
  }
}

/**
 * POST /api/auth/reset-password   (public)
 * Body: { token, password }
 *
 * Returns NO JWT on success, and that is intentional. Approval is a separate
 * gate from authentication: a pending, rejected or blocked user can legitimately
 * reset a forgotten password, but must not be signed in by having done so. The
 * client sends them to /login, where the existing status checks apply exactly as
 * they always have.
 */
async function resetPassword(req, res) {
  try {
    const { token, password } = req.body;

    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ message: passwordError });

    const row = await findLiveToken(token);
    if (!row) {
      return res.status(400).json({
        message: 'This reset link is invalid or has expired. Please request a new one.',
        code: 'RESET_TOKEN_INVALID',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await db.query(
      'UPDATE users SET password_hash = :passwordHash WHERE id = :id',
      { passwordHash, id: row.user_id }
    );

    // Consume this token and any sibling still outstanding, so a second link
    // from an earlier request cannot be replayed after the password changed.
    await db.query(
      'UPDATE password_resets SET used_at = NOW() WHERE user_id = :id AND used_at IS NULL',
      { id: row.user_id }
    );

    res.json({
      message: 'Your password has been updated. You can now sign in with your new password.',
    });
  } catch (err) {
    console.error('[resetPassword] error:', err.message);
    res.status(500).json({ message: 'Could not reset the password' });
  }
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

module.exports = {
  register, login, adminLogin, me, publicConfig, buildWhatsAppUrl, BROKERS,
  forgotPassword, validateResetToken, resetPassword,
  // Exported so the route layer and any future caller share one definition of
  // "an acceptable password" rather than re-deriving it.
  validatePassword, PASSWORD_MIN,
};
