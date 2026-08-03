const crypto = require('crypto');
const { KiteConnect } = require('kiteconnect');
const db = require('../config/db');
const { encrypt, decrypt } = require('../utils/crypto');
const { nextTokenExpiry, toMysqlUtc, isExpired } = require('../utils/kiteSessionTime');
require('dotenv').config();

const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });

const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * ------------------------------------------------------------------------
 * THE "Invalid or expired OAuth state." FIX
 * ------------------------------------------------------------------------
 * The previous version kept pending states in a module-level Map:
 *
 *     const pendingStates = new Map();
 *
 * The OAuth round trip takes 20-60 seconds — you leave the app, log into
 * Kite, approve, and come back. Any Node restart inside that window empties
 * the Map, so the callback arrives carrying a state the process has never
 * seen and is rejected with exactly that message.
 *
 * Under nodemon this is not intermittent, it is guaranteed: saving any file
 * while the Kite tab is open destroys the state. It also breaks under pm2
 * cluster mode, because the callback can be routed to a different worker
 * than the one that minted the nonce.
 *
 * States now live in MySQL (see schema.instruments.sql). They survive
 * restarts, work across workers, are single-use, and expire on their own.
 * ------------------------------------------------------------------------
 */

/**
 * Drop states that have genuinely expired.
 *
 * MUST compare against Node's UTC clock, NOT MySQL's NOW().
 *
 * `expires_at` is written by this file via toMysqlUtc() — i.e. in UTC. MySQL's
 * NOW() returns the server's LOCAL time, which here is IST (UTC+5:30). The old
 * `WHERE expires_at < NOW()` therefore compared a UTC value against an IST one
 * and judged every freshly-minted state to be 5.5 hours expired:
 *
 *     created_at (MySQL NOW(), IST) : 2026-07-29 18:51:02
 *     expires_at (Node, UTC)        : 2026-07-29 13:31:02   <- "already past"
 *
 * getLoginUrl() reaps before inserting, so the state it just made survived its
 * own call — but any second connect attempt (a double-click, a page refresh, a
 * second admin tab) reaped the first one, and that callback then came back as
 * `unknown_state`. That is the intermittent "Invalid or expired OAuth state"
 * this table was introduced to eliminate.
 *
 * Comparing against the same clock that writes the column is self-consistent
 * regardless of how MySQL's timezone is configured.
 */
async function reapStates() {
  try {
    await db.query('DELETE FROM oauth_states WHERE expires_at < :nowUtc', {
      nowUtc: toMysqlUtc(new Date()),
    });
  } catch (err) {
    console.warn('[Zerodha] Could not reap OAuth states:', err.message);
  }
}

/**
 * Rehydrate the module-level KiteConnect with the stored token at boot.
 * Without this, every REST call fails after a restart until someone
 * manually reconnects.
 */
async function restoreSession() {
  try {
    const token = await getActiveAccessToken();
    kc.setAccessToken(token);
    console.log('[Zerodha] Restored access token from DB');
    return true;
  } catch (err) {
    console.warn('[Zerodha] No usable stored session:', err.message);
    return false;
  }
}

/**
 * Verifies the restored token is actually alive by making one cheap
 * authenticated call. The DB row can look perfectly valid while Kite has
 * already killed the token — logging into Kite from your phone invalidates
 * the server's token instantly, and expires_at knows nothing about it.
 *
 * Without this the server boots "connected", subscribes the ticker, and
 * takes a 403 thirty seconds later.
 */
async function verifySession() {
  try {
    const profile = await kc.getProfile();
    await db.query(
      'UPDATE zerodha_sessions SET last_verified_at = NOW() WHERE is_active = 1'
    );
    console.log(`[Zerodha] Session verified for ${profile.user_id}`);
    return { valid: true, kiteUserId: profile.user_id };
  } catch (err) {
    console.warn('[Zerodha] Stored token rejected by Kite:', err.message);
    await invalidateActiveSession();
    return { valid: false, reason: err.message };
  }
}

