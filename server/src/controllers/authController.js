const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../config/db');
const mailService = require('../services/mailService');
const notificationService = require('../services/notificationService');
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

/* ==========================================================================
   ONBOARDING — step 2 of registration
   --------------------------------------------------------------------------
   Registration no longer ends at WhatsApp. It creates the account, then sends
   the user to /onboarding to declare HOW they intend to get access. That choice
   is what goes to the admin, because "someone registered" is not actionable
   while "someone wants to pay ₹4,999" is.

   ONE TABLE OF TRUTH. These three keys are the `selected_option` ENUM in
   schema.onboarding.sql, the `option` accepted by selectOnboardingOption below,
   and the buttons rendered by client/src/pages/Onboarding.jsx. A key added in
   one place and not the others fails at the ENUM, which is the loudest of the
   available failure modes and therefore the right one.

   `brokerChoice` writes to user_onboarding.broker_choice ONLY. It never touches
   users.broker — that column holds the demat broker the user declared at
   registration, which is a different fact and must survive this step. See the
   note in selectOnboardingOption().
   ========================================================================== */
const ONBOARDING_OPTIONS = {
  lifetime: {
    key: 'lifetime',
    label: 'Lifetime Access',
    message: 'I am ready to pay for Lifetime Access',
    priceInr: 4999,
    paymentIntent: 'lifetime',
    brokerChoice: null,
  },
  dhan: {
    key: 'dhan',
    label: 'Open an account with Dhan',
    message: 'I am ready to open an account with Dhan',
    priceInr: null,
    paymentIntent: null,
    brokerChoice: 'dhan',
  },
  angel_one: {
    key: 'angel_one',
    label: 'Open an account with Angel One',
    message: 'I am ready to open an account with Angel One',
    priceInr: null,
    paymentIntent: null,
    brokerChoice: 'angel_one',
  },
};

const ONBOARDING_TOKEN_TTL = '30m';

/**
 * A token that proves "the bearer just registered as user N", and nothing else.
 *
 * It exists because the account it identifies is status='pending' and therefore
 * CANNOT log in — so there is no session to authorise step 2 with, and reading a
 * userId out of the request body would let anyone write a selection against any
 * account.
 *
 * Carries no role and no status, so it cannot be mistaken for a session, and
 * middleware/auth.js `authenticate` explicitly rejects anything with a `scope`
 * claim. Short-lived because it only has to survive one page transition.
 */
function signOnboardingToken(userId) {
  return jwt.sign(
    { id: userId, scope: 'onboarding' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.ONBOARDING_TOKEN_TTL || ONBOARDING_TOKEN_TTL }
  );
}

/**
 * The WhatsApp handoff for a completed onboarding selection.
 *
 * Same click-to-chat mechanism as before (https://wa.me/...), for the same
 * reasons: it only OPENS a chat with the text prefilled, the user presses Send
 * themselves, nothing is transmitted on their behalf, and no Business API
 * credentials, Meta approval or per-message cost are involved.
 *
 * Carries exactly the fields the brief specifies — Name, Mobile, Email,
 * registration date and time, the selected option, and the User ID.
 *
 * STILL NO PASSWORD, EVER. It is bcrypt-hashed at cost 12 the moment it arrives
 * and never exists in plaintext afterwards. A WhatsApp thread is a plaintext log
 * on two phones and a cloud backup.
 */
