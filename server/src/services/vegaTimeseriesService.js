'use strict';

const cron = require('node-cron');
const db = require('../config/db');
const optionChainService = require('./optionChainService');
const instrumentService = require('./instrumentService');
const chainSnapshotStore = require('./chainSnapshotStore');
const subscriptionManager = require('./subscriptionManager');
const { getUnderlying, UNDERLYINGS } = require('../constants/instruments');
const cfg = require('../config/vegaConfig');
const { computePoint, pickStrikes } = require('../utils/vegaMath');
const { classifyTrend } = require('../utils/vegaTrend');

/**
 * Vega Analysis — a faithful port of the PHP `addvega.php` algorithm onto the
 * Zerodha + Node stack. The arithmetic lives in utils/vegaMath.js; this module
 * builds the chains, freezes the day-open baseline, samples every minute, and
 * persists / serves the series. The Bullish/Bearish/Sideways label is derived
 * on read by utils/vegaTrend.js (datav1.php rules).
 *
 * WHAT CHANGED FOR PARITY (vs the previous version of this file):
 *   1. STRIKE SELECTION IS NOW DYNAMIC. Every minute the eligible Call/Put
 *      strike lists are recomputed from the CURRENT chain (cfg.STRIKE_MODE
 *      'dynamic'), then looked up in the frozen day-open chain — exactly like
 *      addvega.php. The old behaviour (freeze the lists at open) is still
 *      available as cfg.STRIKE_MODE 'frozen'.
 *   2. THE DAY-OPEN BASELINE NOW STORES THE FULL PER-STRIKE CHAIN, not just
 *      summed totals, because a dynamic strike set must be re-summed against
 *      the morning chain each minute.
 *   3. All thresholds / timings / modes come from config/vegaConfig.js.
 *
 * Greeks note: PHP got Greeks pre-baked from Upstox. Here they are computed by
 * optionChainService.buildChain() (IV solved from LTP, then Black-Scholes).
 * Same methodology, different source — see the final report for why the
 * numbers cannot be byte-identical.
 */

// --- diagnostic logging (throttled to once/min per distinct reason) --------
const _lastLog = new Map();
function vlog(reason, force = false) {
  const now = Date.now();
  if (!force && _lastLog.get(reason) && now - _lastLog.get(reason) < 60_000) return;
  _lastLog.set(reason, now);
  console.log(`[VegaSeries] ${reason}`);
}

// symbol -> { open: <baseline|null>, series: [rawPoint] }
const state = new Map();

let sampleTask = null;
let latestTicksRef = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startFor(symbol) {
  return cfg.DELTA_START[String(symbol || '').toUpperCase()] ?? cfg.DEFAULT_START;
}

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
 * so refuse to freeze it and let captureDayOpen retry on the next sample.
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
// Standing Kite subscription for the sampler
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
 * Re-registers on every tick (cheap; setStandingTokens no-ops when unchanged),
 * which also means an expiry rollover is picked up automatically.
 */
