'use strict';

const cron = require('node-cron');
const db = require('../config/db');
const optionChainService = require('./optionChainService');
const instrumentService = require('./instrumentService');
const chainSnapshotStore = require('./chainSnapshotStore');
const subscriptionManager = require('./subscriptionManager');
const constants = require('../constants/instruments');
const cfg = require('../config/vegaConfig');
// `round` is vegaMath's own 4dp rounding. Imported rather than re-implemented
// so a re-anchored value is rounded EXACTLY as computePoint rounds the value
// it was derived from — a second rounding rule would make the two disagree in
// the last decimal and put the table and the chart out of step.
const { computePoint, pickStrikes, round } = require('../utils/vegaMath');
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
/**
 * The IST trading date a point belongs to. Points carry UNIX seconds; the
 * session is an IST day, so the two only agree if the shift is explicit.
 */
function tradingDateOf(point) {
  if (!point || point.time == null) return null;
  return istParts(new Date(Number(point.time) * 1000)).date;
}

function stateKey(symbol, expiry) {
  return `${String(symbol).toUpperCase()}|${expiryKey(expiry)}`;
}

/**
 * The delta FLOOR for one underlying (parity item 5).
 *
 * Curated indices keep their per-name floors from cfg.DELTA_START, unchanged.
 * Everything else is an F&O stock and gets cfg.STOCK_START (0.20), so stocks run
 * the 0.20-0.60 band StockMojo / Alpha Edge use rather than falling through to
 * the index default of 0.05 and dragging a tail of illiquid far-OTM strikes into
 * both sums.
 *
 * One value, used for the Call sum, the Put sum and therefore the Difference —
 * they all come out of a single computePoint() call, so the three can never be
 * filtered differently.
 */
function startFor(symbol) {
  // B-06: delegates to vegaConfig.deltaStartFor so the Vega sums, the chain
  // payload and the option-chain table all read ONE definition of the band.
  return cfg.deltaStartFor(symbol);
}

/** Strikes either side of ATM to build/subscribe. Stocks use a tighter board. */
function strikeWindowFor(symbol) {
  return isIndex(symbol) ? cfg.STRIKE_WINDOW : cfg.STOCK_STRIKE_WINDOW;
}