function buildOnboardingWhatsAppUrl({ name, email, mobile, broker, userId, option, registeredAt }) {
  const number = String(process.env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  if (!number) return null;

  const opt = ONBOARDING_OPTIONS[option];
  const selection = opt
    ? `${opt.message}${opt.priceInr ? ` — ₹${opt.priceInr.toLocaleString('en-IN')}` : ''}`
    : '—';

  const text =
    `Hello, I have registered on Vega Analysis.\n\n`
    + `Name: ${name}\n`
    + `Mobile: ${mobile || '-'}\n`
    + `Email: ${email}\n`
    // The broker they ALREADY hold, from the registration form — distinct from
    // the Selected Option below, which is what they are willing to do next.
    + `Demat Broker: ${BROKERS[broker] || '-'}\n`
    + `User ID: ${userId}\n`
    + `Registered: ${istTimestamp(registeredAt ? new Date(registeredAt) : new Date())} IST\n\n`
    + `Selected Option: ${selection}\n\n`
    + `Status: Pending approval`;

  return `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
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
 * STEP 1 OF TWO. Creates the account and a pending onboarding record, then hands
 * back a scoped token so the client can move to /onboarding and declare which
 * access route it wants.
 *
 * WHAT CHANGED, AND WHY IT MATTERS
 *   · WhatsApp is NOT opened here any more. It opens once the user has chosen an
 *     option on /onboarding, so the admin receives an actionable lead ("wants
 *     Lifetime Access") rather than a bare "someone signed up".
 *   · `confirmPassword` is checked SERVER-SIDE. The form checks it too, but a
 *     form check is a convenience; this is the one that decides.
 *
 * THE DEMAT BROKER IS COLLECTED HERE, and it is a DIFFERENT FACT from the
 * onboarding choice. This one answers "which broker do you already trade
 * through?" (Zerodha / Dhan / Upstox / Groww / Angel One) and lands in
 * users.broker. The onboarding step answers "how do you want to get access?"
 * and lands in user_onboarding.broker_choice. A user can legitimately hold a
 * Zerodha account today AND be willing to open a Dhan account for access, so
 * the two are stored separately and neither overwrites the other.
 *
 * Returns NO SESSION JWT. A pending account cannot log in, so handing back a
 * real token would make the approval gate decorative. The onboarding token it
 * does return is scope-limited and rejected by `authenticate`.
 */
async function register(req, res) {
  let conn;
  try {
    const { name, email, password, confirmPassword } = req.body;
    // The form labels this "Mobile"; the column has always been `phone`.
    const mobile = req.body.mobile ?? req.body.phone ?? null;
    const broker = req.body.broker ? String(req.body.broker).toLowerCase() : null;

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email and password are required' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return res.status(400).json({ message: passwordError });
    }
    // Only enforced when the client sent the field, so an existing integration
    // that posts {name,email,password,mobile} keeps working unchanged.
    if (confirmPassword != null && confirmPassword !== password) {
      return res.status(400).json({ message: 'Passwords do not match.' });
    }
    if (!mobile) {
      return res.status(400).json({ message: 'mobile number is required' });
    }
    if (!broker) {
      return res.status(400).json({ message: 'demat broker is required' });
    }
    /**
     * Whitelisted BEFORE it reaches SQL. Without this an unknown value hits the
     * `broker` ENUM and MySQL either truncates it to '' or errors depending on
     * strict mode — both of which surface as an opaque 500 to someone signing
     * up. The BROKERS map and the ENUM in schema.sql must agree.
     */
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

    /**
     * ONE TRANSACTION.
     *
     * A user row without its onboarding row is invisible to the admin's
     * Onboarding tab — the funnel would have no record of them and nobody would
     * ever chase the lead. Committing both together means that cannot happen.
     */
    conn = await db.getConnection();
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO users (name, email, password_hash, phone, broker, role, is_active, status)
       VALUES (:name, :email, :passwordHash, :phone, :broker, 'free', 1, 'pending')`,
      { name, email, passwordHash, phone: mobile, broker }
    );

    await conn.query(
      `INSERT INTO user_onboarding (user_id, registration_source)
       VALUES (:userId, 'web')
       ON DUPLICATE KEY UPDATE user_id = user_id`,
      { userId: result.insertId }
    );

    await conn.commit();

    res.status(201).json({
      status: 'pending',
      message: 'Account created. Choose how you would like to get access.',
      user: {
        id: result.insertId,
        name,
        email,
        mobile,
        broker,
        brokerLabel: BROKERS[broker],
        status: 'pending',
        accountType: accountTypeLabel('free', 'pending'),
      },
      // Step 2's credential. Held in memory / sessionStorage by the client —
      // never localStorage, where it would outlive the tab it belongs to.
      onboardingToken: signOnboardingToken(result.insertId),
      nextStep: '/onboarding',
    });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[register] error:', err.message);
    res.status(500).json({ message: 'Registration failed' });
  } finally {
    if (conn) conn.release();
  }
}

/**
 * GET /api/auth/onboarding/options   (public)
 *
 * The three choices and their prices, served rather than hardcoded in the
 * bundle, so the price shown on the button and the price written to
 * user_onboarding.price_inr are the same number from the same place.
 */
function onboardingOptions(req, res) {
  res.json({
    options: Object.values(ONBOARDING_OPTIONS).map((o) => ({
      key: o.key,
      label: o.label,
      message: o.message,
      priceInr: o.priceInr,
    })),
  });
}

/**
 * POST /api/auth/onboarding/select   (onboarding token)
 * Body: { option: 'lifetime' | 'dhan' | 'angel_one' }
 *
 * STEP 2 OF TWO. Records the choice, mirrors the broker onto the user row,
 * raises an admin notification, and returns the prefilled WhatsApp link.
 *
 * IDEMPOTENT BY DESIGN. A double-click, a retry after a flaky connection, or a
 * user going back and choosing again all land here; the row is updated in place
 * (one row per user, enforced by uq_onboarding_user) and the notification is
 * only raised when the selection actually CHANGES. Without that guard, an
 * impatient double-click would put two identical leads in front of the admin.
 */
