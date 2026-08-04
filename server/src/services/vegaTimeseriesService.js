'use strict';

const cron = require('node-cron');
const db = require('../config/db');
const optionChainService = require('./optionChainService');
const instrumentService = require('./instrumentService');
const chainSnapshotStore = require('./chainSnapshotStore');
const subscriptionManager = require('./subscriptionManager');
const constants = require('../constants/instruments');
const cfg = require('../config/vegaConfig');
const { computePoint, pickStrikes } = require('../utils/vegaMath');
const { classifyTrend } = require('../utils/vegaTrend');

const { UNDERLYINGS } = constants;

/**
 * Vega Analysis — a faithful port of the PHP `addvega.php` algorithm onto the
 * Zerodha + Node stack. The arithmetic lives in utils/vegaMath.js; this module
 * builds the chains, freezes the day-open baseline, samples on a clock, and
 * persists / serves the series. The Bullish/Bearish/Sideways label is derived
 * on read by utils/vegaTrend.js (datav1.php rules).
 *
 * ===========================================================================
 * THE THREE AXES
 * ===========================================================================
 * A series is identified by {symbol, expiry} and stored at a RESOLUTION.
 * Everything below follows from keeping those separate:
 *
 *   symbol      any tradable underlying — the five indices AND every F&O stock
 *               in Kite's instrument master. Resolved through
 *               instrumentService.resolveUnderlying, not the five-name
 *               constants table, which is what makes stocks work at all.
 *   expiry      one immutable day-open baseline and one series per expiry.
 *   resolution  what was WRITTEN to MySQL: 5s for indices, 1m for stocks
 *               (cfg.PERSIST_RESOLUTION). Timeframes are aggregated up from it
 *               on read; a resolution can only serve a timeframe that is a
 *               whole multiple of it.
 *
 * ===========================================================================
 * WHAT IS SAMPLED, AND HOW OFTEN
 * ===========================================================================
 * The clock ticks every 5 seconds (cfg.SAMPLE_CRON). On each tick the active
 * set is:
 *
 *   RECORDED   the five indices plus cfg.RECORDED_STOCKS — sampled with nobody
 *              watching, which is the whole point of a recorder. This is what
 *              has history.
 *   ON DEMAND  whatever connected clients have selected (registerDemand, called
 *              by vegaStreamService). Sampled at the full 5s clock so a live
 *              seconds chart works for any of ~200 F&O stocks without any of
 *              them costing anything when nobody is looking.
 *
 * A target is only COMPUTED on a tick if it is being watched or the tick is
 * aligned to its persist resolution. So a recorded stock costs one chain build
 * a minute, not twelve, and the faster clock is paid for only where a faster
 * series is actually consumed.
 *
 * The arithmetic is untouched by any of this: every target runs the same
 * vegaMath computePoint() against its own day-open chain. Changing instrument,
 * expiry or timeframe changes WHICH series you read, never HOW it was
 * calculated.
 *
 * Greeks note: PHP got Greeks pre-baked from Upstox. Here they are computed by
 * optionChainService.buildChain() (IV solved from LTP, then Black-Scholes).
 * Same methodology, different source.
 */

// --- diagnostic logging (throttled to once/min per distinct reason) --------
const _lastLog = new Map();
function vlog(reason, force = false) {
  const now = Date.now();
  if (!force && _lastLog.get(reason) && now - _lastLog.get(reason) < 60_000) return;
  _lastLog.set(reason, now);
  console.log(`[VegaSeries] ${reason}`);
}

// 'SYMBOL|YYYY-MM-DD' -> { symbol, expiry, open: <baseline|null>, series: [rawPoint] }
const state = new Map();

/**
 * On-demand targets: demandKey -> { symbol, expiry }.
 *
 * A demandKey is owned by whoever registered it (vegaStreamService uses one per
 * connected client). Registering replaces that owner's previous target, so a
 * client switching instrument can never leave the old one being sampled — which
 * is the "unsubscribe old tokens, subscribe new tokens" half of Feature 8, and
 * the reason this is a keyed map rather than a set.
 */
const demand = new Map();

let sampleTask = null;
let latestTicksRef = null;

// ---------------------------------------------------------------------------
// Symbol / resolution helpers
// ---------------------------------------------------------------------------

/**
 * Resolve any tradable underlying — index OR F&O stock.
 *
 * constants.getUnderlying knows five names. instrumentService also knows every
 * equity name discovered in the option master, which is the difference between
 * "NIFTY works" and "APLAPOLLO works".
 */
function resolveSymbol(symbol) {
  if (!symbol) return null;
  return instrumentService.resolveUnderlying(String(symbol).toUpperCase());
}

/** Curated index (fixed five) vs derived F&O stock. Drives persist resolution. */
function isIndex(symbol) {
  return !!constants.getUnderlying(symbol);
}

function persistResolutionFor(symbol) {
  return isIndex(symbol) ? cfg.PERSIST_RESOLUTION.index : cfg.PERSIST_RESOLUTION.stock;
}

function tfSeconds(timeframe) {
  return cfg.TIMEFRAMES[timeframe] || null;
}

/**
 * Can rows recorded at `resolution` be aggregated into `timeframe`?
 *
 * Only when the timeframe is a whole multiple of the resolution. 5s rows make
 * any tier; 1m rows cannot make a 30s bar out of nothing. Stated once here so
 * the read path, the picker and the error message can never disagree about it.
 */
function canServe(resolution, timeframe) {
  const r = tfSeconds(resolution);
  const t = tfSeconds(timeframe);
  if (!r || !t) return false;
  return t >= r && t % r === 0;
}

/** Normalise any expiry representation (Date, DATETIME string, ISO) to YYYY-MM-DD. */
function expiryKey(value) {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  return s ? s.slice(0, 10) : null;
}

