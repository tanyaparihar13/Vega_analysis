'use strict';

const { sendToClient, onDisconnect } = require('./websocketService');
const subscriptionManager = require('./subscriptionManager');
const vegaTimeseriesService = require('./vegaTimeseriesService');
const instrumentService = require('./instrumentService');
const cfg = require('../config/vegaConfig');

/**
 * Live Vega streaming over the existing /ws/market socket.
 *
 * Client -> server:
 *   { type: 'subscribe_vega',   symbol: 'APLAPOLLO', expiry: '2026-08-28', timeframe: '5s' }
 *   { type: 'unsubscribe_vega' }
 *
 * Server -> client:
 *   { type: 'vega_subscribed', symbol, expiry, expiries, timeframe, resolution, points: [...] }
 *   { type: 'vega_point',      symbol, expiry, timeframe, point: {...} }
 *   { type: 'vega_error',      message }
 *
 * ===========================================================================
 * WHY THIS IS A SEPARATE MODULE FROM optionStreamService
 * ===========================================================================
 * They share the socket but not the selection. A user can have the Option Chain
 * open on NIFTY 04-Aug and the Vega terminal on APLAPOLLO 28-Aug, and those are
 * two different token sets that must be ref-counted, replaced and released
 * independently. subscriptionManager keys its selections by an arbitrary object,
 * so each service owns its own per-client key — `client._vegaSlot` here — and
 * neither can release the other's tokens.
 *
 * ===========================================================================
 * SUBSCRIBE OLD OUT, NEW IN (Feature 8)
 * ===========================================================================
 * selectChain() releases the previous selection for this slot before ref-counting
 * the new one, so switching instrument never accumulates tokens. Re-sending the
 * SAME selection is detected upstream (registerDemand reports `changed: false`)
 * and skipped entirely, so a client that re-announces itself on reconnect does
 * not churn the Kite subscription.
 *
 * ===========================================================================
 * PUSH CADENCE
 * ===========================================================================
 * There is no timer in this file. It listens to the sampler's own tick, which
 * already runs on the 5s clock, and emits at most one point per client per
 * TIMEFRAME period — 5s selected means a point every 5s, 15m means a point every
 * 15 minutes, exactly as specified. Emitting is gated on the aggregation bucket
 * ADVANCING, so a coarse timeframe does not spray twelve identical updates a
 * minute at the browser.
 *
 * The emitted point is the bucket's value stamped with the bucket's START time,
 * which is the same rule the historical aggregator uses. That is what makes a
 * chart left open all session identical to the same chart reloaded from history,
 * and what keeps the table and the tooltip on the same numbers.
 */

const DEFAULT_TIMEFRAME = '5s';

// client -> { symbol, expiry, timeframe, lastBucket }
const sessions = new Map();

let unsubscribeTick = null;
let unsubscribeDisconnect = null;

function init() {
  stop(); // idempotent: never stack two tick listeners on a restart

  unsubscribeTick = vegaTimeseriesService.onTick(handleSamplerTick);
  unsubscribeDisconnect = onDisconnect(releaseClient);
}

function stop() {
  if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
  if (unsubscribeDisconnect) { unsubscribeDisconnect(); unsubscribeDisconnect = null; }
  for (const client of [...sessions.keys()]) releaseClient(client);
  sessions.clear();
}

/**
 * The per-client key subscriptionManager and the demand registry are keyed by.
 * Lazily created and stashed on the socket so it survives across messages and is
 * garbage-collected with the socket itself.
 */
function slotFor(client) {
  if (!client._vegaSlot) client._vegaSlot = { vega: true };
  return client._vegaSlot;
}

/**
 * Routed here by optionStreamService's message handler.
 * @returns {boolean} whether this module handled the message
 */
function handleMessage(client, msg) {
  switch (msg?.type) {
    case 'subscribe_vega':
      handleSubscribe(client, msg);
      return true;
    case 'unsubscribe_vega':
      releaseClient(client);
      sendToClient(client, { type: 'vega_unsubscribed' });
      return true;
    default:
      return false;
  }
}