// GET /api/zerodha/login-url  (admin only)
async function getLoginUrl(req, res) {
  try {
    await reapStates();

    const state = crypto.randomBytes(24).toString('hex');
    const expiresAt = toMysqlUtc(new Date(Date.now() + STATE_TTL_MS));

    await db.query(
      `INSERT INTO oauth_states (state, admin_user_id, expires_at)
       VALUES (:state, :adminUserId, :expiresAt)`,
      { state, adminUserId: req.user.id, expiresAt }
    );

    /**
     * ------------------------------------------------------------------
     * Kite does NOT support a bare `state` query param.
     *
     * The previous line was:
     *     `${kc.getLoginURL()}&state=${state}`
     * Kite silently drops any unrecognised param, so the redirect came
     * back as:
     *     ?action=login&type=login&status=success&request_token=XXXX
     * with no state at all — and the callback rejected every single login.
     *
     * The documented mechanism is `redirect_params`: a URL-encoded query
     * string that Kite appends verbatim to the redirect URL. So we encode
     * `state=<nonce>` into it and Kite hands it back as a real `state`
     * param on the callback.
     *
     * Docs: https://kite.trade/docs/connect/v3/user/
     * ------------------------------------------------------------------
     */
    const redirectParams = encodeURIComponent(`state=${state}`);
    const loginUrl = `${kc.getLoginURL()}&redirect_params=${redirectParams}`;

    res.json({ loginUrl, state, expiresInMs: STATE_TTL_MS });
  } catch (err) {
    console.error('[zerodha/login-url] error:', err.message);
    res.status(500).json({ message: 'Could not start the Zerodha login flow' });
  }
}