/** The composite key every in-memory lookup uses. */
function stateKey(symbol, expiry) {
  return `${String(symbol).toUpperCase()}|${expiryKey(expiry)}`;
}

function startFor(symbol) {
  return cfg.DELTA_START[String(symbol || '').toUpperCase()] ?? cfg.DEFAULT_START;
}

/**
 * The expiries tracked for one underlying, nearest first.
 *
 * Derived from the live instrument master rather than stored anywhere, so an
 * expiry rollover needs no intervention: the moment the expired contract drops
 * out of instrumentService, the window slides forward by one and the next
 * expiry starts being sampled (with its own day-open captured at that point).
 */
function trackedExpiries(symbol) {
  const c = resolveSymbol(symbol);
  if (!c || !instrumentService.isReady()) return [];
  return instrumentService.getExpiries(c.key)
    .map(expiryKey)
    .filter(Boolean)
    .slice(0, cfg.EXPIRY_COUNT);
}

/** Expiries currently held in memory for one symbol, nearest first. */
function memoryExpiries(symbol) {
  const key = String(symbol).toUpperCase();
  return [...state.values()].filter((e) => e.symbol === key).map((e) => e.expiry).sort();
}

/**
 * Symbols the recorder samples with nobody watching: the five indices, plus any
 * stock named in cfg.RECORDED_STOCKS that actually resolves to a live chain.
 * An unknown or delisted name in the env var is skipped with one warning rather
 * than throwing the sampler over.
 */
function recordedSymbols() {
  const out = Object.values(UNDERLYINGS).map((c) => c.key);
  for (const name of cfg.RECORDED_STOCKS) {
    const c = resolveSymbol(name);
    if (!c) { vlog(`Ignoring VEGA_RECORDED_STOCKS entry '${name}': no live chain`); continue; }
    if (!out.includes(c.key)) out.push(c.key);
  }
  return out;
}

/**
 * Every {symbol, expiry} to consider this tick, with why it is in the set.
 * `watched` targets get the full 5s clock; the rest only compute when the tick
 * lands on their persist resolution.
 */
function activeTargets() {
  const targets = new Map();

  const add = (symbol, expiry, patch) => {
    const key = stateKey(symbol, expiry);
    const existing = targets.get(key);
    if (existing) Object.assign(existing, patch);
    else targets.set(key, { symbol: String(symbol).toUpperCase(), expiry, watched: false, recorded: false, ...patch });
  };

  for (const symbol of recordedSymbols()) {
    for (const expiry of trackedExpiries(symbol)) add(symbol, expiry, { recorded: true });
  }
  for (const { symbol, expiry } of demand.values()) {
    if (expiry) add(symbol, expiry, { watched: true });
  }

  return [...targets.values()];
}

// ---------------------------------------------------------------------------
// On-demand registry (Feature 8) — called by vegaStreamService
// ---------------------------------------------------------------------------

/**
 * Register (or replace) one owner's live target.
 *
 * Returns whether anything changed, so the caller can avoid re-subscribing Kite
 * tokens for a no-op — a client re-sending its current selection must not churn
 * the ticker subscription.
 */
function registerDemand(ownerKey, { symbol, expiry }) {
  const c = resolveSymbol(symbol);
  if (!c) return { changed: false, symbol: null, expiry: null };

  const chosen = expiryKey(expiry) || trackedExpiries(c.key)[0] || null;
  const prev = demand.get(ownerKey);
  const changed = !prev || prev.symbol !== c.key || prev.expiry !== chosen;

  demand.set(ownerKey, { symbol: c.key, expiry: chosen });
  return { changed, symbol: c.key, expiry: chosen };
}

function releaseDemand(ownerKey) {
  return demand.delete(ownerKey);
}

function demandStats() {
  const byTarget = new Map();
  for (const { symbol, expiry } of demand.values()) {
    const k = `${symbol}|${expiry}`;
    byTarget.set(k, (byTarget.get(k) || 0) + 1);
  }
  return { owners: demand.size, targets: Object.fromEntries(byTarget) };
}

// ---------------------------------------------------------------------------
// Baseline sanity
// ---------------------------------------------------------------------------

/**
 * Guard against freezing a day-open baseline whose Greeks are mostly null.
 *
 * Symptom this catches: right at 09:16 the first tick on a strike can still be
 * a stale/previous-day LTP, so the IV solver's time-value/vega thresholds
 * reject it and Greeks come back null -> vega 0 in toGreekChain. If THAT
 * chain gets frozen as the day-open, every diff for the rest of the session
 * becomes `current - 0 = current`, i.e. permanently positive and tracking
 * raw current vega instead of the actual change from the morning. Since the
 * baseline is immutable once captured, this is unrecoverable for the day —
 * so refuse to freeze it and let captureDayOpen retry on the next tick.
 */
function isUsableOpenChain(chain, minFraction = 0.5) {
  if (!chain.length) return false;
  let withGreeks = 0;
  for (const row of chain) {
    if (row.call?.vega || row.put?.vega) withGreeks += 1;
  }
  return withGreeks / chain.length >= minFraction;
}

/** Trim a built chain to the per-strike greeks the calculation/baseline need. */
function toGreekChain(chain) {
  return chain.map((r) => ({
    strike: r.strike,
    call: { vega: g(r.call?.vega), theta: g(r.call?.theta), gamma: g(r.call?.gamma), delta: g(r.call?.delta), iv: g(r.call?.iv) },
    put: { vega: g(r.put?.vega), theta: g(r.put?.theta), gamma: g(r.put?.gamma), delta: g(r.put?.delta), iv: g(r.put?.iv) },
  }));
}
const g = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

function istParts(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    day: ist.getUTCDay(),
    minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
    date: ist.toISOString().slice(0, 10),
  };
}

