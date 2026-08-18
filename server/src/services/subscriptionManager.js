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

/**
 * Hard ceiling on the reconciled union (B-16).
 *
 * Kite enforces ~3,000 tokens per connection on THEIR side, and exceeding it
 * does not fail loudly: the ticker simply stops delivering some contracts. That
 * surfaces much later as null Greeks and a rejected day-open on an apparently
 * random instrument, which is close to undiagnosable from the symptom.
 *
 * vegaTimeseriesService.ensureSubscriptions() already truncates its OWN standing
 * set at TOKEN_BUDGET, but browser option-chain selections are ref-counted on
 * top of it with no cap at all (~83 tokens per distinct {symbol, expiry}), so
 * roughly thirteen browsers on different chains could push the union past the
 * limit. Truncating here converts silent broker-side corruption into a
 * deterministic, logged, observable drop.
 *
 * PRIORITY, highest first:
 *   1. index spot tokens  — the chain is useless without a live spot, and there
 *                           are only five of them
 *   2. standing sets      — the headless recorder, which nobody is watching and
 *                           which therefore cannot recover by itself
 *   3. client selections  — a live viewer notices a missing chain immediately
 *                           and can re-select
 */
const HARD_TOKEN_CAP = Math.max(
  500,
  Math.min(Number(process.env.KITE_TOKEN_CAP) || 2900, 3000)
);

let lastDropped = 0;

function reconcile() {
  const union = new Set(SUBSCRIBED_TOKENS);
  for (const set of standingSets.values()) {
    for (const token of set) union.add(token);
  }

  let tokens = [...union];
  let dropped = 0;

  // Client selections are added last so they are the first thing dropped.
  for (const token of refCounts.keys()) {
    if (union.has(token)) continue;
    if (tokens.length >= HARD_TOKEN_CAP) { dropped += 1; continue; }
    union.add(token);
    tokens.push(token);
  }

  // Even the priority set can exceed the cap on a badly over-configured
  // recorder. Truncate rather than hand Kite a set it will silently mangle.
  if (tokens.length > HARD_TOKEN_CAP) {
    dropped += tokens.length - HARD_TOKEN_CAP;
    tokens = tokens.slice(0, HARD_TOKEN_CAP);
  }

  if (dropped !== lastDropped) {
    lastDropped = dropped;
    if (dropped) {
      console.warn(
        `[Subscriptions] ${dropped} token(s) dropped at the ${HARD_TOKEN_CAP} cap — ` +
        'some option-chain views will not receive ticks. Reduce OPTION_STRIKE_WINDOW, ' +
        'VEGA_STRIKE_WINDOW or VEGA_EXPIRY_COUNT, or shard across a second connection.'
      );
    } else {
      console.log('[Subscriptions] Back within the token cap — nothing dropped.');
    }
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
    // Surfaced so /api/vega/status shows the cap being hit instead of leaving
    // it to be inferred from missing Greeks hours later (B-16).
    tokenCap: HARD_TOKEN_CAP,
    droppedTokens: lastDropped,
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