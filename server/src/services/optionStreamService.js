const { setMessageHandler, sendToClient, getWss } = require('./websocketService');
const subscriptionManager = require('./subscriptionManager');
const optionChainService = require('./optionChainService');
const instrumentService = require('./instrumentService');
const oiBaselineService = require('./oiBaselineService');
const { getUnderlying } = require('../constants/instruments');

/**
 * The /ws/market option chain protocol.
 *
 * Client -> server:
 *   { "type": "subscribe_chain", "symbol": "NIFTY", "expiry": "2026-07-30" }
 *   { "type": "unsubscribe_chain" }
 *
 * Server -> client:
 *   { "type": "chain", "data": { spot, atmStrike, expiry, pcr, maxPain, atmIv, chain: [...] } }
 *   { "type": "chain_error", "message": "..." }
 *
 * Why an interval instead of per-tick: a liquid NIFTY expiry produces several
 * hundred ticks per second. Rebuilding and JSON-encoding a 41-row chain that
 * often would saturate both the server and the browser's main thread, and no
 * human can read updates faster than a few per second anyway. We coalesce.
 */

const PUSH_INTERVAL_MS = Number(process.env.CHAIN_PUSH_INTERVAL_MS || 1000);

let pushTimer = null;
let latestTicksRef = null;

function init(latestTicks) {
  latestTicksRef = latestTicks;
  setMessageHandler(handleMessage);
  startPushLoop();
}

function handleMessage(client, msg) {
  switch (msg?.type) {
    case 'subscribe_chain':
      return handleSubscribe(client, msg);
    case 'unsubscribe_chain':
      subscriptionManager.release(client);
      return sendToClient(client, { type: 'chain_unsubscribed' });
    case 'ping':
      return sendToClient(client, { type: 'pong' });
    default:
      return sendToClient(client, {
        type: 'chain_error',
        message: `Unsupported message type: ${msg?.type}`,
      });
  }
}

function handleSubscribe(client, { symbol, expiry }) {
  try {
    const cfg = getUnderlying(symbol);
    if (!cfg) throw Object.assign(new Error(`Unknown symbol: ${symbol}`), { statusCode: 404 });

    if (!instrumentService.isReady()) {
      throw Object.assign(
        new Error('Instrument master not loaded yet. An admin must connect Zerodha.'),
        { statusCode: 503 }
      );
    }

    // Default to the nearest expiry, like Kite does.
    const expiries = instrumentService.getExpiries(cfg.key);
    const chosen = expiry || expiries[0];
    if (!chosen) throw Object.assign(new Error(`No live expiries for ${cfg.key}`), { statusCode: 404 });

    const spot = latestTicksRef?.get(cfg.spotToken)?.lastPrice ?? null;

    const { tokens } = subscriptionManager.selectChain(client, {
      symbol: cfg.key,
      expiry: chosen,
      spot,
    });

    // websocketService filters broadcasts against this set, so a client
    // watching NIFTY never receives BANKNIFTY ticks.
    client.subscribedTokens = new Set([...tokens, cfg.spotToken]);

    sendToClient(client, {
      type: 'chain_subscribed',
      symbol: cfg.key,
      expiry: chosen,
      expiries,
      tokenCount: tokens.length,
    });

    pushChainTo(client); // immediate first paint, don't wait for the interval
  } catch (err) {
    sendToClient(client, { type: 'chain_error', message: err.message });
  }
}

function pushChainTo(client) {
  const selection = subscriptionManager.getSelection(client);
  if (!selection || client.readyState !== 1 /* OPEN */) return;

  try {
    const snapshot = optionChainService.buildChain({
      symbol: selection.symbol,
      expiry: selection.expiry,
      latestTicks: latestTicksRef,
      oiBaseline: oiBaselineService.getBaselineMap(),
      strikeWindow: subscriptionManager.STRIKE_WINDOW,
    });

    snapshot.ivPercentile = optionChainService.calculateIvPercentile(
      snapshot.atmIv,
      oiBaselineService.getIvHistorySync(snapshot.symbol)
    );

    sendToClient(client, { type: 'chain', data: snapshot });
  } catch (err) {
    sendToClient(client, { type: 'chain_error', message: err.message });
  }
}

function startPushLoop() {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = setInterval(() => {
    const wss = getWss();
    if (!wss) return;
    wss.clients.forEach((client) => {
      if (subscriptionManager.getSelection(client)) pushChainTo(client);
    });
  }, PUSH_INTERVAL_MS);
  if (pushTimer.unref) pushTimer.unref();
}

function stop() {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
}

module.exports = { init, stop, handleMessage };