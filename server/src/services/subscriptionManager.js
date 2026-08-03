const { SUBSCRIBED_TOKENS } = require('../constants/instruments');
const instrumentService = require('./instrumentService');
const { updateSubscription } = require('./kiteTickerService');

/**
 * Reconciles what every connected browser wants into a single Kite
 * subscription.
 *
 * Two hard constraints drive this design:
 *   - Kite allows ~3,000 instrument tokens per WebSocket connection
 *   - Kite allows 3 concurrent connections per API key
 * So we cannot subscribe every strike of every expiry "just in case". We
 * subscribe the union of what is actually on screen, and drop tokens the
 * moment the last viewer leaves.
 *
 * Index spot tokens are always subscribed — the chain is useless without a
 * live spot, and it is only five tokens.
 */

// client -> { symbol, expiry, tokens: number[] }
const clientSelections = new Map();

// token -> number of clients watching it
const refCounts = new Map();

/**
 * STANDING (non-client) subscriptions.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ------------------------------------------------------------------------
 * reconcile() used to subscribe exactly two things: the five index SPOT
 * tokens, and whatever option tokens live browsers had selected. Nothing
 * else.
 *
 * That silently broke the Vega recording engine. vegaTimeseriesService runs
 * headlessly on a cron every minute and reads option prices out of the tick
 * cache — but with no browser connected, no option token was ever subscribed,
 * so every strike came back empty, every Greek came back null,
 * isUsableOpenChain() rejected the day-open, and NOTHING was recorded.
 *
 * In other words the Vega chart and its history only worked while somebody
 * happened to be staring at the matching Option Chain tab, which defeats the
 * whole point of a daily recording engine.
 *
 * A standing set is owned by a server-side subscriber (the sampler), lives
 * independently of clients, and is merged into the union below.
 * ------------------------------------------------------------------------
 */
const standingSets = new Map(); // key -> sorted number[]

const STRIKE_WINDOW = Number(process.env.OPTION_STRIKE_WINDOW || 20);

function selectChain(client, { symbol, expiry, spot }) {
  const { tokens, strikes } = instrumentService.getTokensForExpiry(symbol, expiry, {
    spot,
    strikeWindow: STRIKE_WINDOW,
  });

  release(client);                       // drop the previous expiry first
  clientSelections.set(client, { symbol, expiry, tokens });
  tokens.forEach((t) => refCounts.set(t, (refCounts.get(t) || 0) + 1));

  reconcile();
  return { tokens, strikes };
}

/** Call on disconnect, otherwise tokens leak and the 3,000 cap creeps up. */
function release(client) {
  const previous = clientSelections.get(client);
  if (!previous) return;

  previous.tokens.forEach((t) => {
    const next = (refCounts.get(t) || 1) - 1;
    if (next <= 0) refCounts.delete(t);
    else refCounts.set(t, next);
  });

  clientSelections.delete(client);
  reconcile();
}

/**
 * Register/replace a named standing token set. No-op when unchanged, so this
 * is safe to call on every sampler tick without churning the Kite subscription.
 * @param {string}   key     stable owner name, e.g. 'vega-sampler'
 * @param {number[]} tokens
 */
function setStandingTokens(key, tokens) {
  const next = [...new Set((tokens || []).map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
  const prev = standingSets.get(key);

  if (prev && prev.length === next.length && prev.every((t, i) => t === next[i])) {
    return { changed: false, count: next.length };
  }

  standingSets.set(key, next);
  reconcile();
  return { changed: true, count: next.length };
}

function clearStandingTokens(key) {
  if (standingSets.delete(key)) reconcile();
}

/**
 * Force-push the current union to the ticker, even though nothing changed.
 *
 * Needed after a ticker (re)connect. setStandingTokens() and selectChain()
 * only reconcile on CHANGE, so after a socket drop the manager still believed
 * everything was subscribed while the freshly-reconnected ticker knew nothing
 * about the option tokens. Called from the ticker's connect handler.
 */
function resync() {
  reconcile();
  return { tokens: standingTotal() };
}

function standingTotal() {
  const union = new Set(SUBSCRIBED_TOKENS);
  for (const token of refCounts.keys()) union.add(token);
  for (const set of standingSets.values()) for (const token of set) union.add(token);
  return union.size;
}

function reconcile() {
  const union = new Set(SUBSCRIBED_TOKENS);
  for (const token of refCounts.keys()) union.add(token);
  for (const set of standingSets.values()) {
    for (const token of set) union.add(token);
  }

  const tokens = [...union];
  if (tokens.length > 2900) {
    console.warn(
      `[Subscriptions] ${tokens.length} tokens — approaching Kite's per-connection limit. ` +
      'Reduce OPTION_STRIKE_WINDOW or shard across a second connection.'
    );
  }

  updateSubscription(tokens);
}

function getSelection(client) {
  return clientSelections.get(client) || null;
}

function getStats() {
  const union = new Set(SUBSCRIBED_TOKENS);
  for (const token of refCounts.keys()) union.add(token);
  for (const set of standingSets.values()) for (const token of set) union.add(token);

  return {
    clients: clientSelections.size,
    distinctTokens: union.size,
    clientTokens: refCounts.size,
    standing: Object.fromEntries([...standingSets].map(([k, v]) => [k, v.length])),
    strikeWindow: STRIKE_WINDOW,
  };
}

module.exports = {
  selectChain,
  release,
  getSelection,
  getStats,
  setStandingTokens,
  clearStandingTokens,
  resync,
  STRIKE_WINDOW,
};