// GET /api/zerodha/callback  (unauthenticated by necessity — it is Kite's redirect)
async function callback(req, res) {
  const { request_token: requestToken, state, status: kiteStatus } = req.query;

  /**
   * Log exactly what Kite sent before any branch can return.
   *
   * Two of the four 400 paths below used to return silently, which made a
   * failed callback indistinguishable from a working one in the log. The
   * request_token is truncated — it is a live credential for a few minutes
   * and should not sit in a log file in full.
   */
  console.log('[Zerodha] Callback received. Params:', JSON.stringify({
    ...req.query,
    request_token: requestToken ? `${String(requestToken).slice(0, 6)}…(${String(requestToken).length} chars)` : undefined,
    state: state ? `${String(state).slice(0, 8)}…` : undefined,
  }));

  // Kite sends status=cancelled when the user backs out, and status=error
  // when the login itself failed (bad api_key, app disabled, etc).
  if (kiteStatus && kiteStatus !== 'success') {
    console.warn(`[Zerodha] Kite reported status="${kiteStatus}" — login did not complete on Kite's side.`);
    return respond(res, 400, {
      message: `Zerodha login did not complete (status: ${kiteStatus}). This usually means the login was cancelled, or the API key / app is not active on developers.kite.trade.`,
      reason: `kite_status_${kiteStatus}`,
    });
  }

  if (!requestToken) {
    const seen = Object.keys(req.query);
    console.warn(
      '[Zerodha] Callback arrived WITHOUT request_token. Params present:',
      seen.length ? seen.join(', ') : '(none at all)'
    );
    console.warn(
      '[Zerodha] If no params at all, this URL was opened directly rather than reached via a Kite redirect.'
    );
    console.warn(
      '[Zerodha] Otherwise check that KITE_REDIRECT_URL in server/.env is character-for-character identical to the Redirect URL on developers.kite.trade.'
    );
    console.warn('[Zerodha] Currently configured KITE_REDIRECT_URL:', process.env.KITE_REDIRECT_URL || '(not set!)');
    return respond(res, 400, {
      message: seen.length
        ? 'Zerodha did not send a request_token. Check that KITE_REDIRECT_URL in server/.env exactly matches the Redirect URL in your Kite app settings.'
        : 'This page was opened directly, so there is nothing to complete. The Zerodha connection must be started from the admin panel — open Admin → Overview and click "Connect Zerodha".',
      reason: 'missing_request_token',
      paramsSeen: seen,
      // Shown on the HTML page so this is a signpost rather than a dead end.
      hint: seen.length
        ? `Expected redirect URL: ${process.env.KITE_REDIRECT_URL || '(not set)'}`
        : 'Nothing is broken — this URL is only meaningful as the destination of a Kite redirect.',
    });
  }

  // ---- Single-use state consumption -------------------------------------
  // The UPDATE ... WHERE consumed_at IS NULL is what makes this atomic. Two
  // concurrent callbacks with the same state (a double-click, or a browser
  // prefetching the redirect) cannot both win: only one sees affectedRows=1.
  let adminUserId;
  try {
    if (!state) throw new Error('no_state');

    const [rows] = await db.query(
      `SELECT admin_user_id, expires_at, consumed_at
         FROM oauth_states WHERE state = :state`,
      { state }
    );

    if (!rows.length) throw new Error('unknown_state');
    if (rows[0].consumed_at) throw new Error('already_used');
    if (isExpired(rows[0].expires_at)) throw new Error('expired_state');

    const [result] = await db.query(
      `UPDATE oauth_states SET consumed_at = NOW()
        WHERE state = :state AND consumed_at IS NULL`,
      { state }
    );
    if (result.affectedRows !== 1) throw new Error('already_used');

    adminUserId = rows[0].admin_user_id;
  } catch (err) {
    const reasons = {
      no_state: 'The redirect did not include a state parameter. Kite only echoes custom params passed via `redirect_params` — confirm the login URL was built by this server and not hand-typed.',
      unknown_state: 'This login was not started from your admin panel, or the server database was reset mid-flow.',
      already_used: 'This login link was already used. Start a fresh connection from the admin panel.',
      expired_state: 'The login took longer than 10 minutes. Start a fresh connection from the admin panel.',
    };
    console.warn('[Zerodha] OAuth state rejected:', err.message);
    return respond(res, 400, {
      message: reasons[err.message] || 'Invalid OAuth state. Start the connection again from the admin panel.',
      reason: err.message,
    });
  }

  // ---- Exchange the request token ---------------------------------------
  let session;
  try {
    session = await kc.generateSession(requestToken, process.env.KITE_API_SECRET);
  } catch (err) {
    console.error('[Zerodha] generateSession failed:', err.message);
    return respond(res, 400, {
      message: 'Failed to generate Zerodha session. The request token may have already been used or expired, or KITE_API_SECRET may be wrong.',
      error: err.message,
    });
  }

  // Resolve the owning admin. Falls back to any active admin if the one who
  // started the flow was since deactivated.
  const [adminRows] = await db.query(
    "SELECT id FROM users WHERE id = :id AND role = 'admin' AND is_active = 1",
    { id: adminUserId }
  );
  if (!adminRows.length) {
    const [anyAdmin] = await db.query(
      "SELECT id FROM users WHERE role = 'admin' AND is_active = 1 ORDER BY id LIMIT 1"
    );
    if (!anyAdmin.length) {
      return respond(res, 500, { message: 'No active admin user exists to own this session.' });
    }
    adminUserId = anyAdmin[0].id;
  }

  const expiresAt = toMysqlUtc(nextTokenExpiry());

  // One connection, one transaction, deactivate BEFORE inserting.
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    await conn.query(
      'UPDATE zerodha_sessions SET is_active = 0 WHERE admin_user_id = :adminUserId AND is_active = 1',
      { adminUserId }
    );

    await conn.query(
      `INSERT INTO zerodha_sessions
         (admin_user_id, access_token_encrypted, public_token, kite_user_id,
          expires_at, is_active, last_verified_at)
       VALUES (:adminUserId, :token, :publicToken, :kiteUserId, :expiresAt, 1, NOW())`,
      {
        adminUserId,
        token: encrypt(session.access_token),
        publicToken: session.public_token || null,
        kiteUserId: session.user_id || null,
        expiresAt,
      }
    );

    await conn.commit();
  } catch (err) {
    await conn.rollback();
    console.error('[Zerodha] Failed to persist session:', err.message);
    return respond(res, 500, { message: 'Failed to store Zerodha session' });
  } finally {
    conn.release();
  }

  kc.setAccessToken(session.access_token);

  // A successful re-login must actually restart the feed AND reload the
  // instrument master — the master is what the chain reads, and it is empty
  // if this is the first successful connect since boot.
  const followUp = { feedRestarted: false, instrumentsLoaded: false };

  try {
    const { restartMarketFeed } = require('../services/marketDataService');
    await restartMarketFeed();
    followUp.feedRestarted = true;
  } catch (err) {
    console.warn('[Zerodha] Session stored but market feed restart failed:', err.message);
  }

  try {
    const instrumentService = require('../services/instrumentService');
    if (!instrumentService.isReady()) {
      // Fire and forget: the download takes 10-30s and the browser is waiting
      // on this redirect. Blocking here makes the connect button look hung.
      instrumentService
        .refresh(kc)
        .then(() => instrumentService.scheduleDailyRefresh(kc))
        .catch((err) => console.error('[Instruments] Post-login refresh failed:', err.message));
      followUp.instrumentsLoaded = 'downloading';
    } else {
      followUp.instrumentsLoaded = true;
    }
  } catch (err) {
    console.warn('[Zerodha] Instrument refresh could not be started:', err.message);
  }

  return respond(res, 200, {
    success: true,
    message: 'Zerodha Connected Successfully',
    kiteUserId: session.user_id,
    expiresAt,
    ...followUp,
  });
}

