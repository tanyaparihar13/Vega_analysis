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
      // Async since the warm-start fallback may read MySQL. The catch is the
      // outer safety net; handleSubscribe reports its own errors to the client.
      handleSubscribe(client, msg).catch((err) => {
        console.warn('[VegaStream] subscribe failed:', err.message);
        sendToClient(client, { type: 'vega_error', message: 'Could not start the live series' });
      });
      return true;
    case 'unsubscribe_vega':
      releaseClient(client);
      sendToClient(client, { type: 'vega_unsubscribed' });
      return true;
    default:
      return false;
  }
}

async function handleSubscribe(client, { symbol, expiry, timeframe }) {
  try {
    if (!instrumentService.isReady()) {
      throw new Error('Instrument master not loaded yet. An admin must connect Zerodha.');
    }

    const cfgU = vegaTimeseriesService.resolveSymbol(symbol);
    if (!cfgU) throw new Error(`Unknown instrument: ${symbol}`);

    const tf = cfg.TIMEFRAMES[timeframe] ? timeframe : DEFAULT_TIMEFRAME;

    /**
     * =====================================================================
     * NEVER SUBSTITUTE THE EXPIRY (B-04)
     * =====================================================================
     * This used to be:
     *
     *     const chosen = expiry && expiries.includes(...) ? ... : expiries[0];
     *
     * so asking for an expiry the recorder is not tracking silently returned a
     * DIFFERENT contract's series. The client then painted it under the
     * selected expiry's label — and because `vega_point` is expiry-filtered,
     * no live point ever matched afterwards, leaving a wrong-expiry curve
     * frozen on screen for the rest of the session. That is strictly worse
     * than an empty chart, because it looks like real data.
     *
     * A requested expiry is now honoured exactly or refused explicitly. The
     * refusal is `vega_unavailable`, not `vega_error`: nothing is broken, this
     * contract simply has no LIVE stream. The client drops the socket series on
     * that message, which lets the REST path — which already filters expiry
     * correctly and returns an honest empty state — take over.
     */
    const requested = expiry ? String(expiry).slice(0, 10) : null;
    const expiries = vegaTimeseriesService.trackedExpiries(cfgU.key);

    if (requested && !expiries.includes(requested)) {
      sendToClient(client, {
        type: 'vega_unavailable',
        symbol: cfgU.key,
        expiry: requested,
        expiries,
        reason: 'expiry-not-tracked',
        message: expiries.length
          ? `${cfgU.key} ${requested} is not being recorded live. Tracked right now: ${expiries.join(', ')}.`
          : `${cfgU.key} has no live expiries right now.`,
      });
      // Drop any previous selection for this client so the sampler is not left
      // producing a series nobody is watching.
      releaseClient(client);
      return;
    }

    // Only an ABSENT expiry falls back, and only to the nearest tracked one.
    const chosen = requested || expiries[0];
    if (!chosen) {
      sendToClient(client, {
        type: 'vega_unavailable',
        symbol: cfgU.key,
        expiry: null,
        expiries: [],
        reason: 'no-expiries',
        message: `No live expiries for ${cfgU.key}.`,
      });
      releaseClient(client);
      return;
    }

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
    /**
     * THE TRADING DATE IS PART OF THE IDENTITY OF A LIVE SESSION.
     *
     * A socket subscription is by definition a subscription to TODAY — a
     * historical date has nothing to stream and the client disables the hook
     * for one. That made the date look like a constant, so nothing carried it.
     * It is not constant: a terminal left open overnight rolls into a new
     * session while its subscription still describes the old one, and the
     * sampler then pushes the NEW day's 09:15 into a chart still showing the
     * OLD day. That is the same two-day mixing the buffer used to do, arriving
     * live instead of on load — and the buffer fix cannot reach it, because by
     * then the point is a legitimate point of the current session being sent
     * to a client that is not watching the current session.
     */
    sessions.set(client, {
      symbol: cfgU.key,
      expiry: chosen,
      timeframe: tf,
      tradingDate: vegaTimeseriesService.todayIst(),
      // Reset the emit gate whenever the SERIES changes, so the first point of
      // a newly selected instrument goes out immediately instead of waiting for
      // the next bucket boundary.
      lastBucket: previous && previous.symbol === cfgU.key
        && previous.expiry === chosen && previous.timeframe === tf
        ? previous.lastBucket
        : null,
    });

    /**
     * BACK-FILL, WITH A WARM START.
     *
     * The live ring buffer is the fast path and covers the normal case. But it
     * is EMPTY in two situations that are entirely ordinary, and in both of them
     * returning `points: []` hands the browser a blank chart for a day that has
     * rows sitting on disk:
     *
     *   · the process restarted mid-session, so loadToday() has run but this
     *     particular {symbol, expiry} has not been sampled again yet
     *   · the user selected a stock that nobody has been watching, so the
     *     sampler has only just been told to start producing it
     *
     * loadByDate() already resolves both — it reads the buffer first and falls
     * back to MySQL — and it applies the same bucketing and decorate() the REST
     * path uses, so a warm-started chart is byte-identical to a reloaded one.
     */
    let points = vegaTimeseriesService.getSeries(cfgU.key, tf, chosen);
    let source = 'memory';

    if (!points.length) {
      const stored = await vegaTimeseriesService.loadByDate(
        cfgU.key, vegaTimeseriesService.todayIst(), tf, chosen
      );
      points = stored.points || [];
      source = points.length ? 'database' : 'empty';
    }

    /**
     * The selection may have moved while MySQL was being read — a user clicking
     * through instruments generates a subscribe per click, and the awaits do not
     * complete in a guaranteed order. Sending a stale back-fill would repaint
     * the chart with an instrument the user has already navigated away from.
     */
    const current = sessions.get(client);
    if (!current || current.symbol !== cfgU.key || current.expiry !== chosen || current.timeframe !== tf) {
      return;
    }
    if (client.readyState !== 1 /* OPEN */) return;

    sendToClient(client, {
      type: 'vega_subscribed',
      symbol: cfgU.key,
      label: cfgU.label || cfgU.key,
      expiry: chosen,
      expiries,
      timeframe: tf,
      // The IST session these points belong to, stated rather than assumed, so
      // the client can refuse a back-fill for a day it is no longer viewing.
      tradingDate: vegaTimeseriesService.todayIst(),
      resolution: vegaTimeseriesService.persistResolutionFor(cfgU.key),
      isIndex: vegaTimeseriesService.isIndex(cfgU.key),
      // 'memory' | 'database' | 'empty' — so the client can tell a warm start
      // from a genuinely empty session.
      source,
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

    /**
     * ===================================================================
     * EMIT EVERY SAMPLE, STAMPED WITH ITS BUCKET START (B-01)
     * ===================================================================
     * This used to suppress every sample after the first in a bucket:
     *
     *     if (session.lastBucket === bucket) continue;
     *
     * which meant the client received the FIRST 5s sample of each bucket while
     * bucketByTimeframe() — the function behind the REST series, the WebSocket
     * back-fill and the Excel export — keeps the LAST. The two disagreed by
     * whatever the vega moved inside the bucket: measured at 111 (history) vs
     * 100 (live) on a single 1m bar. Worse, the in-progress bar never updated
     * at all, so a 15m chart showed a value up to fifteen minutes stale and a
     * reload silently corrected it.
     *
     * Emitting every sample with the bucket's start time makes the client's
     * replace-in-place rule (useVegaStream) the aggregator, and last-value-wins
     * falls out of it — identical to the historical path by construction rather
     * than by two functions agreeing to agree. It also makes the in-progress
     * bucket live, which is what a running chart is for.
     *
     * `lastBucket` is retained for diagnostics and for the client-side
     * transition reset; it no longer gates anything.
     *
     * COST: one message per client per 5s (~200 bytes) instead of one per
     * bucket. On a 15m chart that is 180x more messages and ~40 B/s.
     */
    /**
     * A POINT MAY ONLY REACH A SESSION OPENED ON ITS OWN TRADING DAY.
     *
     * The sampler only ever produces today's points, so this fires in exactly
     * one situation: a socket open across midnight. Skipping leaves the stale
     * chart alone until the client resubscribes for the new day, which is the
     * conservative choice — showing yesterday's completed session is honest,
     * quietly growing it with today's points is not.
     */
    const pointDate = vegaTimeseriesService.tradingDateOf(point);
    if (session.tradingDate && pointDate && pointDate !== session.tradingDate) continue;

    const bucket = vegaTimeseriesService.bucketStartFor(point.time, session.timeframe);
    const bucketAdvanced = session.lastBucket !== bucket;
    session.lastBucket = bucket;

    sendToClient(client, {
      type: 'vega_point',
      symbol: session.symbol,
      expiry: session.expiry,
      timeframe: session.timeframe,
      tradingDate: pointDate,
      // True on the first sample of a new bucket. The client uses it only to
      // distinguish "append a bar" from "revise the open bar"; correctness does
      // not depend on it, because the timestamps already say which is which.
      bucketAdvanced,
      // Stamped with the BUCKET's start time, matching the historical
      // aggregator, so live and reloaded charts land on identical x values.
      point: { ...decorateForWire(point), time: bucket },
    });
  }
}

/**
 * The sampler's raw buffer points are stored in the engine's own (PHP) sign
 * convention and carry no trend, so they must go through the SAME decorate()
 * every other reader uses before they go on the wire.
 *
 * This used to call classifyTrend directly, which quietly meant the live push
 * skipped the display-sign flip: a chart left open all session showed the
 * negation of the same chart reloaded from history. Delegating removes any
 * possibility of the two conventions drifting apart again — there is now exactly
 * one function that decides what a served point looks like.
 */
function decorateForWire(point) {
  return vegaTimeseriesService.decorate(point);
}

function getStats() {
  return {
    clients: sessions.size,
    sessions: [...sessions.values()].map(({ symbol, expiry, timeframe, tradingDate }) =>
      ({ symbol, expiry, timeframe, tradingDate })),
  };
}

module.exports = {
  init, stop, handleMessage, releaseClient, getStats,
  /**
   * Test seam — exported so the live/history convergence guarantee (B-01) can be
   * asserted against the REAL emit path rather than a copy of it in a test file.
   * A copy would keep passing after someone reintroduced the bucket suppression,
   * which is exactly the regression this seam exists to catch.
   *
   * Not referenced anywhere in application code.
   */
  __test: { handleSamplerTick, sessions },
};