function isSamplingWindow(now = new Date()) {
  const { day, minutes } = istParts(now);
  if (day === 0 || day === 6) return false;
  return minutes >= cfg.MARKET_OPEN_MIN && minutes <= cfg.MARKET_CLOSE_MIN;
}

function fmtSql(d) { return d.toISOString().slice(0, 19).replace('T', ' '); }
function parseJson(v) { try { return typeof v === 'string' ? JSON.parse(v) : (v || []); } catch { return []; } }

// ---------------------------------------------------------------------------
// Standing Kite subscription
// ---------------------------------------------------------------------------

const STANDING_KEY = 'vega-sampler';

/**
 * Make sure the option contracts this sampler reads are actually subscribed.
 *
 * Without this the recorder is silently dependent on a browser being open:
 * subscriptionManager only subscribed the five index spot tokens plus whatever
 * live clients had selected, so a headless server recorded nothing at all —
 * empty ticks -> null Greeks -> day-open rejected -> zero rows for the day.
 *
 * ONE standing set, covering every active target (recorded + on demand). Because
 * it is a single named set, replacing it is one reconcile and one
 * updateSubscription call, and tokens that dropped out of the set are released
 * in the same breath — a client switching from NIFTY to APLAPOLLO does not
 * accumulate both. setStandingTokens no-ops when the union is unchanged, so
 * calling this every tick is cheap and an expiry rollover is picked up for free.
 */