function handleSubscribe(client, { symbol, expiry, timeframe }) {
  try {
    if (!instrumentService.isReady()) {
      throw new Error('Instrument master not loaded yet. An admin must connect Zerodha.');
    }

    const cfgU = vegaTimeseriesService.resolveSymbol(symbol);
    if (!cfgU) throw new Error(`Unknown instrument: ${symbol}`);

    const tf = cfg.TIMEFRAMES[timeframe] ? timeframe : DEFAULT_TIMEFRAME;

    const expiries = vegaTimeseriesService.trackedExpiries(cfgU.key);
    const chosen = expiry && expiries.includes(String(expiry).slice(0, 10))
      ? String(expiry).slice(0, 10)
      : expiries[0];
    if (!chosen) throw new Error(`No live expiries for ${cfgU.key}`);

    // Tell the sampler to start producing this series, and subscribe the ticker
    // tokens behind it. `changed` is false when the client re-sent what it
    // already had, in which case the Kite subscription is left completely alone.
    const registration = vegaTimeseriesService.registerDemand(slotFor(client), {
      symbol: cfgU.key,
      expiry: chosen,
    });

    if (registration.changed) {
      const spot = cfgU.spotToken != null
        ? subscriptionManagerSpot(cfgU.spotToken)
        : null;

      subscriptionManager.selectChain(slotFor(client), {
        symbol: cfgU.key,
        expiry: chosen,
        spot,
      });

      // The sampler's standing set is rebuilt from the demand registry on its
      // next tick; doing it here too means the tokens are live before that,
      // rather than up to five seconds later.
      vegaTimeseriesService.ensureSubscriptions();
    }

    const previous = sessions.get(client);
    sessions.set(client, {
      symbol: cfgU.key,
      expiry: chosen,
      timeframe: tf,
      // Reset the emit gate whenever the SERIES changes, so the first point of
      // a newly selected instrument goes out immediately instead of waiting for
      // the next bucket boundary.
      lastBucket: previous && previous.symbol === cfgU.key
        && previous.expiry === chosen && previous.timeframe === tf
        ? previous.lastBucket
        : null,
    });

    // Back-fill from the live buffer so the chart paints the session so far
    // rather than growing one point at a time from empty.
    const points = vegaTimeseriesService.getSeries(cfgU.key, tf, chosen);

    sendToClient(client, {
      type: 'vega_subscribed',
      symbol: cfgU.key,
      label: cfgU.label || cfgU.key,
      expiry: chosen,
      expiries,
      timeframe: tf,
      resolution: vegaTimeseriesService.persistResolutionFor(cfgU.key),
      isIndex: vegaTimeseriesService.isIndex(cfgU.key),
      count: points.length,
      points,
    });
  } catch (err) {
    sendToClient(client, { type: 'vega_error', message: err.message });
  }
}

/** Spot price for a token, read from the sampler's tick cache via marketDataService. */
function subscriptionManagerSpot(token) {
  try {
    // Required lazily: marketDataService pulls in the ticker, and importing it
    // at module load would create a cycle through websocketService.
    const { latestTicks } = require('./marketDataService');
    return latestTicks?.get(token)?.lastPrice ?? null;
  } catch {
    return null;
  }
}

function releaseClient(client) {
  if (!client) return;
  if (client._vegaSlot) {
    const hadDemand = vegaTimeseriesService.releaseDemand(client._vegaSlot);
    subscriptionManager.release(client._vegaSlot);
    // Rebuild the standing set now rather than leaving the departed client's
    // contracts subscribed until the next sampler tick. Outside market hours the
    // cron is not running at all, so "next tick" could be tomorrow morning.
    if (hadDemand) vegaTimeseriesService.ensureSubscriptions();
  }
  sessions.delete(client);
}

/**
 * One traversal per sampler tick.
 *
 * `updated` is the list of {symbol, expiry, point} the sampler just produced, so
 * a client watching a series that did not tick this round is not visited at all.
 */
function handleSamplerTick(updated) {
  if (!sessions.size || !updated?.length) return;

  const bySeries = new Map();
  for (const u of updated) bySeries.set(`${u.symbol}|${u.expiry}`, u.point);

  for (const [client, session] of sessions) {
    if (client.readyState !== 1 /* OPEN */) { releaseClient(client); continue; }

    const point = bySeries.get(`${session.symbol}|${session.expiry}`);
    if (!point) continue;

    const seconds = cfg.TIMEFRAMES[session.timeframe] || 5;
    const bucket = Math.floor(point.time / seconds) * seconds;

    // Emit once per timeframe period: 5s -> every 5s, 15m -> every 15 minutes.
    if (session.lastBucket === bucket) continue;
    session.lastBucket = bucket;

    sendToClient(client, {
      type: 'vega_point',
      symbol: session.symbol,
      expiry: session.expiry,
      timeframe: session.timeframe,
      // Stamped with the BUCKET's start time, matching the historical
      // aggregator, so live and reloaded charts land on identical x values.
      point: { ...decorateForWire(point), time: bucket },
    });
  }
}

/**
 * The sampler's raw buffer points carry no trend (it is derived on read), so
 * decorate here through the same path every other reader uses.
 */
function decorateForWire(point) {
  const [decorated] = vegaTimeseriesService.bucketByTimeframe([point], '5s');
  const { classifyTrend } = require('../utils/vegaTrend');
  const t = classifyTrend(point.callVegaDiff, point.putVegaDiff);
  return { ...(decorated || point), trend: t.label, trendKey: t.key, trendColor: t.color };
}

function getStats() {
  return {
    clients: sessions.size,
    sessions: [...sessions.values()].map(({ symbol, expiry, timeframe }) => ({ symbol, expiry, timeframe })),
  };
}

module.exports = { init, stop, handleMessage, releaseClient, getStats };