/** How many expiries to track. Stock options are monthly — one is the front month. */
function expiryCountFor(symbol) {
  return isIndex(symbol) ? cfg.EXPIRY_COUNT : cfg.STOCK_EXPIRY_COUNT;
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
    .slice(0, expiryCountFor(c.key));
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
/**
 * Symbols the recorder samples with nobody watching (parity item 8).
 *
 * ORDER IS THE PRIORITY ORDER, because ensureSubscriptions() truncates this set
 * at cfg.TOKEN_BUDGET. Indices first — they are the five instruments the product
 * is built around and must never lose their slice to a stock. Then explicitly
 * named stocks, in the order the operator wrote them. Then, only if
 * RECORD_ALL_STOCKS is on, every remaining F&O name alphabetically, which is a
 * deterministic order so the same names are recorded across restarts rather than
 * the set churning with whatever the instrument dump happened to yield.
 */
function recordedSymbols() {
  const out = Object.values(UNDERLYINGS).map((c) => c.key);
  const seen = new Set(out);

  for (const name of cfg.RECORDED_STOCKS) {
    const c = resolveSymbol(name);
    if (!c) { vlog(`Ignoring VEGA_RECORDED_STOCKS entry '${name}': no live chain`); continue; }
    if (!seen.has(c.key)) { seen.add(c.key); out.push(c.key); }
  }

  if (cfg.RECORD_ALL_STOCKS && instrumentService.isReady()) {
    const all = instrumentService.listTradableUnderlyings()
      .filter((u) => u.derived)
      .map((u) => u.key)
      .sort();
    for (const key of all) if (!seen.has(key)) { seen.add(key); out.push(key); }
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
  /**
   * EACH SIDE IS CHECKED ON ITS OWN (baseline fix).
   *
   * This used to count a row as usable when EITHER side had a vega:
   *
   *     if (row.call?.vega || row.put?.vega) withGreeks += 1;
   *
   * At 09:15:00 on 2026-08-19 the NIFTY 25-Aug board had 60 of 61 calls priced
   * but only 39 of 61 puts - the puts had not traded yet. The OR scored that
   * ~98% and accepted it, so the PUT baseline was summed over a minority of
   * contracts. Every later point is `current - open`, so the entire session's
   * put series carried a constant offset of roughly +5 vega while the call side
   * looked fine. Shape matched the reference platforms; level did not.
   *
   * Requiring each side to clear the threshold separately makes the capture
   * fail and retry on the next tick until both sides are genuinely trading.
   * See tests/fixtures/openChain-2026-08-19-NIFTY-0915.json for that board.
   */
  let calls = 0;
  let puts = 0;
  for (const row of chain) {
    if (row.call?.vega) calls += 1;
    if (row.put?.vega) puts += 1;
  }
  return (calls / chain.length) >= minFraction
      && (puts / chain.length) >= minFraction;
}

/** Trim a built chain to the per-strike greeks the calculation/baseline need. */
function toGreekChain(chain) {
  return chain.map((r) => ({
    strike: r.strike,
    // ltp rides along so chainSnapshotStore can archive the traded price the IV
    // was solved from. Nothing in vegaMath reads it; it is audit data.
    call: { vega: g(r.call?.vega), theta: g(r.call?.theta), gamma: g(r.call?.gamma), delta: g(r.call?.delta), iv: g(r.call?.iv), ltp: g(r.call?.ltp) },
    put: { vega: g(r.put?.vega), theta: g(r.put?.theta), gamma: g(r.put?.gamma), delta: g(r.put?.delta), iv: g(r.put?.iv), ltp: g(r.put?.ltp) },
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
/**
 * Priority for the token budget. Lower sorts first and is subscribed first.
 *
 *   0  an index — the five the product is built around, never displaced.
 *   1  a target someone is actually looking at right now. A live view failing
 *      because a headless recorder ate the budget is the worst outcome here.
 *   2  a recorded stock, accumulating history for nobody in particular.
 */
function targetPriority(target) {
  if (isIndex(target.symbol)) return 0;
  return target.watched ? 1 : 2;
}

function ensureSubscriptions() {
  if (!instrumentService.isReady()) return null;

  const tokens = [];
  const detail = [];
  let dropped = 0;

  // Index spot tokens are always in the union via SUBSCRIBED_TOKENS, but a
  // stock's spot has to be added explicitly or its chain has no underlying.
  const ordered = activeTargets().sort((a, b) => targetPriority(a) - targetPriority(b));

  for (const target of ordered) {
    const c = resolveSymbol(target.symbol);
    if (!c) continue;

    const spot = c.spotToken != null ? latestTicksRef?.get(c.spotToken)?.lastPrice ?? null : null;
    const sel = instrumentService.getTokensForExpiry(c.key, target.expiry, {
      spot,
      strikeWindow: strikeWindowFor(c.key),
    });

    /**
     * TRUNCATE, DO NOT OVERFLOW.
     *
     * Kite's ~3,000-token cap is enforced on their side, and exceeding it does
     * not fail loudly — the ticker simply stops delivering some contracts, which
     * shows up much later as null Greeks and a rejected day-open on an
     * apparently random instrument. Stopping at the budget means an
     * over-ambitious recorded list costs coverage of the LOWEST-priority names,
     * visibly and deterministically, instead of corrupting everything.
     */
    const cost = sel.tokens.length + (c.spotToken != null ? 1 : 0);
    if (tokens.length + cost > cfg.TOKEN_BUDGET) { dropped += 1; continue; }

    tokens.push(...sel.tokens);
    if (c.spotToken != null) tokens.push(c.spotToken);
    detail.push(`${c.key}/${target.expiry}:${sel.tokens.length}`);
  }

  if (!tokens.length) return null;

  const result = subscriptionManager.setStandingTokens(STANDING_KEY, tokens);
  if (result.changed) {
    vlog(`Subscribed ${result.count} tokens across ${detail.length} targets`
      + (dropped ? ` (${dropped} target(s) dropped at the ${cfg.TOKEN_BUDGET}-token budget)` : ''), true);
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
      // Must match what ensureSubscriptions() actually subscribed, or the chain
      // is built over strikes that have no ticks and their Greeks come back null.
      strikeWindow: strikeWindowFor(c.key),
    });
    return { snap, expiry: chosen, price: spotTick.lastPrice, atmStrike: snap.atmStrike ?? null };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Day-open capture (PHP: the first market_open row of the day) — per expiry
// ---------------------------------------------------------------------------

/**
 * Must this slot capture a day-open baseline before it can be sampled?
 *
 * A NAMED PREDICATE BECAUSE THE OBVIOUS CONDITION IS THE WRONG ONE. The guard
 * in runSample used to read `!entry?.open` — "capture if there is no baseline"
 * — which is false precisely when the held baseline is STALE. captureDayOpen()
 * is where the day-rollover reset lives, so the one function that could have
 * noticed was skipped exactly when it was needed, and the new session's first
 * sample was measured against the PREVIOUS session's chain, then kept and
 * persisted. That row is today-dated and carries no trace of the mistake, so no
 * date filter anywhere downstream can catch it.
 *
 * The question is therefore not "is there a baseline" but "is there a baseline
 * FOR THIS SESSION". Extracted and exported so the distinction is asserted
 * against this function rather than against a copy of the expression in a test.
 */
/**
 * How late a stored baseline was taken, DERIVED from its `captured_at`.
 *
 * Every plotted value is `current - open`, so the baseline is the origin of the
 * chart. A baseline taken at 09:30 instead of 09:16 does not make the curve
 * wrong — the SHAPE is untouched — it moves the whole series by however far the
 * market travelled in between. That offset is invisible in the data and is
 * exactly what makes a correct implementation look broken next to a reference
 * chart anchored at the open.
 *
 * Derived rather than stored: `captured_at` has been written since the table
 * existed, so every historical row can be judged by this without a schema
 * change and without touching a single stored value.
 *
 * `capturedAt` is a UTC DATETIME string (persistDayOpen -> fmtSql -> toISOString)
 * or a Date. Both are read as UTC and compared in IST minutes.
 *
 * @returns {{capturedAtIst:string|null, minutesAfterOpen:number|null, late:boolean}}
 */
function baselineLateness(capturedAt) {
  if (!capturedAt) return { capturedAtIst: null, minutesAfterOpen: null, late: false };
  const ms = capturedAt instanceof Date
    ? capturedAt.getTime()
    : Date.parse(`${String(capturedAt).replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms)) return { capturedAtIst: null, minutesAfterOpen: null, late: false };

  const { minutes } = istParts(new Date(ms));
  return {
    capturedAtIst: fmtMin(minutes),
    minutesAfterOpen: minutes - cfg.MARKET_OPEN_MIN,
    late: minutes > cfg.BASELINE_MAX_IST,
  };
}

/**
 * ===========================================================================
 * INTRADAY RE-ANCHORING — one session, read path only, nothing stored.
 * ===========================================================================
 * Every value is `current − open`, so re-origining a series to a later moment
 * is subtraction, not a second capture:
 *
 *     newDiff(t) = oldDiff(t) − oldDiff(anchor)
 *              = [cur(t) − open] − [cur(anchor) − open]
 *              = cur(t) − cur(anchor)
 *
 * The old origin appears in both terms and cancels. That is the whole reason
 * this needs no option chain, no capture timing, and no write: it is exact
 * regardless of what the old baseline was, including a wrong one, and it can
 * be applied to a moment that has already passed.
 *
 * WHAT IT IS NOT. It does not create a baseline. `vega_day_open` is never read
 * differently, never written, never overwritten; the stored `vega_timeseries`
 * rows keep the exact meaning they were recorded with. Unset the config and
 * the normal view returns with no migration and nothing to undo.
 *
 * THE ONE APPROXIMATION, STATED HONESTLY. This is exact when the strike basket
 * is the same at `t` and at the anchor. STRIKE_MODE is 'stable' — the basket is
 * fixed at day-open and only leaves via the hysteresis exit — so drift is rare,
 * and when a strike does leave, it leaves both `cur` and `open`, so the terms
 * partially self-cancel rather than cancelling exactly. A freshly CAPTURED
 * 14:00 chain would differ from this by that second-order amount only.
 *
 * `openCallVega`/`openPutVega` are rewritten to the anchor's ABSOLUTE totals so
 * the day-open panel reports what this series is actually measured from rather
 * than a morning figure the points no longer relate to.
 */

/** The active intraday anchor for one trading date, or null. Date-scoped, so
 *  it can only ever affect the single session it names. */
function intradayAnchorFor(date) {
  const b = cfg.INTRADAY_BASELINE;
  return b && b.date === date ? b : null;
}

/** UNIX seconds of `minutes`-from-IST-midnight on an IST calendar date. */
function istMomentOf(date, minutes) {
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  return Math.floor(Date.parse(`${date}T${hh}:${mm}:00+05:30`) / 1000);
}

/**
 * Re-anchor RAW points to the first sample at or after the configured moment.
 *
 * Applied to raw points BEFORE bucketing, which is what makes the anchor
 * identical on every timeframe: 14:00 IST is a whole multiple of 60/180/300/900
 * seconds from the epoch, so the same sample opens the first bucket at 1m, 3m,
 * 5m and 15m alike. Re-anchoring after bucketing would let the anchor drift
 * with the timeframe.
 *
 * Points BEFORE the anchor are dropped, not zeroed: they were measured from a
 * different origin, and joining them to this series is the discontinuity this
 * exists to avoid.
 *
 * @returns {{points: Array, anchor: {time:number, label:string, callVega:number|null,
 *           putVega:number|null}|null, active: boolean}}
 */
function reanchorPoints(points, date) {
  const a = intradayAnchorFor(date);
  if (!a) return { points, anchor: null, active: false };

  const cutoff = istMomentOf(date, a.minutes);
  const idx = points.findIndex((p) => p.time >= cutoff);
  // The anchor has not been reached yet in this session's data. Serving the
  // pre-anchor points would be exactly the mixed series the caller asked to
  // avoid, so the honest answer is an empty one.
  if (idx < 0) return { points: [], anchor: null, active: true };

  const base = points[idx];
  const out = points.slice(idx).map((p) => {
    const call = round(p.callVegaDiff - base.callVegaDiff);
    const put = round(p.putVegaDiff - base.putVegaDiff);
    return {
      ...p,
      callVegaDiff: call,
      putVegaDiff: put,
      // Recomputed from the re-anchored pair rather than shifted, so the
      // Difference = Put − Call invariant is visibly preserved rather than
      // relied upon. Linearity makes the two identical.
      vegaDiff: round(put - call),
      openCallVega: base.currentCallVega ?? null,
      openPutVega: base.currentPutVega ?? null,
    };
  });

  return {
    points: out,
    anchor: {
      time: base.time,
      label: a.label,
      callVega: base.currentCallVega ?? null,
      putVega: base.currentPutVega ?? null,
    },
    active: true,
  };
}

function needsDayOpenCapture(entry, now = new Date()) {
  if (!entry?.open) return true;
  return entry.date !== istParts(now).date;
}

async function captureDayOpen(symbol, expiry) {
  const c = resolveSymbol(symbol);
  if (!c) return null;

  const chosen = expiryKey(expiry) || trackedExpiries(c.key)[0];
  if (!chosen) return null;

  const key = stateKey(c.key, chosen);
  const entry = state.get(key) || { symbol: c.key, expiry: chosen, date: istParts().date, open: null, series: [] };

  /**
   * A STALE SESSION IS NOT THIS SESSION.
   *
   * `if (entry.open) return entry.open` is right WITHIN a session — the
   * baseline is immutable once taken. Across sessions it was a trapdoor: a
   * process left running past midnight still held yesterday's entry, so this
   * returned yesterday's baseline and today's capture never ran at all. Today
   * then measured `current - open` against the PREVIOUS day's chain, the first
   * sample of the session was not zero, and openPutVega drifted sample to
   * sample as dynamic selection pulled different strikes out of a chain that
   * belonged to another day.
   *
   * This has to be checked BEFORE the immutability shortcut, or the shortcut
   * hides it — which is exactly what happened on 2026-08-20.
   */
  const todayIstDate = istParts().date;
  if (entry.date && entry.date !== todayIstDate) {
    entry.date = todayIstDate;
    entry.open = null;
    entry.series = [];
    state.set(key, entry);
  }

  if (entry.open) return entry.open; // immutable WITHIN the session

  /**
   * NOT BEFORE 09:16 IST (addvega.php parity).
   *
   * AlphaEdge gates every run on `$t2 = ... ' 9:16'`, so its day-open record is
   * taken a minute after the bell rather than on it. Ours took 09:15:00 - the
   * first instant of the session, when much of the board still carries
   * yesterday's close. Recording itself still begins at MARKET_OPEN_MIN; only
   * the baseline waits. Returning null here just defers to the next tick.
   */
  const nowMinutes = istParts().minutes;
  if (nowMinutes < cfg.BASELINE_MIN_IST) return null;

  const start = startFor(c.key);

  /**
   * ===================================================================
   * LATE CAPTURE: RECONSTRUCT THE REAL OPEN, OR SAY THAT WE COULD NOT.
   * ===================================================================
   * Past BASELINE_MAX_IST this is no longer "the open" — the process was down
   * at 09:16, or this instrument was first tracked mid-session. Taking the
   * board in front of us and calling it the day's open re-origins the entire
   * `current - open` series: the SHAPE stays right and the LEVEL is wrong by
   * however far the market moved first, with nothing saying so. That is what
   * made 2026-08-20 read +5.42 away from the same curve anchored at 09:15.
   *
   * If the raw-chain archive is on, the real 09:16 chain is already on disk and
   * is used instead — the only genuinely correct recovery. Otherwise the
   * capture still happens (a correct shape beats an empty chart) but it is
   * marked late and reported, so the UI can state what the numbers are measured
   * from rather than implying 09:15.
   */
  let openChain = null;
  let capturedAt = new Date();
  let reconstructed = false;
  const late = nowMinutes > cfg.BASELINE_MAX_IST;

  if (late) {
    const archived = await chainSnapshotStore
      .earliestChain(c.key, istParts().date, chosen, fmtMin(cfg.BASELINE_MIN_IST) + ':00')
      .catch(() => null);

    if (archived && isUsableOpenChain(archived.chain, cfg.BASELINE_MIN_SIDE_FRACTION)) {
      openChain = toGreekChain(archived.chain);
      // The archived row's own timestamp, so the recovered baseline reports
      // when it was really taken rather than when it was recovered.
      capturedAt = new Date(`${String(archived.sampledAt).replace(' ', 'T')}Z`);
      reconstructed = true;
      console.log(`[VegaSeries] Day-open RECONSTRUCTED for ${c.key} ${chosen} from the raw-chain `
        + `archive at ${archived.sampledAt} UTC — the live board was ${nowMinutes - cfg.BASELINE_MIN_IST} `
        + `minute(s) too late to be the open`);
    }
  }

  if (!openChain) {
    const built = buildChainFor(c.key, chosen);
    if (!built) return null;

    const fresh = toGreekChain(built.snap.chain);
    if (!fresh.length) return null;

    if (!isUsableOpenChain(fresh, cfg.BASELINE_MIN_SIDE_FRACTION)) {
      vlog(`Rejected day-open for ${c.key} ${chosen}: Greeks mostly null (stale ticks?) — retrying next tick`, true);
      return null;
    }
    openChain = fresh;

    if (late) {
      console.warn(`[VegaSeries] LATE day-open for ${c.key} ${chosen}: captured at `
        + `${fmtMin(nowMinutes)} IST, ${nowMinutes - cfg.MARKET_OPEN_MIN} minute(s) after the bell, `
        + `and no raw-chain archive to reconstruct from (VEGA_STORE_RAW_CHAINS=`
        + `${cfg.STORE_RAW_CHAINS}). Today's ${c.key} series is measured from `
        + `${fmtMin(nowMinutes)}, NOT from the open — the shape is correct, the level is offset.`);
    }
  }

  // The strike lists selected AT OPEN — used only by 'frozen' mode.
  const frozen = pickStrikes(openChain, start, cfg.DELTA_MAX);

  const open = {
    date: istParts().date,
    symbol: c.key,
    expiry: chosen,
    capturedAt,
    chain: openChain,
    frozenCallStrikes: frozen.callStrikes,
    frozenPutStrikes: frozen.putStrikes,
  };

  entry.open = open;
  state.set(key, entry);

  await persistDayOpen(open).catch((err) =>
    console.warn(`[VegaSeries] Day-open persist failed for ${c.key} ${chosen}:`, err.message));

  console.log(`[VegaSeries] Day-open captured for ${c.key} ${chosen}: ${openChain.length} strikes ` +
    `(${frozen.callStrikes.length} call / ${frozen.putStrikes.length} put eligible at open)` +
    `${reconstructed ? ' [reconstructed from archive]' : ''}${late && !reconstructed ? ' [LATE]' : ''}`);
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

  // STABLE (default): the day-open basket is held for the session with a
  // hysteresis exit, so the sums are measured on the same contracts every sample
  // and the curve stops sawtoothing on ATM churn. 'dynamic' recomputes the band
  // from the current chain (addvega.php literal); 'frozen' never drops anything.
  // The METHODOLOGY is identical for indices and stocks — only the delta floor
  // differs (startFor), which is the one thing parity item 5 asked to differ.
  const point = computePoint({
    currentChain,
    openChain: entry.open.chain,
    start,
    deltaMax: cfg.DELTA_MAX,
    mode: cfg.STRIKE_MODE,
    hysteresis: cfg.STRIKE_HYSTERESIS,
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
  /**
   * DAY ROLLOVER (trading-date isolation).
   *
   * `state` is keyed by SYMBOL|EXPIRY, deliberately — the expiry outlives the
   * day. But the buffer inside it does not: it belongs to ONE session. The only
   * thing that used to clear it was loadToday(), which runs once at boot, so a
   * process left running across midnight kept yesterday's tail and appended
   * today's points to it. The terminal then showed 15:30 rows from the previous
   * session sitting above 09:15 rows from this one.
   *
   * A point whose IST trading date differs from the buffer's starts the buffer
   * again. The rows are still on disk; only the in-memory view resets.
   */
  const pointDate = tradingDateOf(point);
  if (pointDate && entry.date && entry.date !== pointDate) {
    entry.series = [];
    entry.open = null;
    entry.date = pointDate;
  } else if (pointDate && !entry.date) {
    entry.date = pointDate;
  }

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

/**
 * Re-entrancy guard for the sampler.
 *
 * THIS IS NOT OPTIONAL AT A 5s CLOCK. sampleAll is async and does real work —
 * one option-chain build per active target, each solving IV for ~122 contracts,
 * plus the DB write. At the old 60s cadence a run could never plausibly overlap
 * itself. At 5s it can, and the failure mode is not a dropped sample: two
 * concurrent runs compete for the same CPU, so BOTH take longer, so the next
 * tick is more likely to overlap too. That feedback loop degrades from "fine"
 * to "process wedged, event loop starved, every HTTP route timing out" over
 * tens of minutes — observed live at ~240MB RSS after ~90 minutes.
 *
 * Skipping the tick is the correct response rather than queueing it: the next
 * boundary is five seconds away, and a sample of stale ticks is worth less than
 * the headroom to catch up.
 */
let sampleInFlight = false;
let skippedTicks = 0;

async function sampleAll(now = new Date()) {
  if (sampleInFlight) {
    skippedTicks += 1;
    vlog(`Skipped: previous sample still running (${skippedTicks} total) — the clock is faster than one pass`, false);
    return;
  }
  sampleInFlight = true;
  try {
    await runSample(now);
  } finally {
    sampleInFlight = false;
  }
}

async function runSample(now) {
  // Subscribe BEFORE the window check, not after.
  //
  // The cron fires from 09:00 while the sampling window opens at 09:15, so
  // those first ticks give Kite ~15 minutes to start streaming the option
  // contracts. Doing it after the early-return would mean subscribing at
  // 09:15:00 and reading the cache in the same breath — empty, so the 09:15
  // day-open would always be rejected and the baseline would slip a tick.
  ensureSubscriptions();

  if (!isSamplingWindow(now)) { vlog('Skipped: market closed (outside window or weekend)'); return; }

  /**
   * SNAP TO THE BASE CLOCK before deciding anything.
   *
   * node-cron fires somewhere inside its target second — measured up to 962ms
   * in, which leaves 38ms before the observed second rolls over — and any
   * event-loop delay (a chain build running long, GC) adds to that. Taking
   * `Math.floor(now/1000)` raw therefore lands on second 21 instead of 20 often
   * enough to matter, and `21 % 5` is not 0, so the sample would be silently
   * dropped. For a stock persisting at 1m that is a whole minute of data gone.
   *
   * FLOOR, not round-to-nearest. node-cron fires AT or AFTER its boundary,
   * never before, so flooring recovers the intended boundary for any delay
   * shorter than one interval. Rounding looked equivalent but tolerated only
   * half an interval: a tick more than 2.5s late snapped FORWARD onto the next
   * boundary, the following tick snapped onto the same one, and the boundary
   * between them was never written. Measured on live index data, that residual
   * was still costing ~2.8% of samples after the first fix.
   *
   * It also makes every stored timestamp exactly bucket-aligned, so aggregation
   * and the live push land on identical x values without relying on the clock
   * having been punctual.
   */
  const base = tfSeconds(cfg.BASE_RESOLUTION) || 5;
  const epoch = Math.floor(now.getTime() / 1000 / base) * base;
  const sampledAt = new Date(epoch * 1000);

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

    /**
     * THE STALENESS CHECK MUST DECIDE THIS, NOT THE PRESENCE OF A BASELINE.
     *
     * captureDayOpen() is where the day-rollover reset lives — but it was only
     * reached when `entry.open` was falsy, which is exactly the condition a
     * STALE baseline fails to meet. So on the first tick of a new session the
     * held entry still carried yesterday's `open`, this guard read it as "the
     * baseline is already taken", and computeDiffs() went on to measure the new
     * day's first sample against the PREVIOUS day's chain. appendLive() then
     * reset the buffer and kept that one point, which was persisted too — a
     * today-dated row that no date filter can catch, because its timestamp is
     * genuinely today's. One bad sample per symbol/expiry per day.
     *
     * Asking about the DATE as well closes it: a stale entry now enters
     * captureDayOpen(), which resets it and captures a fresh baseline (or
     * returns null before 09:16, in which case computeDiffs correctly produces
     * nothing until the real baseline exists).
     */
    if (needsDayOpenCapture(state.get(key), now)) {
      await captureDayOpen(target.symbol, target.expiry);
    }

    const point = computeDiffs(target.symbol, target.expiry, sampledAt);
    if (!point) continue;

    const chain = point._chain;
    delete point._chain;

    const entry = state.get(key);
    appendLive(key, entry, point);
    updated.push({ symbol: target.symbol, expiry: target.expiry, point });

    if (persistNow) {
      written.push({ symbol: target.symbol, resolution, ...point });
      // Only retain the full per-strike chain when something will actually
      // store it. chainSnapshotStore.persist() is a no-op unless
      // VEGA_STORE_RAW_CHAINS is on, so without this guard every tick built and
      // held ~15 x 61-strike chains purely to hand them to a function that
      // discards them — pointless garbage pressure twelve times a minute.
      if (chain && cfg.STORE_RAW_CHAINS) {
        rawSnaps.push({ symbol: target.symbol, expiry: point.expiry, sampledAt: new Date(point.time * 1000), chain });
      }
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
        date: today,
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
        || { symbol: String(r.symbol).toUpperCase(), expiry, date: today, open: null, series: [] };
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

/**
 * THE DISPLAY LAYER (parity item 1) — the single place the sign convention is
 * applied, and the single place the trend label is derived.
 *
 * Every read path in the application funnels through here: getSeries() for the
 * live buffer, readStoredPoints() for history, loadDelayed() for the public
 * teaser, vegaStreamService for the WebSocket push, and the Excel export. That
 * is deliberate — a sign convention applied in four places is a sign convention
 * that will disagree with itself the first time one of them is edited.
 *
 * WHAT IS FLIPPED
 *   callVegaDiff, putVegaDiff, vegaDiff — the three plotted/tabulated series,
 *   multiplied by cfg.DISPLAY_SIGN (-1 by default) to match StockMojo and Alpha
 *   Edge. The flip is self-consistent because diff3 is linear in diff1/diff2:
 *   -(put - call) === (-put) - (-call), so Difference still reads as
 *   PutVega - CallVega in displayed terms.
 *
 * WHAT IS NOT FLIPPED
 *   currentCallVega / currentPutVega / openCallVega / openPutVega are absolute
 *   vega TOTALS, not differences. They are non-negative sums and negating them
 *   would be meaningless — the day-open panel would read "-1,284.30 of vega".
 *
 *   The TREND. classifyTrend's rules (datav1.php) are stated over the STORED
 *   diffs, where calls gaining vega while puts lose it is a rally and therefore
 *   Bullish. Feeding it the display-signed pair would relabel every rally as
 *   Bearish — the exact opposite of parity — so it is always given the raw
 *   values. Sign parity and trend parity are two different requirements and this
 *   is the line between them.
 *
 * NOTHING WRITTEN TO MYSQL PASSES THROUGH HERE. persistSamples() writes the raw
 * computePoint() output, so historical rows recorded before this change and rows
 * recorded after it mean exactly the same thing, and flipping
 * VEGA_DISPLAY_SIGN back to 1 restores the old presentation with no migration.
 */
function decorate(p) {
  // Raw, stored values — the economic convention the trend rules are written in.
  const t = classifyTrend(p.callVegaDiff, p.putVegaDiff);
  const s = cfg.DISPLAY_SIGN;

  const flip = (v) => (v == null || !Number.isFinite(Number(v)) ? v : Number(v) * s);

  return {
    ...p,
    callVegaDiff: flip(p.callVegaDiff),
    putVegaDiff: flip(p.putVegaDiff),
    vegaDiff: flip(p.vegaDiff),
    trend: t.label,
    trendKey: t.key,
    trendColor: t.color,
    /**
     * B-08: state the convention rather than leaving it to be inferred.
     *
     * The three plotted series are multiplied by DISPLAY_SIGN (-1 by default)
     * while the trend is classified from the UNFLIPPED values. That is
     * deliberate — the datav1.php rules are stated in the engine's economic
     * convention, where calls gaining vega while puts lose it is a rally and
     * therefore Bullish — but the visible consequence is that a RISING green
     * Call Vega line accompanies a 'Bearish' pill, which reads as a
     * contradiction to anyone who has not been told.
     *
     * The maths is NOT changed here: inverting the trend would relabel every
     * historical point, and whether it should be inverted is a parity question
     * about the reference platform, not a question this code can answer. This
     * field lets the UI explain the relationship instead.
     */
    trendConvention: s === -1 ? 'series-inverted' : 'series-raw',
  };
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
  /**
   * NO EARLY RETURN FOR A SINGLE POINT (B-10).
   *
   * `if (points.length < 2) return points;` handed the caller an UNBUCKETED
   * point: the session's first sample kept its raw 5s timestamp instead of its
   * bucket start, then jumped onto the boundary the moment a second sample
   * arrived. That jump changes `firstTime`, which defeats VegaChart's append
   * heuristic and forces a full setData + axis re-fit — so the first minute of
   * every session visibly flickered. The loop below already handles a
   * single-element array correctly, so the special case was never needed.
   */
  if (!points.length) return points;
  const out = [];
  let bucket = null;
  let last = null;
  for (const p of points) {
    const b = bucketStartFor(p.time, timeframe);
    if (bucket !== null && b !== bucket) out.push({ ...last, time: bucket });
    bucket = b;
    last = p;
  }
  if (last) out.push({ ...last, time: bucket });
  return out;
}

/**
 * THE bucket rule (B-01). One definition, used by the historical aggregator
 * above AND by the live WebSocket push in vegaStreamService.
 *
 * Boundaries are absolute against the UNIX epoch, so they are stable across
 * days, instruments and process restarts — two servers bucketing the same
 * sample always agree.
 */
function bucketStartFor(time, timeframe = '1m') {
  const seconds = tfSeconds(timeframe) || 60;
  return Math.floor(Number(time) / seconds) * seconds;
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
  // Re-anchor BEFORE bucketing, so the origin is the same SAMPLE on every
  // timeframe rather than the first bucket each timeframe happens to open.
  // No-op unless this exact trading date is the configured one.
  const { points } = reanchorPoints(rows.map(rowToPoint), date);

  return bucketByTimeframe(points, timeframe).map(decorate);
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
    const capturedAt = rows[0].captured_at || null;
    return { expiry: expiryKey(rows[0].expiry), capturedAt, ...baselineLateness(capturedAt) };
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

  /**
   * ONE REQUESTED DATE = ONE DATASET.
   *
   * Whatever the source — live buffer or SQL — nothing may leave this function
   * that belongs to another trading session. This is a boundary, not a filter:
   * if a point from another date ever reaches here again, it is dropped and
   * counted rather than rendered.
   */
  const foreign = points.filter((p) => {
    const d = tradingDateOf(p);
    return d && d !== date;
  }).length;
  if (foreign) {
    points = points.filter((p) => {
      const d = tradingDateOf(p);
      return !d || d === date;
    });
    console.warn(`[VegaSeries] Dropped ${foreign} point(s) from another trading date `
      + `for ${key} ${date} ${chosen || ''} — investigate the source.`);
  }

  /**
   * NAME the origin for the payload. `points` has already been re-anchored by
   * getSeries/readStoredPoints, so this cannot change any number — deriving the
   * anchor from the anchored points would just report 0. It exists so the UI
   * can say WHICH origin these values are measured from, which is the one thing
   * that must never be ambiguous: a re-anchored session is numerically
   * indistinguishable from a normal one.
   */
  const intraday = intradayAnchorFor(date);
  const anchorPoint = intraday && points.length ? points[0] : null;

  const meta = await loadDayOpenMeta(key, date, chosen);
  const summary = dayOpenSummaryFromPoints(points);

  const dayOpen = summary || meta
    ? { callVega: null, putVega: null, callStrikes: null, putStrikes: null, ...(summary || {}), ...(meta || {}) }
    : null;

  return {
    points,
    dayOpen,
    live,
    // The session this dataset belongs to, stated rather than inferred from
    // the points (which may legitimately be empty) or from the expiry.
    tradingDate: date,
    expiry: chosen,
    timeframe,
    // Served from the live buffer -> the base clock, whatever this instrument
    // PERSISTS at. Reporting PERSIST_RESOLUTION.index here (as this once did)
    // labelled a live stock '5s' purely because indices store at 5s, which is
    // an answer about the wrong instrument.
    resolution: resolution || (live && !fromStore && points.length ? cfg.BASE_RESOLUTION : null),
    storedResolutions: available,
    unavailable,
    hasBaseline: !!(meta || summary || (live && chosen && state.get(stateKey(key, chosen))?.open)),
    fromStore,
    /**
     * Present ONLY while this session is served re-anchored. Its presence is
     * what tells the client to label the chart an intraday verification
     * baseline rather than letting the reader assume the market open.
     */
    intradayBaseline: intraday
      ? {
        type: 'intraday_verification',
        tradingDate: date,
        label: intraday.label,
        anchorTime: anchorPoint ? anchorPoint.time : null,
        callVega: anchorPoint?.openCallVega ?? null,
        putVega: anchorPoint?.openPutVega ?? null,
        reached: !!anchorPoint,
      }
      : null,
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
    /**
     * PIN TO ONE RESOLUTION.
     *
     * A single day can legitimately hold rows at more than one resolution — the
     * day an index is promoted from 1m to 5s has both, and so does any day
     * spanning a config change. Reading them together returns two rows for
     * every minute boundary: bucketByTimeframe would hide most of it (last
     * value wins per bucket), which is exactly what makes it the kind of bug
     * that survives review and then shows up as a doubled point count.
     */
    const dayResolution = pickResolution(
      await storedResolutions(key, today, frontExpiry), timeframe
    );

    /**
     * B-09: when NO stored resolution can build this timeframe, do NOT fall
     * through with a null filter.
     *
     * `(:resolution IS NULL OR resolution = :resolution)` becomes a no-op on
     * null, which reads EVERY resolution together — the exact doubling the note
     * above warns about, and the one bucketByTimeframe would then hide behind
     * last-value-wins. An honest empty answer is the correct one: a 1m row
     * genuinely cannot be split into a 15s bar.
     */
    if (!dayResolution) {
      return {
        date: today, expiry: frontExpiry, points: [], delayMinutes: minutes,
        isFallbackDay: false, asOf: null,
        unavailable: { reason: 'resolution', timeframe },
      };
    }

    const [rows] = await db.query(
      `SELECT sampled_at, call_vega_diff, put_vega_diff, vega_diff,
              current_call_vega, current_put_vega, open_call_vega, open_put_vega,
              price, atm_strike, call_strike_count, put_strike_count, expiry
         FROM vega_timeseries
        WHERE symbol = :symbol AND snapshot_date = :date
          AND expiry = :expiry AND sampled_at <= :cutoff
          AND (:resolution IS NULL OR resolution = :resolution)
        ORDER BY sampled_at ASC`,
      { symbol: key, date: today, expiry: frontExpiry, cutoff, resolution: dayResolution || null }
    );

    if (rows.length) {
      // The public teaser is re-anchored too. A session whose origin is known
      // to be wrong should not be shown mis-anchored to anyone, and letting the
      // public and premium views disagree about the same minute would be worse
      // than either alone.
      const { points: reAnchored } = reanchorPoints(rows.map(rowToPoint), today);
      const points = bucketByTimeframe(reAnchored, timeframe).map(decorate);
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

  // Same one-resolution rule — and the same refusal to drop it (B-09).
  const fallbackResolution = pickResolution(
    await storedResolutions(key, fallbackDate, fallbackExpiry), timeframe
  );
  if (!fallbackResolution) {
    return {
      date: fallbackDate, expiry: fallbackExpiry, points: [], delayMinutes: minutes,
      isFallbackDay: true, asOf: null,
      unavailable: { reason: 'resolution', timeframe },
    };
  }
  const points = await readStoredPoints(key, fallbackDate, timeframe, fallbackExpiry, fallbackResolution);
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
  // A buffer left over from a previous session is not today's data. Serving it
  // is what mixed 15:30 rows into a 09:15 chart; an empty answer sends the
  // caller to the historical read path, which is date-filtered in SQL.
  const today = istParts().date;
  if (entry?.date && entry.date !== today) return [];

  const { points } = reanchorPoints(entry?.series || [], today);
  return bucketByTimeframe(points, timeframe).map(decorate);
}

/**
 * The RAW anchor sample for a live series, or null.
 *
 * The WebSocket pushes one point at a time and therefore cannot re-anchor by
 * looking at an array — it needs the anchor's own values to subtract. Reading
 * them from the same live buffer getSeries() re-anchors guarantees the
 * incremental push and the back-fill agree; deriving them separately is how a
 * streaming chart drifts away from the one a reload produces.
 */
function liveAnchorBase(symbol, expiry) {
  const key = String(symbol || '').toUpperCase();
  const chosen = expiryKey(expiry) || defaultLiveExpiry(key);
  if (!chosen) return null;

  const today = istParts().date;
  const a = intradayAnchorFor(today);
  if (!a) return null;

  const entry = state.get(stateKey(key, chosen));
  if (!entry || entry.date !== today) return null;

  const cutoff = istMomentOf(today, a.minutes);
  return entry.series.find((p) => p.time >= cutoff) || null;
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

/**
 * Nightly retention sweep (parity item 8) — keep cfg.RETENTION_DAYS of history.
 *
 * Lives here rather than inline in index.js so the three vega tables are always
 * pruned together and against the SAME cutoff. Splitting them is how you end up
 * with orphaned baselines: vega_day_open rows for days whose samples are gone,
 * which then show up in the date picker as sessions with zero points.
 *
 * Compared against snapshot_date (the IST trading day) on every table, which is
 * what the read path and the date picker key off.
 */
async function purgeOldHistory(days = cfg.RETENTION_DAYS) {
  const keep = Math.max(1, Number(days) || cfg.RETENTION_DAYS);
  const out = {};
  for (const table of ['vega_timeseries', 'vega_day_open', 'vega_chain_snapshots']) {
    try {
      const [res] = await db.query(
        `DELETE FROM \`${table}\` WHERE snapshot_date < CURDATE() - INTERVAL :keep DAY`,
        { keep }
      );
      out[table] = res.affectedRows || 0;
    } catch (err) {
      // A missing optional table (chain snapshots on an install that never
      // enabled them) must not abort the sweep of the two that matter.
      out[table] = null;
      console.warn(`[VegaSeries] Retention sweep skipped ${table}: ${err.message}`);
    }
  }
  return { retentionDays: keep, deleted: out };
}

function getStats() {
  return {
    sampling: sampleTask !== null,
    window: isSamplingWindow(),
    instrumentsReady: instrumentService.isReady(),
    subscription: subscriptionManager.getStats(),
    filterMode: 'abs',
    // Which pricing/identifiability rules are live, so /api/vega/status answers
    // "what produced these numbers" without reading the environment by hand.
    forwardMode: process.env.VEGA_FORWARD_MODE === 'matched' ? 'matched' : 'nearest',
    ivIdentifiability: require('../utils/impliedVolatility').IDENTIFIABILITY_MODE,
    trendConvention: cfg.DISPLAY_SIGN === -1 ? 'series-inverted' : 'series-raw',
    strikeMode: cfg.STRIKE_MODE,
    strikeHysteresis: cfg.STRIKE_HYSTERESIS,
    // -1 means the served series are the negation of the stored PHP-signed
    // values (StockMojo / Alpha Edge convention). See decorate().
    displaySign: cfg.DISPLAY_SIGN,
    stockStart: cfg.STOCK_START,
    retentionDays: cfg.RETENTION_DAYS,
    tokenBudget: cfg.TOKEN_BUDGET,
    recordAllStocks: cfg.RECORD_ALL_STOCKS,
    deltaMax: cfg.DELTA_MAX,
    strikeWindow: cfg.STRIKE_WINDOW,
    stockStrikeWindow: cfg.STOCK_STRIKE_WINDOW,
    expiryCount: cfg.EXPIRY_COUNT,
    sampleCron: cfg.SAMPLE_CRON,
    baseResolution: cfg.BASE_RESOLUTION,
    // Ticks dropped because the previous pass had not finished. Zero is
    // healthy; a climbing number means one pass no longer fits in one interval
    // and the active set or STRIKE_WINDOW needs to come down.
    skippedTicks,
    sampleInFlight,
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
  storedResolutions, bucketByTimeframe, bucketStartFor, isUsableOpenChain, tradingDateOf,
  needsDayOpenCapture, baselineLateness,
  reanchorPoints, intradayAnchorFor, istMomentOf, liveAnchorBase,
  loadDelayed, PUBLIC_DELAY_MINUTES,
  // Exported so the WebSocket push uses the SAME sign convention and trend
  // derivation as every other reader — see decorate()'s header.
  decorate,
  purgeOldHistory,
  TIMEFRAMES: cfg.TIMEFRAMES, startFor, strikeWindowFor, expiryCountFor, todayIst,
  // Same pattern as vegaStreamService: the day-rollover reset lives in the
  // in-memory buffer, so a test needs to reach it directly.
  __test: { state, stateKey, appendLive },
};