/**
 * Kite redirects a BROWSER here, not an XHR client. The old handler answered
 * with raw JSON, so a successful connect dumped `{"success":true,...}` as
 * plain text in a tab the admin then had to close manually — and a failure
 * showed an unstyled error blob with no way back.
 *
 * We render a small page that reports the outcome and, when it was opened
 * with window.open() from the admin panel, notifies the opener and closes
 * itself. API clients that ask for JSON still get JSON.
 */
function respond(res, statusCode, payload) {
  if (res.req.accepts(['html', 'json']) === 'json') {
    return res.status(statusCode).json(payload);
  }

  const ok = statusCode === 200;
  const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
  const safe = JSON.stringify({ ...payload, ok }).replace(/</g, '\\u003c');

  res.status(statusCode).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Zerodha ${ok ? 'Connected' : 'Connection Failed'}</title>
<style>
  body{background:#0b0e11;color:#e6e9ef;font:15px/1.6 system-ui,-apple-system,Segoe UI,sans-serif;
       display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
  .card{max-width:520px;background:#141920;border:1px solid #232a35;border-radius:14px;padding:32px;text-align:center}
  .icon{font-size:44px;line-height:1}
  h1{font-size:19px;margin:14px 0 8px;color:${ok ? '#22c55e' : '#f87171'}}
  p{color:#9aa4b2;margin:0 0 18px}
  .hint{font-size:13px;color:#7c8798;background:#0f141b;border:1px solid #232a35;
        border-radius:8px;padding:10px 12px;margin:0 0 18px;word-break:break-all}
  a{display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:9px 18px;border-radius:8px;font-weight:600}
  code{color:#64748b;font-size:12px}
</style></head><body>
<div class="card">
  <div class="icon">${ok ? '&#10003;' : '&#9888;'}</div>
  <h1>${ok ? 'Zerodha Connected' : 'Connection Failed'}</h1>
  <p>${String(payload.message || '').replace(/</g, '&lt;')}</p>
  ${payload.hint ? `<p class="hint">${String(payload.hint).replace(/</g, '&lt;')}</p>` : ''}
  <a href="${clientUrl}/admin">${ok ? 'Back to Admin Panel' : 'Go to Admin Panel'}</a>
  <p style="margin-top:16px"><code id="auto"></code></p>
</div>
<script>
  var result = ${safe};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ source: 'vega-zerodha-oauth', result: result }, '${clientUrl}');
      document.getElementById('auto').textContent = 'Closing this tab…';
      setTimeout(function () { window.close(); }, 1500);
    }
  } catch (e) { /* opener on another origin — leave the page up */ }
</script>
</body></html>`);
}

// GET /api/zerodha/status  (admin only)
async function status(req, res) {
  try {
    const [rows] = await db.query(
      `SELECT kite_user_id, public_token, generated_at, expires_at,
              last_verified_at, is_active
         FROM zerodha_sessions
        WHERE is_active = 1
        ORDER BY generated_at DESC
        LIMIT 1`
    );

    const { getTickerHealth } = require('../services/kiteTickerService');
    const instrumentService = require('../services/instrumentService');

    // The configured redirect URL is returned so the admin panel can show it.
    // A mismatch between this and the Redirect URL registered on
    // developers.kite.trade is the single most common reason a connect attempt
    // fails, and it is otherwise invisible from the UI.
    const redirectUrl = process.env.KITE_REDIRECT_URL || null;

    if (!rows.length) {
      return res.json({
        connected: false,
        reason: 'never_connected',
        redirectUrl,
        feed: getTickerHealth(),
        instruments: instrumentService.getStats(),
      });
    }

    const expired = isExpired(rows[0].expires_at);

    res.json({
      connected: !expired,
      reason: expired ? 'expired' : 'ok',
      redirectUrl,
      feed: getTickerHealth(),
      instruments: instrumentService.getStats(),
      ...rows[0],
    });
  } catch (err) {
    console.error('[zerodha/status] error:', err.message);
    res.status(500).json({ message: 'Failed to read Zerodha status' });
  }
}

/**
 * POST /api/zerodha/disconnect  (admin only)
 * Your brief lists "Admin can disconnect Zerodha" — there was no endpoint.
 */
async function disconnect(req, res) {
  try {
    await invalidateActiveSession();

    try {
      const { disconnectTicker } = require('../services/kiteTickerService');
      disconnectTicker();
    } catch (err) {
      console.warn('[Zerodha] Ticker teardown on disconnect failed:', err.message);
    }

    try {
      const { broadcast } = require('../services/websocketService');
      broadcast({
        type: 'feed_status',
        status: 'disconnected',
        message: 'An administrator disconnected the Zerodha feed.',
        timestamp: new Date().toISOString(),
      });
    } catch { /* websocket server may not be up yet */ }

    res.json({ success: true, message: 'Zerodha disconnected. The live feed is now down.' });
  } catch (err) {
    console.error('[zerodha/disconnect] error:', err.message);
    res.status(500).json({ message: 'Failed to disconnect Zerodha' });
  }
}

/**
 * POST /api/zerodha/refresh-instruments  (admin only)
 * Backs the "Refresh Instruments" button in your admin panel spec.
 */
async function refreshInstruments(req, res) {
  try {
    const instrumentService = require('../services/instrumentService');
    const result = await instrumentService.refresh(kc, { force: true });
    res.json({ success: true, ...result, stats: instrumentService.getStats() });
  } catch (err) {
    console.error('[zerodha/refresh-instruments] error:', err.message);
    res.status(502).json({ message: `Instrument refresh failed: ${err.message}` });
  }
}

// Used by the market feed
async function getActiveAccessToken() {
  const [rows] = await db.query(
    `SELECT access_token_encrypted, expires_at
       FROM zerodha_sessions
      WHERE is_active = 1
      ORDER BY generated_at DESC
      LIMIT 1`
  );

  if (!rows.length) throw new Error('No active Zerodha session.');
  if (isExpired(rows[0].expires_at)) throw new Error('Zerodha session expired.');

  return decrypt(rows[0].access_token_encrypted);
}

/** Marks the stored session dead after Kite rejects it (403 / TokenException). */
async function invalidateActiveSession() {
  await db.query('UPDATE zerodha_sessions SET is_active = 0 WHERE is_active = 1');
}

module.exports = {
  kc,
  getLoginUrl,
  callback,
  status,
  disconnect,
  refreshInstruments,
  getActiveAccessToken,
  invalidateActiveSession,
  restoreSession,
  verifySession,
};