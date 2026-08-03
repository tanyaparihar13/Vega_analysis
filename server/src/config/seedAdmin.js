/**
 * Admin bootstrap.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ------------------------------------------------------------------------
 * There was no way to create an admin account. `POST /api/auth/register`
 * hardcodes `role 'free'` (controllers/authController.js), and no schema file
 * seeded one. The result on a fresh install — confirmed on this database —
 * was a single user literally named "Admin" sitting at role='free':
 *
 *     id=1  email='admin@vegaanalysis.com'  role='free'
 *
 * That one row is what broke the whole product:
 *   - /admin bounced to /dashboard          (ProtectedRoute roles={['admin']})
 *   - /api/admin/*        -> 403            (authorize('admin'))
 *   - /api/zerodha/*      -> 403            -> no Kite session could ever be made
 *   - every chain/greeks/vega route -> 403  (requirePremium rejects 'free')
 *   - the /ws/market upgrade -> 403         (websocketService)
 * and therefore no ticks, no instruments, no option chain, and no vega series.
 *
 * This runs at boot (and via `npm run seed:admin`) and guarantees exactly one
 * known-good admin exists.
 *
 * IDEMPOTENT BY DESIGN:
 *   - user missing  -> create with a bcrypt hash of ADMIN_PASSWORD
 *   - user exists   -> promote role to 'admin' and reactivate; the existing
 *                      password is LEFT ALONE unless ADMIN_RESET_PASSWORD=true
 *
 * Not resetting the password on every boot is deliberate: you already know the
 * password for the account you have been logging in with, and silently
 * rewriting it on each nodemon restart would lock you out of your own app.
 */

'use strict';

const bcrypt = require('bcryptjs');
const db = require('./db');
require('dotenv').config();

const DEFAULT_EMAIL = 'admin@vegaanalysis.com';

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.verbose=true]
 * @returns {Promise<{action:string, email:string}|null>}
 */
async function run({ verbose = true } = {}) {
  const log = verbose ? console.log : () => {};

  const email = (process.env.ADMIN_EMAIL || DEFAULT_EMAIL).trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const resetPassword = String(process.env.ADMIN_RESET_PASSWORD || '').toLowerCase() === 'true';

  try {
    const [rows] = await db.query(
      'SELECT id, role, is_active FROM users WHERE email = :email',
      { email }
    );

    // ---- Existing account: promote in place -------------------------------
    if (rows.length) {
      const user = rows[0];
      const alreadyGood = user.role === 'admin' && user.is_active === 1;

      if (alreadyGood && !resetPassword) {
        log(`[SeedAdmin] ✓ Admin already configured: ${email}`);
        return { action: 'unchanged', email };
      }

      if (resetPassword) {
        if (!password) {
          console.warn('[SeedAdmin] ADMIN_RESET_PASSWORD=true but ADMIN_PASSWORD is empty — password left unchanged.');
        } else {
          const hash = await bcrypt.hash(password, 12);
          await db.query(
            'UPDATE users SET password_hash = :hash WHERE id = :id',
            { hash, id: user.id }
          );
          log(`[SeedAdmin] Password reset for ${email}`);
        }
      }

      await db.query(
        "UPDATE users SET role = 'admin', is_active = 1 WHERE id = :id",
        { id: user.id }
      );

      log(`[SeedAdmin] ✓ Promoted ${email} to admin (was role='${user.role}', active=${user.is_active})`);
      return { action: 'promoted', email };
    }

    // ---- No account yet: create one ---------------------------------------
    if (!password) {
      console.warn(
        `[SeedAdmin] No admin exists and ADMIN_PASSWORD is not set in server/.env — ` +
        `cannot create ${email}. Set ADMIN_EMAIL + ADMIN_PASSWORD and run: npm run seed:admin`
      );
      return null;
    }

    const hash = await bcrypt.hash(password, 12);
    const [result] = await db.query(
      `INSERT INTO users (name, email, password_hash, role, is_active)
       VALUES (:name, :email, :hash, 'admin', 1)`,
      { name: process.env.ADMIN_NAME || 'Admin', email, hash }
    );

    log(`[SeedAdmin] ✓ Created admin account ${email} (id=${result.insertId})`);
    return { action: 'created', email };
  } catch (err) {
    // Never fatal. A DB hiccup at boot should not stop the API from serving.
    console.error('[SeedAdmin] Failed:', err.message);
    return null;
  }
}

// Direct invocation: `npm run seed:admin`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[SeedAdmin] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
