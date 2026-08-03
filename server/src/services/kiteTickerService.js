const { KiteTicker } = require('kiteconnect');
const { SUBSCRIBED_TOKENS } = require('../constants/instruments');

let ticker = null;
let subscribedTokens = [];

/**
 * FIX C5: the previous version handed all failure handling to
 * `ticker.autoReconnect(true, 10, 5)` and an error listener that only logged.
 *
 * autoReconnect is built for NETWORK drops. A 403 is an AUTH failure —
 * reconnecting with the same dead token produces an identical 403, ten times,
 * five seconds apart, and then gives up silently. That is the reconnect loop.
 *
 * We now own the retry policy: network failures back off exponentially, auth
 * failures stop immediately and raise a flag the admin panel can read.
 */
const health = {
  connected: false,
  needsReauth: false,
  lastError: null,
  lastConnectedAt: null,
  reconnectAttempts: 0,
};

const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;
let backoffTimer = null;

function isAuthFailure(err) {
  const message = String(err?.message || err || '');
  return (
    err?.status === 403 ||
    /403/.test(message) ||
    /token/i.test(message) ||
    /forbidden/i.test(message) ||
    err?.error_type === 'TokenException'
  );
}

function clearBackoff() {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

function teardown() {
  clearBackoff();
  if (ticker) {
    try {
      ticker.disconnect();
    } catch (err) {
      console.warn('[KiteTicker] Error disconnecting previous session:', err.message);
    }
    // Null it out unconditionally. If disconnect() threw, keeping the reference
    // leaks a socket, and Kite allows only 3 concurrent connections per API key.
    ticker = null;
  }
}

/**
 * @param {object}   params
 * @param {string}   params.apiKey
 * @param {string}   params.accessToken
 * @param {Function} params.onTicks
 * @param {Function} [params.onAuthFailure] - called once when the token is rejected
 * @param {Function} [params.onConnect]     - called after every successful (re)connect
 * @param {number[]} [params.tokens]        - initial set; omit on reconnect to keep the live set
 */
function connectTicker({ apiKey, accessToken, onTicks, onAuthFailure, onConnect, tokens = null }) {
  teardown();

  health.needsReauth = false;
  health.lastError = null;

  /**
   * ------------------------------------------------------------------------
   * DO NOT CLOBBER THE RECONCILED SUBSCRIPTION ON RECONNECT.
   * ------------------------------------------------------------------------
   * This used to be `subscribedTokens = tokens` with `tokens` defaulting to
   * SUBSCRIBED_TOKENS (the five index spot tokens). scheduleReconnect() then
   * replayed the ORIGINAL params, so every reconnect silently threw away the
   * ~620 option tokens that subscriptionManager had reconciled — and nothing
   * ever put them back, because setStandingTokens() no-ops when the standing
   * set is unchanged, so reconcile() was never called again.
   *
   * Observed live: standing=620, distinctTokens=620, but subscribedCount=5.
   * Kite drops idle sockets outside market hours, so the ticker reconnects
   * constantly — meaning the recorder would have been left with spot ticks
   * only and would have recorded nothing at all the next session.
   *
   * Now an explicit `tokens` array seeds a FRESH connect; a reconnect passes
   * none and keeps whatever updateSubscription() last reconciled.
   */
  if (Array.isArray(tokens) && tokens.length) {
    subscribedTokens = tokens;
  } else if (!subscribedTokens.length) {
    subscribedTokens = SUBSCRIBED_TOKENS;
  }

  ticker = new KiteTicker({ api_key: apiKey, access_token: accessToken });

  // We drive reconnection ourselves.
  ticker.autoReconnect(false);

  ticker.on('connect', () => {
    health.connected = true;
    health.reconnectAttempts = 0;
    health.lastConnectedAt = new Date().toISOString();
    console.log(`[KiteTicker] Connected — subscribing ${subscribedTokens.length} tokens`);
    ticker.subscribe(subscribedTokens);
    ticker.setMode(ticker.modeFull, subscribedTokens);

    // Let the owner re-assert the authoritative union (subscriptionManager).
    // Belt and braces: even if `subscribedTokens` were somehow stale, this
    // pulls the true set back in on every reconnect instead of drifting.
    if (typeof onConnect === 'function') {
      try { onConnect(); } catch (err) { console.warn('[KiteTicker] onConnect hook failed:', err.message); }
    }
  });

  ticker.on('ticks', onTicks);

  ticker.on('error', (err) => {
    health.lastError = String(err?.message || err);
    if (isAuthFailure(err)) {
      // Terminal. Retrying cannot possibly help.
      health.needsReauth = true;
      health.connected = false;
      console.error('[KiteTicker] Access token rejected by Kite — re-authentication required.');
      clearBackoff();
      if (typeof onAuthFailure === 'function') onAuthFailure(err);
    } else {
      console.error('[KiteTicker] Error:', health.lastError);
    }
  });

  ticker.on('close', () => {
    health.connected = false;
    if (health.needsReauth) {
      // Do not reconnect. This is the line that breaks the loop.
      return;
    }
    scheduleReconnect({ apiKey, accessToken, onTicks, onAuthFailure, tokens });
  });

  ticker.on('disconnect', (err) => {
    health.connected = false;
    console.warn('[KiteTicker] Disconnected:', err?.message || '');
  });

  ticker.connect();
  return ticker;
}

function scheduleReconnect(params) {
  clearBackoff();
  health.reconnectAttempts += 1;
  const delay = Math.min(
    BASE_BACKOFF_MS * 2 ** (health.reconnectAttempts - 1),
    MAX_BACKOFF_MS
  );
  console.log(`[KiteTicker] Reconnecting in ${delay}ms (attempt ${health.reconnectAttempts})`);
  // `tokens: null` deliberately — the reconnect must keep the CURRENT
  // reconciled set, not replay the seed set this ticker was first created
  // with. See the comment in connectTicker().
  backoffTimer = setTimeout(() => connectTicker({ ...params, tokens: null }), delay);
}

/**
 * Adjusts the live subscription set — needed for the option chain, where the
 * tokens change every time the user switches symbol or expiry.
 * Kite allows roughly 3,000 tokens per connection, so unsubscribing the
 * previous expiry is mandatory, not an optimisation.
 */
function updateSubscription(nextTokens) {
  if (!ticker || !health.connected) {
    subscribedTokens = nextTokens;
    return;
  }
  const next = new Set(nextTokens);
  const current = new Set(subscribedTokens);

  const toAdd = nextTokens.filter((t) => !current.has(t));
  const toRemove = subscribedTokens.filter((t) => !next.has(t));

  if (toRemove.length) ticker.unsubscribe(toRemove);
  if (toAdd.length) {
    ticker.subscribe(toAdd);
    ticker.setMode(ticker.modeFull, toAdd);
  }
  subscribedTokens = nextTokens;
}

function disconnectTicker() {
  teardown();
  health.connected = false;
}

function getTicker() {
  return ticker;
}

function getTickerHealth() {
  return { ...health, subscribedCount: subscribedTokens.length };
}

module.exports = {
  connectTicker,
  disconnectTicker,
  getTicker,
  getTickerHealth,
  updateSubscription,
};