function ensureSubscriptions() {
  if (!instrumentService.isReady()) return null;

  const tokens = [];
  const detail = [];

  for (const c of Object.values(UNDERLYINGS)) {
    const expiries = instrumentService.getExpiries(c.key);
    if (!expiries.length) continue;

    const spot = latestTicksRef?.get(c.spotToken)?.lastPrice ?? null;
    const sel = instrumentService.getTokensForExpiry(c.key, expiries[0], {
      spot,
      strikeWindow: cfg.STRIKE_WINDOW,
    });

    tokens.push(...sel.tokens, c.spotToken);
    detail.push(`${c.key}:${sel.tokens.length}`);
  }

  if (!tokens.length) return null;

  const result = subscriptionManager.setStandingTokens(STANDING_KEY, tokens);
  if (result.changed) {
    vlog(`Subscribed ${result.count} tokens for recording (${detail.join(' ')})`, true);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Building one chain snapshot for a symbol
// ---------------------------------------------------------------------------

function buildChainFor(symbol) {
  const c = getUnderlying(symbol);
  if (!c) { vlog(`Skipped ${symbol}: unknown underlying`); return null; }
  if (!instrumentService.isReady()) { vlog(`Skipped ${symbol}: instrument master not ready`); return null; }

  const expiries = instrumentService.getExpiries(c.key);
  if (!expiries.length) { vlog(`Skipped ${c.key}: no expiry available`); return null; }

  const spotTick = latestTicksRef?.get(c.spotToken);
  if (spotTick?.lastPrice == null) { vlog(`Skipped ${c.key}: no live spot tick (feed idle?)`); return null; }

  try {
    const snap = optionChainService.buildChain({
      symbol: c.key,
      expiry: expiries[0],
      latestTicks: latestTicksRef,
      strikeWindow: cfg.STRIKE_WINDOW,
    });
    return { snap, expiry: expiries[0], price: spotTick.lastPrice };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Day-open capture (PHP: the first market_open row of the day)
// ---------------------------------------------------------------------------

async function captureDayOpen(symbol) {
  const c = getUnderlying(symbol);
  if (!c) return null;

  const entry = state.get(c.key) || { open: null, series: [] };
  if (entry.open) return entry.open; // immutable for the session

  const built = buildChainFor(c.key);
  if (!built) return null;

  const start = startFor(c.key);
  const openChain = toGreekChain(built.snap.chain);
  if (!openChain.length) return null;

  if (!isUsableOpenChain(openChain)) {
    vlog(`Rejected day-open for ${c.key}: Greeks mostly null (stale ticks?) — retrying next minute`, true);
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
  state.set(c.key, entry);

  await persistDayOpen(open).catch((err) =>
    console.warn(`[VegaSeries] Day-open persist failed for ${c.key}:`, err.message));

  console.log(`[VegaSeries] Day-open captured for ${c.key}: ${openChain.length} strikes ` +
    `(${frozen.callStrikes.length} call / ${frozen.putStrikes.length} put eligible at open)`);
  return open;
}

// ---------------------------------------------------------------------------
// Per-minute sample (PHP: the vega_chart INSERT)
// ---------------------------------------------------------------------------

function computeDiffs(symbol) {
  const entry = state.get(symbol);
  if (!entry?.open) { vlog(`Skipped ${symbol}: no day-open baseline yet`); return null; }

  const built = buildChainFor(symbol);
  if (!built) return null;

  const start = startFor(symbol);
  const currentChain = toGreekChain(built.snap.chain);

  // THE PARITY CHANGE: dynamic strike set recomputed from the CURRENT chain,
  // then looked up in the day-open chain (addvega.php). 'frozen' reuses the
  // 09:16 lists instead.
  const point = computePoint({
    currentChain,
    openChain: entry.open.chain,
    start,
    deltaMax: cfg.DELTA_MAX,
    mode: cfg.STRIKE_MODE,
    frozenStrikes: { callStrikes: entry.open.frozenCallStrikes, putStrikes: entry.open.frozenPutStrikes },
  });

  return {
    time: Math.floor(Date.now() / 1000),
    callVegaDiff: point.callVegaDiff,
    putVegaDiff: point.putVegaDiff,
    vegaDiff: point.vegaDiff,
    currentCallVega: point.currentCallVega,
    currentPutVega: point.currentPutVega,
    openCallVega: point.openCallVega,
    openPutVega: point.openPutVega,
    price: built.price,
    callStrikeCount: point.callStrikeCount,
    putStrikeCount: point.putStrikeCount,
    expiry: built.expiry,
    _chain: currentChain, // transient, for optional raw storage; never served
  };
}

async function sampleAll() {
  // Subscribe BEFORE the window check, not after.
  //
  // The cron fires from 09:00 while the sampling window opens at 09:15, so
  // those first ticks give Kite ~15 minutes to start streaming the option
  // contracts. Doing it after the early-return would mean subscribing at
  // 09:15:00 and reading the cache in the same breath — empty, so the 09:15
  // day-open would always be rejected and the baseline would slip a minute.
  ensureSubscriptions();

  if (!isSamplingWindow()) { vlog('Skipped: market closed (outside window or weekend)'); return; }

  const written = [];
  const rawSnaps = [];

  for (const c of Object.values(UNDERLYINGS)) {
    if (!state.get(c.key)?.open) await captureDayOpen(c.key);

    const point = computeDiffs(c.key);
    if (!point) continue;

    const chain = point._chain;
    delete point._chain;

    const entry = state.get(c.key);
    entry.series.push(point);
    state.set(c.key, entry);
    written.push({ symbol: c.key, ...point });
    if (chain) rawSnaps.push({ symbol: c.key, expiry: point.expiry, sampledAt: new Date(point.time * 1000), chain });
  }

  if (written.length) {
    try {
      await persistSamples(written);
      vlog(`Inserted ${written.length} row(s): ${written.map((w) => w.symbol).join(', ')}`, true);
    } catch (err) {
      vlog(`Skipped: INSERT failed - ${err.message}`, true);
    }
    // Optional raw-chain archive (no-op unless VEGA_STORE_RAW_CHAINS=true).
    const today = istParts().date;
    for (const s of rawSnaps) {
      await chainSnapshotStore.persist({ date: today, symbol: s.symbol, sampledAt: s.sampledAt, expiry: s.expiry, chain: s.chain });
    }
  } else {
    vlog('Skipped: no symbol produced a point this minute');
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
       (snapshot_date, symbol, sampled_at, expiry,
        call_vega_diff, put_vega_diff, vega_diff,
        current_call_vega, current_put_vega,
        open_call_vega, open_put_vega,
        price, call_strike_count, put_strike_count)
     VALUES ?
     ON DUPLICATE KEY UPDATE
       call_vega_diff=VALUES(call_vega_diff), put_vega_diff=VALUES(put_vega_diff),
       vega_diff=VALUES(vega_diff), current_call_vega=VALUES(current_call_vega),
       current_put_vega=VALUES(current_put_vega), open_call_vega=VALUES(open_call_vega),
       open_put_vega=VALUES(open_put_vega), price=VALUES(price),
       call_strike_count=VALUES(call_strike_count), put_strike_count=VALUES(put_strike_count)`,
    [points.map((p) => [
      today, p.symbol, fmtSql(new Date(p.time * 1000)), p.expiry,
      p.callVegaDiff, p.putVegaDiff, p.vegaDiff,
      p.currentCallVega, p.currentPutVega,
      p.openCallVega, p.openPutVega,
      p.price, p.callStrikeCount, p.putStrikeCount,
    ])]
  );
}

async function loadToday() {
  try {
    const today = istParts().date;

    const [opens] = await db.query(`SELECT * FROM vega_day_open WHERE snapshot_date = :today`, { today });
    const [rows] = await db.query(
      `SELECT * FROM vega_timeseries WHERE snapshot_date = :today ORDER BY sampled_at ASC`, { today });

    state.clear();

    for (const o of opens) {
      state.set(o.symbol, {
        open: {
          date: today, symbol: o.symbol, expiry: o.expiry, capturedAt: o.captured_at,
          chain: parseJson(o.open_chain),
          frozenCallStrikes: parseJson(o.call_strikes),
          frozenPutStrikes: parseJson(o.put_strikes),
        },
        series: [],
      });
    }

    for (const r of rows) {
      const entry = state.get(r.symbol) || { open: null, series: [] };
      entry.series.push(rowToPoint(r));
      state.set(r.symbol, entry);
    }

    const total = [...state.values()].reduce((a, e) => a + e.series.length, 0);
    console.log(`[VegaSeries] Restored ${opens.length} baselines, ${total} samples for today`);
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
    callStrikeCount: r.call_strike_count,
    putStrikeCount: r.put_strike_count,
    expiry: r.expiry,
  };
}

/** Day-open reference for the latest point (dynamic => it moves each minute). */
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

/** The stored per-minute rows for one calendar day, bucketed + trend-decorated. */
async function readStoredPoints(symbol, date, timeframe = '1m') {
  const [rows] = await db.query(
    `SELECT sampled_at, call_vega_diff, put_vega_diff, vega_diff,
            current_call_vega, current_put_vega, open_call_vega, open_put_vega,
            price, call_strike_count, put_strike_count, expiry
       FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date
      ORDER BY sampled_at ASC`,
    { symbol, date }
  );
  return bucketByTimeframe(rows.map(rowToPoint), timeframe).map(decorate);
}

/**
 * Baseline metadata for a past day.
 *
 * The per-minute rows carry the (moving) day-open totals, but only
 * vega_day_open knows WHEN the baseline was frozen and against which expiry.
 * The chain column is deliberately not selected — it is a large JSON blob and
 * nothing on the read path needs it.
 */
async function loadDayOpenMeta(symbol, date) {
  try {
    const [rows] = await db.query(
      `SELECT expiry, captured_at
         FROM vega_day_open
        WHERE symbol = :symbol AND snapshot_date = :date
        LIMIT 1`,
      { symbol, date }
    );
    if (!rows.length) return null;
    return { expiry: rows[0].expiry || null, capturedAt: rows[0].captured_at || null };
  } catch (err) {
    console.warn(`[VegaSeries] Day-open lookup failed for ${symbol} ${date}:`, err.message);
    return null;
  }
}

/**
 * Read one trading day — the single entry point behind the date picker.
 *
 * Today comes from the in-memory series (it is still being appended to), any
 * other day from MySQL. The one subtlety: today ALSO falls back to MySQL when
 * memory is empty. That happens after a restart before loadToday() finishes,
 * and it is the difference between the user seeing the morning's curve and
 * seeing a blank chart on a day that has rows on disk.
 */
async function loadByDate(symbol, date, timeframe = '1m') {
  const key = String(symbol || '').toUpperCase();
  const live = date === istParts().date;

  let points = live ? getSeries(key, timeframe) : [];
  let fromStore = false;

  if (!points.length) {
    points = await readStoredPoints(key, date, timeframe);
    fromStore = points.length > 0;
  }

  const meta = await loadDayOpenMeta(key, date);
  const summary = dayOpenSummaryFromPoints(points);

  const dayOpen = summary || meta
    ? { callVega: null, putVega: null, callStrikes: null, putStrikes: null, ...(summary || {}), ...(meta || {}) }
    : null;

  return {
    points,
    dayOpen,
    live,
    // A baseline exists if it is frozen in memory for today, persisted for the
    // day, or implied by rows that were computed against one.
    hasBaseline: !!(meta || summary || (live && state.get(key)?.open)),
    fromStore,
  };
}

/**
 * Read a DELAYED window of the series, for the public marketing site.
 *
 * This is the only vega read that is served without authentication, so it is
 * deliberately a separate function rather than a flag on loadByDate() — there
 * is no argument anyone can pass to the premium path that turns it into this
 * one, and no way to accidentally drop the delay by forgetting a parameter.
 *
 * TIMEZONE NOTE, because getting this wrong silently serves live data:
 * `sampled_at` is written in UTC (persistSamples -> fmtSql -> toISOString),
 * while `snapshot_date` is the IST trading day. The cutoff below is therefore
 * built in UTC to match the column it is compared against. Comparing against
 * an IST cutoff would shift the window by 5h30m and expose the live tail.
 *
 * FALLBACK: before ~09:45 IST on a trading day — and all weekend — today has
 * no points old enough to publish. Rather than serve an empty chart, fall back
 * to the most recent COMPLETED session and say so via `isFallbackDay`, which
 * the caller must surface so the visitor is never misled about what they are
 * looking at. A past day is finished, so no cutoff applies to it.
 */
const PUBLIC_DELAY_MINUTES = 30;

async function loadDelayed(symbol, { delayMinutes = PUBLIC_DELAY_MINUTES, timeframe = '1m' } = {}) {
  const key = String(symbol || '').toUpperCase();
  const minutes = Math.max(0, Number(delayMinutes) || 0);
  const today = istParts().date;
  const cutoff = fmtSql(new Date(Date.now() - minutes * 60_000));

  const [rows] = await db.query(
    `SELECT sampled_at, call_vega_diff, put_vega_diff, vega_diff,
            current_call_vega, current_put_vega, open_call_vega, open_put_vega,
            price, call_strike_count, put_strike_count, expiry
       FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date = :date AND sampled_at <= :cutoff
      ORDER BY sampled_at ASC`,
    { symbol: key, date: today, cutoff }
  );

  if (rows.length) {
    const points = bucketByTimeframe(rows.map(rowToPoint), timeframe).map(decorate);
    return {
      date: today,
      points,
      delayMinutes: minutes,
      isFallbackDay: false,
      asOf: points.length ? points[points.length - 1].time : null,
    };
  }

  const [[latest]] = await db.query(
    `SELECT MAX(snapshot_date) AS d FROM vega_timeseries
      WHERE symbol = :symbol AND snapshot_date < :today`,
    { symbol: key, today }
  );

  const fallbackDate = latest?.d ? toIsoDate(latest.d) : null;
  if (!fallbackDate) {
    return { date: today, points: [], delayMinutes: minutes, isFallbackDay: false, asOf: null };
  }

  const points = await readStoredPoints(key, fallbackDate, timeframe);
  return {
    date: fallbackDate,
    points,
    delayMinutes: minutes,
    isFallbackDay: true,
    asOf: points.length ? points[points.length - 1].time : null,
  };
}

/**
 * Days that actually have stored samples, newest first — this drives the date
 * picker, so it also reports the session's first/last sample so the UI can
 * label each day with its real recording window rather than assuming 09:15.
 */
async function listAvailableDates(symbol, limit = 120) {
  const key = String(symbol || '').toUpperCase();
  const [rows] = await db.query(
    `SELECT snapshot_date,
            COUNT(*)          AS points,
            MIN(sampled_at)   AS first_at,
            MAX(sampled_at)   AS last_at
       FROM vega_timeseries WHERE symbol = :symbol
      GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT :limit`,
    { symbol: key, limit: Math.max(1, Math.min(Number(limit) || 120, 400)) }
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

const TIMEFRAME_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15 };

function bucketByTimeframe(points, timeframe = '1m') {
  const minutes = TIMEFRAME_MINUTES[timeframe] || 1;
  if (minutes === 1 || points.length < 2) return points;
  const bucketSeconds = minutes * 60;
  const out = [];
  let bucket = null, last = null;
  for (const p of points) {
    const b = Math.floor(p.time / bucketSeconds) * bucketSeconds;
    if (bucket !== null && b !== bucket) out.push({ ...last, time: bucket });
    bucket = b; last = p;
  }
  if (last) out.push({ ...last, time: bucket });
  return out;
}

function getSeries(symbol, timeframe = '1m') {
  const key = String(symbol || '').toUpperCase();
  const entry = state.get(key);
  return bucketByTimeframe(entry?.series || [], timeframe).map(decorate);
}

/** Normalized day-open summary for TODAY's live series (used by routes). */
function getDayOpen(symbol) {
  return dayOpenSummaryFromPoints(getSeries(symbol, '1m'));
}

/** Latest decorated point (unified engine — used by the market route too). */
function getLatest(symbol) {
  const s = getSeries(symbol, '1m');
  return s.length ? s[s.length - 1] : null;
}

function getStats() {
  return {
    sampling: sampleTask !== null,
    window: isSamplingWindow(),
    instrumentsReady: instrumentService.isReady(),
    // What the recorder actually has subscribed. If this is 0 during market
    // hours, no rows will be written — that is the first thing to check.
    subscription: subscriptionManager.getStats(),
    filterMode: 'abs',
    strikeMode: cfg.STRIKE_MODE,
    deltaMax: cfg.DELTA_MAX,
    strikeWindow: cfg.STRIKE_WINDOW,
    marketWindow: { openMin: cfg.MARKET_OPEN_MIN, closeMin: cfg.MARKET_CLOSE_MIN },
    storeRawChains: cfg.STORE_RAW_CHAINS,
    underlyings: [...state.entries()].map(([symbol, e]) => ({
      symbol, hasBaseline: !!e.open, points: e.series.length, start: startFor(symbol),
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
  loadDelayed, PUBLIC_DELAY_MINUTES,
  TIMEFRAME_MINUTES, startFor, todayIst,
};