function ensureSubscriptions() {
  if (!instrumentService.isReady()) return null;

  const tokens = [];
  const detail = [];

  // Index spot tokens are always in the union via SUBSCRIBED_TOKENS, but a
  // stock's spot has to be added explicitly or its chain has no underlying.
  for (const target of activeTargets()) {
    const c = resolveSymbol(target.symbol);
    if (!c) continue;

    const spot = c.spotToken != null ? latestTicksRef?.get(c.spotToken)?.lastPrice ?? null : null;
    const sel = instrumentService.getTokensForExpiry(c.key, target.expiry, {
      spot,
      strikeWindow: cfg.STRIKE_WINDOW,
    });

    tokens.push(...sel.tokens);
    if (c.spotToken != null) tokens.push(c.spotToken);
    detail.push(`${c.key}/${target.expiry}:${sel.tokens.length}`);
  }

  if (!tokens.length) return null;

  const result = subscriptionManager.setStandingTokens(STANDING_KEY, tokens);
  if (result.changed) {
    vlog(`Subscribed ${result.count} tokens across ${detail.length} targets`, true);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Building one chain snapshot for a {symbol, expiry}
// ---------------------------------------------------------------------------

function buildChainFor(symbol, expiry) {
  const c = resolveSymbol(symbol);
  if (!c) { vlog(`Skipped ${symbol}: unknown underlying`); return null; }
  if (!instrumentService.isReady()) { vlog(`Skipped ${symbol}: instrument master not ready`); return null; }

  const chosen = expiryKey(expiry);
  if (!chosen) { vlog(`Skipped ${c.key}: no expiry available`); return null; }

  const spotTick = c.spotToken != null ? latestTicksRef?.get(c.spotToken) : null;
  if (spotTick?.lastPrice == null) { vlog(`Skipped ${c.key}: no live spot tick (feed idle?)`); return null; }

  try {
    const snap = optionChainService.buildChain({
      symbol: c.key,
      expiry: chosen,
      latestTicks: latestTicksRef,
      strikeWindow: cfg.STRIKE_WINDOW,
    });
    return { snap, expiry: chosen, price: spotTick.lastPrice, atmStrike: snap.atmStrike ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Day-open capture (PHP: the first market_open row of the day) — per expiry
// ---------------------------------------------------------------------------

async function captureDayOpen(symbol, expiry) {
  const c = resolveSymbol(symbol);
  if (!c) return null;

  const chosen = expiryKey(expiry) || trackedExpiries(c.key)[0];
  if (!chosen) return null;

  const key = stateKey(c.key, chosen);
  const entry = state.get(key) || { symbol: c.key, expiry: chosen, open: null, series: [] };
  if (entry.open) return entry.open; // immutable for the session

  const built = buildChainFor(c.key, chosen);
  if (!built) return null;

  const start = startFor(c.key);
  const openChain = toGreekChain(built.snap.chain);
  if (!openChain.length) return null;

  if (!isUsableOpenChain(openChain)) {
    vlog(`Rejected day-open for ${c.key} ${chosen}: Greeks mostly null (stale ticks?) — retrying next tick`, true);
    return null;
  }

  // The strike lists selected AT OPEN — used only by 'frozen' mode.
  const frozen = pickStrikes(openChain, start, cfg.DELTA_MAX);

  const open = {
    date: istParts().date,
    symbol: c.key,
    expiry: built.expiry,
    capturedAt: new Date(),
    chain: openChain,
    frozenCallStrikes: frozen.callStrikes,
    frozenPutStrikes: frozen.putStrikes,
  };

  entry.open = open;
  state.set(key, entry);

  await persistDayOpen(open).catch((err) =>
    console.warn(`[VegaSeries] Day-open persist failed for ${c.key} ${chosen}:`, err.message));

  console.log(`[VegaSeries] Day-open captured for ${c.key} ${chosen}: ${openChain.length} strikes ` +
    `(${frozen.callStrikes.length} call / ${frozen.putStrikes.length} put eligible at open)`);
  return open;
}

// ---------------------------------------------------------------------------
// One sample (PHP: the vega_chart INSERT) — per {symbol, expiry}
// ---------------------------------------------------------------------------

function computeDiffs(symbol, expiry, at = new Date()) {
  const chosen = expiryKey(expiry);
  const entry = state.get(stateKey(symbol, chosen));
  if (!entry?.open) { vlog(`Skipped ${symbol} ${chosen}: no day-open baseline yet`); return null; }

  const built = buildChainFor(symbol, chosen);
  if (!built) return null;

  const start = startFor(symbol);
  const currentChain = toGreekChain(built.snap.chain);

  // DYNAMIC: the strike set is recomputed from the CURRENT chain each call, then
  // looked up in the day-open chain (addvega.php). 'frozen' reuses the 09:16
  // lists instead. Identical for indices and stocks — nothing here branches on
  // instrument class.
  const point = computePoint({
    currentChain,
    openChain: entry.open.chain,
    start,
    deltaMax: cfg.DELTA_MAX,
    mode: cfg.STRIKE_MODE,
    frozenStrikes: { callStrikes: entry.open.frozenCallStrikes, putStrikes: entry.open.frozenPutStrikes },
  });

  return {
    time: Math.floor(at.getTime() / 1000),
    callVegaDiff: point.callVegaDiff,
    putVegaDiff: point.putVegaDiff,
    vegaDiff: point.vegaDiff,
    currentCallVega: point.currentCallVega,
    currentPutVega: point.currentPutVega,
    openCallVega: point.openCallVega,
    openPutVega: point.openPutVega,
    price: built.price,
    atmStrike: built.atmStrike,
    callStrikeCount: point.callStrikeCount,
    putStrikeCount: point.putStrikeCount,
    expiry: built.expiry,
    _chain: currentChain, // transient, for optional raw storage; never served
  };
}

/** Push into the bounded live buffer, replacing a same-second duplicate. */
function appendLive(key, entry, point) {
  const last = entry.series[entry.series.length - 1];
  if (last && last.time === point.time) entry.series[entry.series.length - 1] = point;
  else entry.series.push(point);

  // Bounded — an unbounded array per instrument is how a recorder that runs all
  // day becomes a memory leak.
  const overflow = entry.series.length - cfg.LIVE_BUFFER_POINTS;
  if (overflow > 0) entry.series.splice(0, overflow);

  state.set(key, entry);
}

/**
 * Listeners notified after each sampler tick, with the targets that produced a
 * fresh point. vegaStreamService uses this to push to browsers instead of
 * polling the state map on its own timer — one clock, one traversal.
 */
const tickListeners = new Set();
function onTick(fn) { tickListeners.add(fn); return () => tickListeners.delete(fn); }

async function sampleAll(now = new Date()) {
  // Subscribe BEFORE the window check, not after.
  //
  // The cron fires from 09:00 while the sampling window opens at 09:15, so
  // those first ticks give Kite ~15 minutes to start streaming the option
  // contracts. Doing it after the early-return would mean subscribing at
  // 09:15:00 and reading the cache in the same breath — empty, so the 09:15
  // day-open would always be rejected and the baseline would slip a tick.
  ensureSubscriptions();

  if (!isSamplingWindow(now)) { vlog('Skipped: market closed (outside window or weekend)'); return; }

  const epoch = Math.floor(now.getTime() / 1000);
  const written = [];
  const rawSnaps = [];
  const updated = [];

  for (const target of activeTargets()) {
    const resolution = persistResolutionFor(target.symbol);
    const persistNow = epoch % tfSeconds(resolution) === 0;

    // The whole point of the 5s clock being cheap: a recorded stock that nobody
    // is watching does one chain build a minute, not twelve.
    if (!target.watched && !persistNow) continue;

    const key = stateKey(target.symbol, target.expiry);
    if (!state.get(key)?.open) await captureDayOpen(target.symbol, target.expiry);

    const point = computeDiffs(target.symbol, target.expiry, now);
    if (!point) continue;

    const chain = point._chain;
    delete point._chain;

    const entry = state.get(key);
    appendLive(key, entry, point);
    updated.push({ symbol: target.symbol, expiry: target.expiry, point });

    if (persistNow) {
      written.push({ symbol: target.symbol, resolution, ...point });
      if (chain) rawSnaps.push({ symbol: target.symbol, expiry: point.expiry, sampledAt: new Date(point.time * 1000), chain });
    }
  }

  if (written.length) {
    try {
      await persistSamples(written);
      vlog(`Inserted ${written.length} row(s)`, false);
    } catch (err) {
      vlog(`Skipped: INSERT failed - ${err.message}`, true);
    }
    const today = istParts().date;
    for (const s of rawSnaps) {
      await chainSnapshotStore.persist({ date: today, symbol: s.symbol, sampledAt: s.sampledAt, expiry: s.expiry, chain: s.chain });
    }
  }

  if (updated.length) {
    for (const fn of tickListeners) {
      try { fn(updated); } catch (err) { console.warn('[VegaSeries] tick listener failed:', err.message); }
    }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistDayOpen(open) {
  await db.query(
    `INSERT INTO vega_day_open
       (snapshot_date, symbol, expiry, captured_at, open_chain, call_strikes, put_strikes)
     VALUES (:date, :symbol, :expiry, :capturedAt, :chain, :callStrikes, :putStrikes)
     ON DUPLICATE KEY UPDATE snapshot_date = snapshot_date`, // immutable: never overwrite
    {
      date: open.date, symbol: open.symbol, expiry: open.expiry,
      capturedAt: fmtSql(open.capturedAt),
      chain: JSON.stringify(open.chain),
      callStrikes: JSON.stringify(open.frozenCallStrikes),
      putStrikes: JSON.stringify(open.frozenPutStrikes),
    }
  );
}

async function persistSamples(points) {
  const today = istParts().date;
  await db.query(
    `INSERT INTO vega_timeseries
       (snapshot_date, symbol, sampled_at, expiry, resolution, atm_strike,
        call_vega_diff, put_vega_diff, vega_diff,
        current_call_vega, current_put_vega,
        open_call_vega, open_put_vega,
        price, call_strike_count, put_strike_count)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       atm_strike=VALUES(atm_strike),
       call_vega_diff=VALUES(call_vega_diff), put_vega_diff=VALUES(put_vega_diff),
       vega_diff=VALUES(vega_diff), current_call_vega=VALUES(current_call_vega),
       current_put_vega=VALUES(current_put_vega), open_call_vega=VALUES(open_call_vega),
       open_put_vega=VALUES(open_put_vega), price=VALUES(price),
       call_strike_count=VALUES(call_strike_count), put_strike_count=VALUES(put_strike_count)`,
    [points.map((p) => [
      today, p.symbol, fmtSql(new Date(p.time * 1000)), p.expiry, p.resolution, p.atmStrike,
      p.callVegaDiff, p.putVegaDiff, p.vegaDiff,
      p.currentCallVega, p.currentPutVega,
      p.openCallVega, p.openPutVega,
      p.price, p.callStrikeCount, p.putStrikeCount,
    ])]
  );
}

/**
 * Restore today's baselines and series after a restart.
 *
 * Only the newest LIVE_BUFFER_POINTS per series are kept in memory — a full day
 * of 5s index rows across three expiries is tens of thousands of rows, and the
 * live buffer exists to answer "what happened recently", not to be a second
 * copy of the database. Anything older is still on disk and still served by the
 * historical read path.
 */
async function loadToday() {
  try {
    const today = istParts().date;

    const [opens] = await db.query(`SELECT * FROM vega_day_open WHERE snapshot_date = :today`, { today });
    const [rows] = await db.query(
      `SELECT * FROM vega_timeseries WHERE snapshot_date = :today ORDER BY sampled_at ASC`, { today });

    state.clear();

    for (const o of opens) {
      const expiry = expiryKey(o.expiry);
      if (!expiry) continue;
      state.set(stateKey(o.symbol, expiry), {
        symbol: String(o.symbol).toUpperCase(),
        expiry,
        open: {
          date: today, symbol: o.symbol, expiry, capturedAt: o.captured_at,
          chain: parseJson(o.open_chain),
          frozenCallStrikes: parseJson(o.call_strikes),
          frozenPutStrikes: parseJson(o.put_strikes),
        },
        series: [],
      });
    }

    for (const r of rows) {
      const expiry = expiryKey(r.expiry);
      if (!expiry) continue;
      const key = stateKey(r.symbol, expiry);
      const entry = state.get(key)
        || { symbol: String(r.symbol).toUpperCase(), expiry, open: null, series: [] };
      entry.series.push(rowToPoint(r));
      state.set(key, entry);
    }

    for (const [key, entry] of state) {
      const overflow = entry.series.length - cfg.LIVE_BUFFER_POINTS;
      if (overflow > 0) entry.series.splice(0, overflow);
      state.set(key, entry);
    }

    const total = [...state.values()].reduce((a, e) => a + e.series.length, 0);
    console.log(`[VegaSeries] Restored ${opens.length} baselines, ${total} buffered samples ` +
      `across ${state.size} symbol/expiry series for today`);
  } catch (err) {
    console.warn('[VegaSeries] Could not restore today:', err.message);
  }
  return state.size;
}

// ---------------------------------------------------------------------------
// Read API — trend is derived here (single source of truth)
// ---------------------------------------------------------------------------

function decorate(p) {
  const t = classifyTrend(p.callVegaDiff, p.putVegaDiff);
  return { ...p, trend: t.label, trendKey: t.key, trendColor: t.color };
}

function rowToPoint(r) {
  return {
    time: Math.floor(new Date(`${String(r.sampled_at).replace(' ', 'T')}Z`).getTime() / 1000),
    callVegaDiff: +r.call_vega_diff,
    putVegaDiff: +r.put_vega_diff,
    vegaDiff: +r.vega_diff,
    currentCallVega: +r.current_call_vega,
    currentPutVega: +r.current_put_vega,
    openCallVega: r.open_call_vega != null ? +r.open_call_vega : null,
    openPutVega: r.open_put_vega != null ? +r.open_put_vega : null,
    price: r.price != null ? +r.price : null,
    atmStrike: r.atm_strike != null ? +r.atm_strike : null,
    callStrikeCount: r.call_strike_count,
    putStrikeCount: r.put_strike_count,
    expiry: expiryKey(r.expiry),
  };
}

/** Day-open reference for the latest point (dynamic => it moves each sample). */
function dayOpenSummaryFromPoints(points) {
  if (!points.length) return null;
  const last = points[points.length - 1];
  return {
    callVega: last.openCallVega,
    putVega: last.openPutVega,
    callStrikes: last.callStrikeCount,
    putStrikes: last.putStrikeCount,
  };
}

/**
 * Last value wins inside each bucket.
 *
 * This is the same rule the live push uses (vegaStreamService emits the bucket's
 * current value at the bucket's start time), which is what keeps a chart that
 * has been open all session identical to the same chart reloaded from history.
 */
function bucketByTimeframe(points, timeframe = '1m') {
  const seconds = tfSeconds(timeframe) || 60;
  if (points.length < 2) return points;
  const out = [];
  let bucket = null;
  let last = null;
  for (const p of points) {
    const b = Math.floor(p.time / seconds) * seconds;
    if (bucket !== null && b !== bucket) out.push({ ...last, time: bucket });
    bucket = b;
    last = p;
  }
  if (last) out.push({ ...last, time: bucket });
  return out;
}

/** Which stored resolutions exist for one {symbol, date, expiry}. */
async function storedResolutions(symbol, date, expiry = null) {
  const [rows] = await db.query(
    `SELECT DISTINCT resolution FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date
        AND (:expiry IS NULL OR expiry = :expiry)`,
    { symbol: String(symbol).toUpperCase(), date, expiry: expiryKey(expiry) || null }
  );
  return rows.map((r) => r.resolution).filter(Boolean);
}

/**
 * The finest stored resolution that can build the requested timeframe, or null
 * when none can — which is a real answer, not an error: a stock recorded at 1m
 * genuinely cannot produce a 15s bar, and the caller must say so rather than
 * render an empty chart with no explanation.
 */
function pickResolution(available, timeframe) {
  const usable = available.filter((r) => canServe(r, timeframe));
  if (!usable.length) return null;
  return usable.sort((a, b) => tfSeconds(a) - tfSeconds(b))[0];
}

/** Timeframes a given set of stored resolutions can serve, coarsest resolution wins. */
function servableTimeframes(available) {
  return Object.keys(cfg.TIMEFRAMES).filter((tf) => available.some((r) => canServe(r, tf)));
}

/** The stored rows for one day / expiry / resolution, bucketed + trend-decorated. */
async function readStoredPoints(symbol, date, timeframe = '1m', expiry = null, resolution = null) {
  const [rows] = await db.query(
    `SELECT sampled_at, call_vega_diff, put_vega_diff, vega_diff,
            current_call_vega, current_put_vega, open_call_vega, open_put_vega,
            price, atm_strike, call_strike_count, put_strike_count, expiry
       FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date
        AND (:expiry IS NULL OR expiry = :expiry)
        AND (:resolution IS NULL OR resolution = :resolution)
      ORDER BY sampled_at ASC`,
    {
      symbol: String(symbol).toUpperCase(), date,
      expiry: expiryKey(expiry) || null,
      resolution: resolution || null,
    }
  );
  return bucketByTimeframe(rows.map(rowToPoint), timeframe).map(decorate);
}

/**
 * Baseline metadata for a past day + expiry.
 *
 * The per-sample rows carry the (moving) day-open totals, but only vega_day_open
 * knows WHEN the baseline was frozen. The chain column is deliberately not
 * selected — it is a large JSON blob and nothing on the read path needs it.
 */
async function loadDayOpenMeta(symbol, date, expiry = null) {
  try {
    const [rows] = await db.query(
      `SELECT expiry, captured_at
         FROM vega_day_open
        WHERE symbol = :symbol AND snapshot_date = :date
          AND (:expiry IS NULL OR expiry = :expiry)
        ORDER BY expiry ASC
        LIMIT 1`,
      { symbol: String(symbol).toUpperCase(), date, expiry: expiryKey(expiry) || null }
    );
    if (!rows.length) return null;
    return { expiry: expiryKey(rows[0].expiry), capturedAt: rows[0].captured_at || null };
  } catch (err) {
    console.warn(`[VegaSeries] Day-open lookup failed for ${symbol} ${date}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Expiry discovery + resolution
// ---------------------------------------------------------------------------

/**
 * Which expiries the dropdown can offer for one {symbol, date}.
 *
 * Sources are merged on purpose, because neither alone is right:
 *   stored   — expiries that actually have rows for that day. The ONLY source
 *              for a past session; a contract that has since expired is gone
 *              from the instrument master but its recorded day is still real.
 *   tracked  — the contracts being sampled right now. Needed for TODAY so a
 *              freshly-rolled expiry, or one a user has only just selected, is
 *              offered before its first sample lands.
 *
 * Nearest expiry first, which is the order a trader reads them in.
 */
async function listExpiries(symbol, date) {
  const key = String(symbol || '').toUpperCase();
  const isToday = date === istParts().date;

  const [rows] = await db.query(
    `SELECT expiry,
            COUNT(*)        AS points,
            MIN(sampled_at) AS first_at,
            MAX(sampled_at) AS last_at
       FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date
      GROUP BY expiry
      ORDER BY expiry ASC`,
    { symbol: key, date }
  );

  const byExpiry = new Map();
  for (const r of rows) {
    const e = expiryKey(r.expiry);
    if (!e) continue;
    byExpiry.set(e, {
      expiry: e, points: Number(r.points),
      firstAt: toUnix(r.first_at), lastAt: toUnix(r.last_at), recording: false,
    });
  }

  if (isToday) {
    // Live memory can be ahead of the database by up to one write cycle.
    for (const entry of state.values()) {
      if (entry.symbol !== key || !entry.series.length) continue;
      const existing = byExpiry.get(entry.expiry);
      if (!existing || entry.series.length > existing.points) {
        byExpiry.set(entry.expiry, {
          expiry: entry.expiry, points: entry.series.length,
          firstAt: entry.series[0].time,
          lastAt: entry.series[entry.series.length - 1].time,
          recording: false,
        });
      }
    }

    for (const e of trackedExpiries(key)) {
      const existing = byExpiry.get(e);
      if (existing) existing.recording = true;
      else byExpiry.set(e, { expiry: e, points: 0, firstAt: null, lastAt: null, recording: true });
    }
  }

  return [...byExpiry.values()].sort((a, b) => (a.expiry < b.expiry ? -1 : 1));
}

/**
 * Turn a requested expiry into the one we will actually read.
 *
 * An unknown/absent request resolves to the NEAREST expiry available for that
 * day rather than 404-ing, so a bookmarked URL, an expiry that rolled over
 * between page loads, or a client that simply has not asked yet all land on the
 * front-month series instead of an error.
 */
async function resolveExpiry(symbol, date, requested) {
  const wanted = expiryKey(requested);
  const available = await listExpiries(symbol, date);
  const keys = available.map((e) => e.expiry);

  if (wanted && keys.includes(wanted)) return { expiry: wanted, available, matched: true };
  if (wanted) return { expiry: wanted, available, matched: false };
  return { expiry: keys[0] || null, available, matched: !!keys.length };
}

/**
 * Read one trading day, for one expiry, at one timeframe — the single entry
 * point behind the instrument, expiry, timeframe and date pickers.
 *
 * Today comes from the in-memory buffer (it is still being appended to), any
 * other day from MySQL. The one subtlety: today ALSO falls back to MySQL when
 * memory is empty. That happens after a restart before loadToday() finishes,
 * and it is the difference between the user seeing the morning's curve and
 * seeing a blank chart on a day that has rows on disk.
 *
 * `unavailable` is set — with the timeframes that WOULD work — when the day has
 * data but none of it is fine enough for the requested timeframe. That is the
 * "5s history for a stock" case, and it has to be distinguishable from "nothing
 * was recorded", because the fix is different.
 */
async function loadByDate(symbol, date, timeframe = '1m', expiry = null) {
  const key = String(symbol || '').toUpperCase();
  const live = date === istParts().date;
  const chosen = expiryKey(expiry);

  const available = await storedResolutions(key, date, chosen);
  const resolution = pickResolution(available, timeframe);

  let points = [];
  let fromStore = false;
  let unavailable = null;

  // The live buffer is at the 5s base clock, so it can serve any timeframe.
  if (live) points = getSeries(key, timeframe, chosen);

  if (!points.length) {
    if (available.length && !resolution) {
      unavailable = {
        reason: 'resolution',
        storedResolutions: available,
        servableTimeframes: servableTimeframes(available),
      };
    } else {
      points = await readStoredPoints(key, date, timeframe, chosen, resolution);
      fromStore = points.length > 0;
    }
  }

  const meta = await loadDayOpenMeta(key, date, chosen);
  const summary = dayOpenSummaryFromPoints(points);

  const dayOpen = summary || meta
    ? { callVega: null, putVega: null, callStrikes: null, putStrikes: null, ...(summary || {}), ...(meta || {}) }
    : null;

  return {
    points,
    dayOpen,
    live,
    expiry: chosen,
    timeframe,
    resolution: resolution || (live && points.length ? cfg.PERSIST_RESOLUTION.index : null),
    storedResolutions: available,
    unavailable,
    hasBaseline: !!(meta || summary || (live && chosen && state.get(stateKey(key, chosen))?.open)),
    fromStore,
  };
}

/**
 * Read a DELAYED window of the series, for the public marketing site.
 *
 * This is the only vega read served without authentication, so it is
 * deliberately a separate function rather than a flag on loadByDate() — there is
 * no argument anyone can pass to the premium path that turns it into this one,
 * and no way to accidentally drop the delay by forgetting a parameter.
 *
 * It stays pinned to NIFTY-style index behaviour: the nearest expiry with
 * publishable rows, at 1m. The public teaser gained no new axes when the
 * terminal did — no instrument picker, no seconds, no expiry parameter — so the
 * public surface is exactly as wide as it was.
 *
 * TIMEZONE NOTE, because getting this wrong silently serves live data:
 * `sampled_at` is written in UTC (persistSamples -> fmtSql -> toISOString),
 * while `snapshot_date` is the IST trading day. The cutoff below is therefore
 * built in UTC to match the column it is compared against.
 *
 * FALLBACK: before ~09:45 IST on a trading day — and all weekend — today has no
 * points old enough to publish, so this falls back to the most recent COMPLETED
 * session and says so via `isFallbackDay`, which the caller must surface.
 */
const PUBLIC_DELAY_MINUTES = 30;

async function loadDelayed(symbol, { delayMinutes = PUBLIC_DELAY_MINUTES, timeframe = '1m' } = {}) {
  const key = String(symbol || '').toUpperCase();
  const minutes = Math.max(0, Number(delayMinutes) || 0);
  const today = istParts().date;
  const cutoff = fmtSql(new Date(Date.now() - minutes * 60_000));

  const [[front]] = await db.query(
    `SELECT MIN(expiry) AS e FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date AND sampled_at <= :cutoff`,
    { symbol: key, date: today, cutoff }
  );
  const frontExpiry = expiryKey(front?.e);

  if (frontExpiry) {
    const [rows] = await db.query(
      `SELECT sampled_at, call_vega_diff, put_vega_diff, vega_diff,
              current_call_vega, current_put_vega, open_call_vega, open_put_vega,
              price, atm_strike, call_strike_count, put_strike_count, expiry
         FROM vega_timeseries
        WHERE symbol = :symbol AND snapshot_date = :date
          AND expiry = :expiry AND sampled_at <= :cutoff
        ORDER BY sampled_at ASC`,
      { symbol: key, date: today, expiry: frontExpiry, cutoff }
    );

    if (rows.length) {
      const points = bucketByTimeframe(rows.map(rowToPoint), timeframe).map(decorate);
      return {
        date: today, expiry: frontExpiry, points, delayMinutes: minutes,
        isFallbackDay: false,
        asOf: points.length ? points[points.length - 1].time : null,
      };
    }
  }

  const [[latest]] = await db.query(
    `SELECT MAX(snapshot_date) AS d FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date < :today`,
    { symbol: key, today }
  );

  const fallbackDate = latest?.d ? toIsoDate(latest.d) : null;
  if (!fallbackDate) {
    return { date: today, expiry: null, points: [], delayMinutes: minutes, isFallbackDay: false, asOf: null };
  }

  const [[fallbackFront]] = await db.query(
    `SELECT MIN(expiry) AS e FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date`,
    { symbol: key, date: fallbackDate }
  );
  const fallbackExpiry = expiryKey(fallbackFront?.e);

  const points = await readStoredPoints(key, fallbackDate, timeframe, fallbackExpiry, null);
  return {
    date: fallbackDate, expiry: fallbackExpiry, points, delayMinutes: minutes,
    isFallbackDay: true,
    asOf: points.length ? points[points.length - 1].time : null,
  };
}

/**
 * Days that actually have stored samples, newest first — this drives the date
 * picker, so it also reports the session's first/last sample so the UI can label
 * each day with its real recording window rather than assuming 09:15.
 *
 * `expiry` narrows the list to days on which THAT contract was recorded, which
 * is what the date arrows need once an expiry is selected.
 */
async function listAvailableDates(symbol, limit = 120, expiry = null) {
  const key = String(symbol || '').toUpperCase();
  const [rows] = await db.query(
    `SELECT snapshot_date,
            COUNT(*)          AS points,
            MIN(sampled_at)   AS first_at,
            MAX(sampled_at)   AS last_at
       FROM vega_timeseries
      WHERE symbol = :symbol AND (:expiry IS NULL OR expiry = :expiry)
      GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT :limit`,
    { symbol: key, expiry: expiryKey(expiry) || null, limit: Math.max(1, Math.min(Number(limit) || 120, 400)) }
  );
  return rows.map((r) => ({
    date: toIsoDate(r.snapshot_date),
    points: Number(r.points),
    firstAt: toUnix(r.first_at),
    lastAt: toUnix(r.last_at),
  }));
}

/** MySQL hands these back as strings (dateStrings) or Dates depending on driver config. */
function toIsoDate(v) {
  if (!v) return null;
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}
function toUnix(v) {
  if (!v) return null;
  const iso = v instanceof Date ? v.toISOString() : `${String(v).replace(' ', 'T')}Z`;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * The nearest expiry TODAY's in-memory state can serve. Prefers an expiry that
 * already has samples; falls back to the nearest tracked contract so a caller
 * that asks before the first sample still gets a stable answer.
 */
function defaultLiveExpiry(symbol) {
  const key = String(symbol || '').toUpperCase();
  const withData = memoryExpiries(key).filter((e) => state.get(stateKey(key, e))?.series.length);
  if (withData.length) return withData[0];
  return trackedExpiries(key)[0] || memoryExpiries(key)[0] || null;
}

function getSeries(symbol, timeframe = '1m', expiry = null) {
  const key = String(symbol || '').toUpperCase();
  const chosen = expiryKey(expiry) || defaultLiveExpiry(key);
  if (!chosen) return [];
  const entry = state.get(stateKey(key, chosen));
  return bucketByTimeframe(entry?.series || [], timeframe).map(decorate);
}

/** Normalized day-open summary for TODAY's live series (used by routes). */
function getDayOpen(symbol, expiry = null) {
  return dayOpenSummaryFromPoints(getSeries(symbol, '1m', expiry));
}

/** Latest decorated point (unified engine — used by the market route too). */
function getLatest(symbol, expiry = null) {
  const s = getSeries(symbol, '1m', expiry);
  return s.length ? s[s.length - 1] : null;
}

function getStats() {
  return {
    sampling: sampleTask !== null,
    window: isSamplingWindow(),
    instrumentsReady: instrumentService.isReady(),
    subscription: subscriptionManager.getStats(),
    filterMode: 'abs',
    strikeMode: cfg.STRIKE_MODE,
    deltaMax: cfg.DELTA_MAX,
    strikeWindow: cfg.STRIKE_WINDOW,
    expiryCount: cfg.EXPIRY_COUNT,
    sampleCron: cfg.SAMPLE_CRON,
    persistResolution: cfg.PERSIST_RESOLUTION,
    recordedStocks: cfg.RECORDED_STOCKS,
    liveBufferPoints: cfg.LIVE_BUFFER_POINTS,
    marketWindow: { openMin: cfg.MARKET_OPEN_MIN, closeMin: cfg.MARKET_CLOSE_MIN },
    storeRawChains: cfg.STORE_RAW_CHAINS,
    demand: demandStats(),
    underlyings: [...state.values()].map((e) => ({
      symbol: e.symbol, expiry: e.expiry,
      hasBaseline: !!e.open, points: e.series.length,
      resolution: persistResolutionFor(e.symbol),
      start: startFor(e.symbol),
    })),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function start(latestTicks) {
  latestTicksRef = latestTicks;
  if (sampleTask) sampleTask.stop();

  sampleTask = cron.schedule(
    cfg.SAMPLE_CRON,
    () => { sampleAll().catch((err) => console.error('[VegaSeries] Sample failed:', err.message)); },
    { timezone: cfg.TIMEZONE }
  );

  console.log(`[VegaSeries] Recording scheduled '${cfg.SAMPLE_CRON}' (${cfg.STRIKE_MODE} strikes, ` +
    `${cfg.EXPIRY_COUNT} expiries/underlying, indices@${cfg.PERSIST_RESOLUTION.index} ` +
    `stocks@${cfg.PERSIST_RESOLUTION.stock}` +
    `${cfg.RECORDED_STOCKS.length ? ` +${cfg.RECORDED_STOCKS.length} recorded stock(s)` : ''}, ` +
    `records ${fmtMin(cfg.MARKET_OPEN_MIN)}-${fmtMin(cfg.MARKET_CLOSE_MIN)} ${cfg.TIMEZONE})`);

  sampleAll().catch((err) => console.error('[VegaSeries] Initial sample failed:', err.message));
}

function fmtMin(m) { return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; }

function stop() { if (sampleTask) { sampleTask.stop(); sampleTask = null; } }

/**
 * The server's idea of "today" in IST. Exported because the client must not
 * decide this from the browser clock — a user in another timezone (or with a
 * skewed clock) would otherwise ask for tomorrow and get an empty chart.
 */
function todayIst() { return istParts().date; }

module.exports = {
  start, stop, loadToday, sampleAll, captureDayOpen, ensureSubscriptions,
  getSeries, getDayOpen, getLatest, getStats, loadByDate, listAvailableDates,
  listExpiries, resolveExpiry, trackedExpiries, defaultLiveExpiry,
  registerDemand, releaseDemand, onTick,
  resolveSymbol, isIndex, persistResolutionFor, canServe, servableTimeframes,
  storedResolutions, bucketByTimeframe,
  loadDelayed, PUBLIC_DELAY_MINUTES,
  TIMEFRAMES: cfg.TIMEFRAMES, startFor, todayIst,
};