async function selectOnboardingOption(req, res) {
  try {
    const userId = req.onboarding.userId;
    const key = String(req.body.option || '').toLowerCase();
    const option = ONBOARDING_OPTIONS[key];

    if (!option) {
      return res.status(400).json({
        message: `option must be one of: ${Object.keys(ONBOARDING_OPTIONS).join(', ')}`,
      });
    }

    const [rows] = await db.query(
      `SELECT u.id, u.name, u.email, u.phone, u.broker, u.created_at, o.selected_option
         FROM users u
         LEFT JOIN user_onboarding o ON o.user_id = u.id
        WHERE u.id = :userId`,
      { userId }
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ message: 'Account not found' });

    const isChange = user.selected_option !== option.key;

    await db.query(
      `INSERT INTO user_onboarding
         (user_id, registration_source, selected_option, payment_intent, broker_choice,
          price_inr, selected_at, payment_status, broker_status)
       VALUES (:userId, 'web', :selected, :intent, :broker, :price, NOW(), :paymentStatus, :brokerStatus)
       ON DUPLICATE KEY UPDATE
         selected_option = VALUES(selected_option),
         payment_intent  = VALUES(payment_intent),
         broker_choice   = VALUES(broker_choice),
         price_inr       = VALUES(price_inr),
         selected_at     = VALUES(selected_at),
         payment_status  = VALUES(payment_status),
         broker_status   = VALUES(broker_status)`,
      {
        userId,
        selected: option.key,
        intent: option.paymentIntent,
        broker: option.brokerChoice,
        price: option.priceInr,
        // Choosing an option is what puts the lead into the queue the admin
        // works from; 'none' would leave a chosen lead looking unstarted.
        paymentStatus: option.paymentIntent ? 'pending' : 'none',
        brokerStatus: option.brokerChoice ? 'pending' : 'none',
      }
    );

    /**
     * users.broker IS DELIBERATELY NOT TOUCHED HERE.
     *
     * An earlier revision mirrored the onboarding choice onto it. That was
     * wrong once the registration form collects a demat broker again: a user
     * who registers with Zerodha and then offers to open a Dhan account would
     * have their real, existing broker silently overwritten with 'dhan', and
     * the admin would lose the very fact they need to know before calling.
     *
     * Two columns, two questions:
     *   users.broker                    which broker they ALREADY trade through
     *   user_onboarding.broker_choice   which account they are willing to OPEN
     */

    if (isChange) {
      await notificationService.create({
        type: 'onboarding.selected',
        title: `${user.name} chose: ${option.label}`,
        body: `${user.email} · ${user.phone || 'no mobile'}`
          + `${option.priceInr ? ` · ₹${option.priceInr.toLocaleString('en-IN')}` : ''}`,
        userId,
        payload: {
          option: option.key,
          label: option.label,
          priceInr: option.priceInr,
          name: user.name,
          email: user.email,
          mobile: user.phone,
        },
      });
    }

    res.json({
      ok: true,
      selectedOption: option.key,
      label: option.label,
      priceInr: option.priceInr,
      message: 'Your choice has been recorded.',
      whatsappUrl: buildOnboardingWhatsAppUrl({
        name: user.name,
        email: user.email,
        mobile: user.phone,
        broker: user.broker,
        userId,
        option: option.key,
        registeredAt: user.created_at,
      }),
    });
  } catch (err) {
    console.error('[selectOnboardingOption] error:', err.message);
    res.status(500).json({ message: 'Could not record your choice. Please try again.' });
  }
}

/**
 * POST /api/auth/onboarding/whatsapp-opened   (onboarding token)
 *
 * Best-effort funnel telemetry: the client calls this when it opens the wa.me
 * link. It records that the handoff was ATTEMPTED — it cannot know whether the
 * user actually pressed Send, which is why the column distinguishes 'opened'
 * from 'confirmed' and only an admin can set the latter.
 */
async function markWhatsappOpened(req, res) {
  try {
    await db.query(
      `UPDATE user_onboarding
          SET whatsapp_status = 'opened', whatsapp_opened_at = NOW()
        WHERE user_id = :userId AND whatsapp_status = 'not_sent'`,
      { userId: req.onboarding.userId }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[markWhatsappOpened] error:', err.message);
    res.status(500).json({ message: 'Could not update onboarding status' });
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
  // Onboarding (step 2 of registration)
  onboardingOptions, selectOnboardingOption, markWhatsappOpened,
  ONBOARDING_OPTIONS, buildOnboardingWhatsAppUrl, signOnboardingToken,
  // Exported so the route layer and any future caller share one definition of
  // "an acceptable password" rather than re-deriving it.
  validatePassword, PASSWORD_MIN,
};
