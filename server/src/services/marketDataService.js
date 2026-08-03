/**
 * Market Data Service — orchestrates the live feed.
 *
 *   kiteTickerService -> Zerodha KiteTicker (one tick listener)
 *   websocketService  -> frontend clients over /ws/market
 *   marketDataService -> glues them together + holds the latest snapshot
 */
const { connectTicker, getTickerHealth } = require('./kiteTickerService');
const { initWebSocketServer, broadcast, broadcastTicks } = require('./websocketService');
const { normalizeTick } = require('../utils/normalizeTick');
const { SUBSCRIBED_TOKENS } = require('../constants/instruments');

// instrument_token -> latest normalized tick
const latestTicks = new Map();

let httpServerRef = null;

function getSnapshot() {
  return Array.from(latestTicks.values());
}

function handleTicks(rawTicks) {
  const normalized = rawTicks.map(normalizeTick);
  normalized.forEach((tick) => latestTicks.set(tick.instrumentToken, tick));
  broadcastTicks(normalized);
}

/**
 * FIX C5: when Kite rejects the token we mark the DB session dead and tell every
 * connected browser, instead of silently retrying into a dead socket. The admin
 * panel can watch for this and prompt for re-login.
 */
async function handleAuthFailure() {
  try {
    const { invalidateActiveSession } = require('../controllers/zerodhaController');
    await invalidateActiveSession();
  } catch (err) {
    console.error('[Market Feed] Could not invalidate stored session:', err.message);
  }

  broadcast({
    type: 'feed_status',
    status: 'reauth_required',
    message: 'Zerodha session expired. An administrator must reconnect.',
    timestamp: new Date().toISOString(),
  });

  // Hook your email/Slack alert here — this is the moment the feed goes dark.
  console.error('[Market Feed] REAUTH REQUIRED — feed is down until an admin reconnects.');
}

async function startMarketFeed(httpServer, tokens = SUBSCRIBED_TOKENS) {
  if (httpServer) httpServerRef = httpServer;
  const wss = initWebSocketServer(httpServerRef, getSnapshot);

  // Lazy require avoids a circular dependency (zerodhaController requires this
  // module to restart the feed after a successful re-login).
  const { getActiveAccessToken } = require('../controllers/zerodhaController');

  let accessToken;
  try {
    accessToken = await getActiveAccessToken();
  } catch (err) {
    console.warn('[Market Feed] Not started:', err.message);
    return { ticker: null, wss };
  }

  const ticker = connectTicker({
    apiKey: process.env.KITE_API_KEY,
    accessToken,
    onTicks: handleTicks,
    onAuthFailure: handleAuthFailure,
    tokens,
    /**
     * Re-assert the full reconciled subscription after EVERY connect.
     *
     * Kite closes idle sockets (constantly outside market hours), so the
     * ticker reconnects often. subscriptionManager only pushes on change, so
     * without this the manager believed ~620 option tokens were subscribed
     * while the reconnected ticker had only the 5 index spots — and the Vega
     * recorder would have silently produced nothing.
     *
     * Lazy require: subscriptionManager pulls in kiteTickerService, and this
     * module is loaded by both — requiring it at the top would create a cycle.
     */
    onConnect: () => {
      try {
        const { resync } = require('./subscriptionManager');
        const { tokens: n } = resync();
        console.log(`[Market Feed] Subscription resynced — ${n} tokens`);
      } catch (err) {
        console.warn('[Market Feed] Subscription resync failed:', err.message);
      }
    },
  });

  /**
   * Tell every open browser the feed is back.
   *
   * handleAuthFailure already broadcasts 'reauth_required' when the token
   * dies, but nothing ever announced the recovery — so after an admin
   * reconnected, a tab that had shown "feed down" kept showing it until the
   * user manually reloaded. The chain hook (useOptionChain) surfaces this
   * message, so the counterpart matters.
   */
  broadcast({
    type: 'feed_status',
    status: 'connected',
    message: 'Live market feed connected.',
    timestamp: new Date().toISOString(),
  });

  return { ticker, wss };
}

/** Called after a successful re-login so the feed actually comes back up. */
async function restartMarketFeed() {
  if (!httpServerRef) throw new Error('Market feed was never initialised with an HTTP server');
  latestTicks.clear();
  return startMarketFeed(httpServerRef);
}

module.exports = {
  startMarketFeed,
  restartMarketFeed,
  getTickerHealth,
  latestTicks,
  getSnapshot,
};