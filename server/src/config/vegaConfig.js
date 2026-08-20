'use strict';

/**
 * vegaConfig — single place for every threshold/timing/mode the Vega Analysis
 * module reads. Nothing here changes the arithmetic in vegaMath.js; it only
 * feeds parameters into it, mirroring what used to be per-row columns in the
 * PHP `options` table (start, oid, etc.).
 *
 * NOTE: if your project already has a vegaConfig.js, merge these keys into it
 * instead of overwriting — this file is provided so the module is runnable
 * standalone, since it wasn't part of the files you sent over.
 */

const nifty50 = require('../constants/nifty50');
const instruments = require('../constants/instruments');

const DELTA_START = {
  // Per-underlying delta floor. PHP's addvega.php only ever had one `start`
  // value for every instrument (0.05); this deliberately diverges from that
  // parity default — NIFTY keeps the tighter 0.05 floor, while the other four
  // underlyings use a 0.20 floor to exclude far-OTM noise from their sums.
  //
  // These five are LEFT EXACTLY AS THEY WERE. The parity work asked for a
  // 0.20-0.60 band on STOCKS specifically (see STOCK_START below); the index
  // floors are existing, working behaviour and were not in scope.
  NIFTY: 0.05,
  BANKNIFTY: 0.20,
  FINNIFTY: 0.20,
  MIDCPNIFTY: 0.20,
  SENSEX: 0.05,
};

/** Read a float from the environment, falling back when unset/unparseable. */
function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Comma-separated uppercase symbol list from the environment.
 * 'ALL' is dropped here — it is a mode flag read by RECORD_ALL_STOCKS, not a
 * symbol — so an env value of exactly "ALL" yields an empty list and the caller
 * falls back to its default.
 */
function envSymbolList(name) {
  return [...new Set(
    String(process.env[name] || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && s !== 'ALL')
  )];
}

/**
 * PER-STOCK delta floor overrides, e.g. "RELIANCE:0.25,TATASTEEL:0.30".
 *
 * A single floor for every F&O stock is the wrong shape for stocks, and only
 * happened to be adequate because STOCK_START was tuned for a liquid mid-cap.
 * A stock's usable band is a property of ITS OWN board — strike step relative
 * to a typical weekly move, how many strikes actually trade, and how far out
 * IV stays solvable. TATASTEEL at ~160 with a 5-point grid and RELIANCE at
 * ~1400 with a 20-point grid do not have comparable delta coverage, so pinning
 * both to 0.20 either drags in unsolvable far-OTM strikes on one or starves
 * the sum on the other.
 *
 * Unset keys fall through to STOCK_START, so the default behaviour is exactly
 * what it was — this only adds a place to say otherwise, per symbol, without
 * touching code.
 */
function envSymbolNumberMap(name) {
  const out = {};
  for (const pair of String(process.env[name] || '').split(',')) {
    const [sym, val] = pair.split(':').map((s) => (s || '').trim());
    const n = Number(val);
    if (sym && Number.isFinite(n)) out[sym.toUpperCase()] = n;
  }
  return out;
}

/**
 * Trend pill colours. These are sent to the client and rendered as-is, so they
 * must be legible on the app's LIGHT surfaces.
 *
 * The previous values came from the PHP original and assumed a dark page:
 * 'yellow' (#ffff00) and '#aaf235' are essentially invisible on white, and the
 * bare CSS keywords 'Green'/'Red' are far darker than the app's own
 * green/red tokens, so the pills clashed with every other price colour.
 * Same six states, same semantics — just accessible values that match the
 * vega-green / vega-red palette in tailwind.config.js.
 */
const TREND = {
  BULLISH: { key: 'bullish', label: 'Bullish', color: '#15a05e' },
  BEARISH: { key: 'bearish', label: 'Bearish', color: '#e03131' },
  SIDEWAYS_BULLISH: { key: 'sideways_bullish', label: 'Sideways Bullish', color: '#4d7c0f' },
  SIDEWAYS_BEARISH: { key: 'sideways_bearish', label: 'Sideways Bearish', color: '#c2410c' },
  SIDEWAYS: { key: 'sideways', label: 'Sideways', color: '#b45309' },
  NEUTRAL: { key: 'neutral', label: 'Neutral', color: '#64748b' },
};

/**
 * THE delta floor for one underlying — the single definition (B-06).
 *
 * vegaTimeseriesService.startFor() delegates here, optionChainService emits it
 * on every chain payload, and the option-chain table filters on what it is
 * given. Previously the client carried its own hardcoded copy which had drifted
 * (stock floor 0.05 vs the server's 0.20, ceiling pinned at 0.60 while the
 * server's is env-tunable), so the table and the Vega sums were built from
 * different baskets for the same instrument.
 *
 * Curated indices keep their per-name floors; everything else is an F&O stock
 * and gets STOCK_START.
 */
function deltaStartFor(symbol) {
  const key = String(symbol || '').toUpperCase();
  // 1. Curated index floors (NIFTY/SENSEX 0.05; BANKNIFTY/FINNIFTY/MIDCPNIFTY 0.20).
  if (DELTA_START[key] != null) return DELTA_START[key];
  // 2. Per-stock override, if one was configured for THIS symbol.
  const perStock = module.exports.STOCK_DELTA_START_OVERRIDES[key];
  if (perStock != null) return perStock;
  // 3. Otherwise: any other curated index defaults to the index floor, and
  //    everything else is an F&O stock and gets the stock floor.
  return instruments.getUnderlying(key) ? module.exports.DEFAULT_START : module.exports.STOCK_START;
}

module.exports = {
  DELTA_START,
  DEFAULT_START: 0.05,
  deltaStartFor,

  /**
   * Delta floor for F&O STOCKS (parity item 5).
   *
   * Stocks were previously falling through to DEFAULT_START (0.05), which pulls
   * a long tail of far-OTM strikes with near-zero, badly-solved vega into both
   * sums — on a thin stock board that tail is most of the noise in the curve.
   * StockMojo / Alpha Edge run stocks on a 0.20-0.60 band, so that is what
   * startFor() now returns for anything that is not one of the curated indices.
   *
   * It is applied to the Call sum, the Put sum and therefore the Difference,
   * because all three come out of the same computePoint() call — there is no
   * path where one side uses a different band from the other.
   */
  STOCK_START: envNum('VEGA_STOCK_DELTA_START', 0.20),

  /**
   * Per-symbol floors that win over STOCK_START. See envSymbolNumberMap().
   * Format: VEGA_STOCK_DELTA_START_OVERRIDES="RELIANCE:0.25,TATASTEEL:0.30"
   * Empty by default, so nothing changes until a symbol is named.
   */
  STOCK_DELTA_START_OVERRIDES: envSymbolNumberMap('VEGA_STOCK_DELTA_START_OVERRIDES'),

  DELTA_MAX: envNum('VEGA_DELTA_MAX', 0.6),  // PHP: hard-coded 0.6 ceiling in addvega.php

  /**
   * DISPLAY SIGN — the whole of the sign-parity fix (parity item 1).
   *
   * The stored arithmetic is unchanged and stays PHP-faithful:
   *   call_vega_diff = currentCallVega - openCallVega        (addvega.php diff1)
   *   put_vega_diff  = currentPutVega  - openPutVega         (diff2)
   *   vega_diff      = put_vega_diff   - call_vega_diff      (diff3)
   *
   * StockMojo / Alpha Edge plot the NEGATION of those three. Rather than
   * rewriting the engine (which would invalidate every row already recorded and
   * make old and new history disagree), the flip is applied ONCE, in
   * vegaTimeseriesService.decorate() — the single function every read path goes
   * through: the REST series, the WebSocket push, the public delayed teaser, the
   * market snapshot route and the Excel export. The database is never touched.
   *
   * Because diff3 is linear in diff1/diff2, negating all three is
   * self-consistent: -(put - call) = (-put) - (-call). The Difference series
   * still equals PutVega - CallVega in displayed terms.
   *
   * TREND IS DELIBERATELY *NOT* RECOMPUTED FROM THE FLIPPED NUMBERS. The
   * datav1.php rules are stated over the stored (economic) diffs, where "calls
   * gaining vega while puts lose it" is a rally and therefore Bullish. Feeding
   * them the display-signed values would relabel every rally as Bearish, which
   * is the opposite of parity. See utils/vegaTrend.js.
   *
   * Set VEGA_DISPLAY_SIGN=1 to serve the raw PHP-signed values again.
   */
  DISPLAY_SIGN: envNum('VEGA_DISPLAY_SIGN', -1) >= 0 ? 1 : -1,

  /**
   * Strike-selection methodology (parity item 6).
   *
   *   'stable'  DEFAULT. The basket is the set eligible AT DAY-OPEN, held for
   *             the session, with a hysteresis exit so a contract that has
   *             genuinely walked out of the band stops contributing. This is
   *             what removes the per-tick sawtooth: the sums are measured on the
   *             same contracts minute after minute, so a move in the underlying
   *             changes the VALUES rather than changing which values are added.
   *   'frozen'  day-open basket, no exit rule at all (maximum stability).
   *   'dynamic' addvega.php literal — recompute the band from the current chain
   *             every sample. This was the previous default; set
   *             VEGA_STRIKE_MODE=dynamic to restore it exactly.
   */
  STRIKE_MODE: ['stable', 'frozen', 'dynamic'].includes(process.env.VEGA_STRIKE_MODE)
    ? process.env.VEGA_STRIKE_MODE
    : 'stable',

  /**
   * Hysteresis margin for 'stable' mode, in delta.
   *
   * A strike already in the basket is retained while |delta| stays inside
   * [start - h, deltaMax + h]. Without the margin a contract sitting exactly on
   * 0.60 would flicker in and out on every tick, which is the ATM-switching
   * oscillation this mode exists to remove; with it, a strike has to move a
   * clear 0.15 of delta beyond the band before it is dropped, and once dropped
   * it does not come back for the session.
   */
  STRIKE_HYSTERESIS: envNum('VEGA_STRIKE_HYSTERESIS', 0.15),

  STRIKE_WINDOW: 30,        // how many strikes either side of ATM to build

  /**
   * Strikes either side of ATM to subscribe for a STOCK.
   *
   * A stock board is far shallower than an index board and its liquid strikes
   * sit much closer to spot, so the index's 30-a-side window mostly buys
   * untraded contracts — while costing the same 122 tokens against Kite's
   * ~3,000-per-connection cap. A tighter window is what makes recording many
   * stocks at once arithmetically possible at all (see RECORD_ALL_STOCKS).
   */
  STOCK_STRIKE_WINDOW: Math.max(3, Math.min(Number(process.env.VEGA_STOCK_STRIKE_WINDOW) || 8, 30)),

  /**
   * How many expiries per underlying the recorder tracks, nearest first
   * (current expiry, next weekly, the one after that...).
   *
   * TOKEN BUDGET — the reason this is a small number and not "all of them".
   * Kite allows ~3,000 instrument tokens per WebSocket connection. One tracked
   * expiry costs (2 * STRIKE_WINDOW + 1) * 2 tokens = 122 at the default
   * window, per underlying. Five underlyings x 3 expiries = ~1,830 standing
   * tokens, leaving room for the option-chain subscriptions live browsers add
   * on top. Raising this past 4 will trip the warning in subscriptionManager
   * and eventually the exchange limit itself, so raise STRIKE_WINDOW down
   * first if you need more expiries.
   */
  EXPIRY_COUNT: Math.max(1, Math.min(Number(process.env.VEGA_EXPIRY_COUNT) || 3, 6)),

  /**
   * Expiries tracked per STOCK. Stock options are monthly, so "the next three
   * expiries" is three MONTHS out — nobody charts that, and each one costs a
   * full token slice. One (the front month) is what a stock desk actually reads,
   * and it triples how many stocks fit inside the token budget.
   */
  STOCK_EXPIRY_COUNT: Math.max(1, Math.min(Number(process.env.VEGA_STOCK_EXPIRY_COUNT) || 1, 4)),

  /**
   * Hard ceiling on the standing subscription, in Kite instrument tokens.
   *
   * Kite allows ~3,000 tokens per WebSocket connection and silently misbehaves
   * past it. The recorder's set is built newest-priority-first (indices, then
   * on-demand targets, then recorded stocks) and TRUNCATED here, so an
   * over-ambitious VEGA_RECORDED_STOCKS degrades to "records fewer stocks"
   * instead of "the whole feed stops working".
   */
  TOKEN_BUDGET: Math.max(200, Math.min(Number(process.env.VEGA_TOKEN_BUDGET) || 2800, 3000)),

  MARKET_OPEN_MIN: 555,     // 09:15 IST, in minutes-from-midnight

  /**
   * Earliest minute at which the day-open BASELINE may be captured (09:16 IST).
   * Recording still starts at MARKET_OPEN_MIN; only the baseline waits, so it is
   * never built from pre-trade prices. Mirrors AlphaEdge's `$t2` 9:16 guard.
   */
  BASELINE_MIN_IST: envNum('VEGA_BASELINE_MIN_IST', 556),

  /**
   * Latest minute at which a capture still counts as THE DAY'S OPEN (09:25 IST).
   *
   * BASELINE_MIN_IST was a floor with no ceiling, and the asymmetry was a real
   * bug rather than an oversight. Every plotted value is `current - open`, so
   * the baseline is the origin of the whole chart. A process that starts at
   * 09:30 — a deploy, a crash restart, an instrument first tracked mid-session
   * — found no baseline, captured one from the board in front of it, and
   * presented that as the session's open. The result is a chart whose shape is
   * correct and whose LEVEL is silently wrong by however far the market moved
   * before the capture, with nothing anywhere saying so.
   *
   * Measured on 2026-08-20: a 09:30 restart put the Call series a near-constant
   * +5.42 (sd 0.28) away from the same series anchored at 09:15, and the Put
   * series -0.41 (sd 0.27). A constant additive offset is the signature of a
   * wrong ORIGIN; a wrong calculation would scale with the value instead.
   *
   * Past this minute the capture is still taken — refusing would leave the day
   * with no chart at all, and a correct shape is worth more than nothing — but
   * it is MARKED late, reconstructed from the raw-chain archive when one
   * exists, and surfaced through the API so the UI can say what the numbers are
   * measured from. Lateness is DERIVED from the stored `captured_at`, so no
   * schema change and no historical row is touched.
   */
  BASELINE_MAX_IST: envNum('VEGA_BASELINE_MAX_IST', 565),

  /**
   * INTRADAY VERIFICATION BASELINE — a temporary, date-scoped re-origin.
   *
   *     VEGA_INTRADAY_BASELINE=2026-08-20:14:00
   *
   * PURPOSE. When a session's day-open baseline is known to be wrong (the
   * recorder was down at 09:16, so the day got anchored wherever it restarted),
   * the curve's SHAPE is still correct and only its origin is displaced. This
   * lets that session be re-read from a clean intraday origin so the data can be
   * checked against a reference chart, without waiting for the next morning.
   *
   * IT IS NOT A SECOND BASELINE. Nothing is captured, nothing is written, and
   * `vega_day_open` is never touched. Re-anchoring a difference series is
   * arithmetic on rows that already exist:
   *
   *     newDiff(t) = oldDiff(t) − oldDiff(anchor)
   *
   * The old origin appears in both terms and cancels, which is exactly why this
   * needs no chain capture and cannot be affected by whatever the old baseline
   * was. It is applied on the READ path only, so the stored rows keep their
   * original meaning and removing this variable restores the normal view
   * instantly.
   *
   * IT EXPIRES BY CONSTRUCTION. The date is part of the value and is compared
   * against the trading date being read, so it can only ever affect the ONE
   * session it names. There is no form of this setting that silently becomes
   * tomorrow's baseline: tomorrow's date does not match, and the normal
   * market-open path runs untouched. Leaving the variable set is therefore
   * harmless — though it should still be removed once the check is done.
   *
   * @type {{date: string, minutes: number, label: string}|null}
   */
  INTRADAY_BASELINE: (() => {
    const raw = String(process.env.VEGA_INTRADAY_BASELINE || '').trim();
    if (!raw) return null;
    const m = /^(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(raw);
    if (!m) {
      console.warn(`[VegaConfig] Ignoring VEGA_INTRADAY_BASELINE='${raw}' — `
        + `expected YYYY-MM-DD:HH:MM (e.g. 2026-08-20:14:00)`);
      return null;
    }
    const [, date, hh, mm] = m;
    const minutes = Number(hh) * 60 + Number(mm);
    if (!(minutes >= 0 && minutes < 1440)) {
      console.warn(`[VegaConfig] Ignoring VEGA_INTRADAY_BASELINE='${raw}' — not a real time of day`);
      return null;
    }
    console.warn(`[VegaConfig] INTRADAY BASELINE ACTIVE for ${date} at ${hh}:${mm} IST. `
      + `That ONE session is served re-anchored to ${hh}:${mm}; every other date, `
      + `including tomorrow, uses the normal market-open baseline. Stored rows are unchanged.`);
    return { date, minutes, label: `${hh}:${mm}` };
  })(),

  /**
   * Minimum fraction of the board that must be priced ON EACH SIDE before the
   * day-open baseline is accepted.
   *
   * WHY 0.5 AND NOT HIGHER. 0.75 was the intuitive candidate after the
   * 2026-08-19 baseline bug, so it was measured against every archived
   * day-open chain (164 boards over four sessions) before being adopted:
   *
   *     threshold   13 Aug   14 Aug   17 Aug   19 Aug   (targets rejected /41)
   *       0.50        1        2        0        1
   *       0.60        1        3        3        5
   *       0.75        3       13        7       20
   *       0.80       10       18       13       23
   *
   * At 0.75 nearly half of one session's universe is refused. The refusals are
   * not stale data — they are genuinely illiquid single-stock boards whose puts
   * simply do not all trade (AXISBANK 0.471, POWERGRID 0.471, TATASTEEL 0.471).
   * Those never reach 0.75, and a target that never qualifies gets NO baseline,
   * hence no series for the whole day: a much worse failure than the offset the
   * threshold was meant to catch.
   *
   * So the timing gate (BASELINE_MIN_IST) is the fix for stale opening prices,
   * and this stays at 0.5 as a floor against the catastrophic case the previous
   * OR-based rule could not see at all: one side entirely unpriced while the
   * other is complete. Per-side evaluation is what makes that reachable.
   */
  BASELINE_MIN_SIDE_FRACTION: envNum('VEGA_BASELINE_MIN_SIDE_FRACTION', 0.5),
  MARKET_CLOSE_MIN: 930,    // 15:30 IST

  /**
   * The sampler ticks every 5 SECONDS (six-field cron: sec min hour dom mon dow).
   *
   * This is the base clock for everything. It is NOT the rate at which rows are
   * written or pushed — see PERSIST_RESOLUTION and TIMEFRAMES below. A tick that
   * has nothing to persist and nobody watching does no work at all, so the cost
   * of the faster clock is paid only where a faster series is actually wanted.
   */
  SAMPLE_CRON: '*/5 * 9-15 * * 1-5',

  /**
   * The base clock, as a TIMEFRAMES key. Must match SAMPLE_CRON's step.
   *
   * Every sample's timestamp is SNAPPED to a multiple of this before it is used
   * for the persist decision or written to the database. That is not cosmetic:
   * node-cron fires anywhere inside its target second (measured up to 962ms in,
   * i.e. 38ms from rolling over), and any event-loop delay on top of that pushes
   * the observed second past the boundary. Testing `epoch % 5 === 0` against an
   * unsnapped clock therefore drops samples at random under load — and for a
   * stock persisting at 1m, one dropped tick is a whole minute lost.
   */
  BASE_RESOLUTION: '5s',

  TIMEZONE: 'Asia/Kolkata',
  // Wired to the env var the docs (and chainSnapshotStore's header) already
  // promised. It was a hardcoded false, so VEGA_STORE_RAW_CHAINS=true silently
  // did nothing and the archive stayed empty.
  STORE_RAW_CHAINS: String(process.env.VEGA_STORE_RAW_CHAINS || '').trim().toLowerCase() === 'true',

  // -------------------------------------------------------------------------
  // Timeframes and stored resolution
  // -------------------------------------------------------------------------

  /**
   * Every timeframe the API will serve, in seconds.
   *
   * A stored resolution can serve a timeframe only when the timeframe is a whole
   * multiple of it — 5s rows aggregate up to any of these, 1m rows aggregate to
   * the minute tiers only. That rule lives in vegaTimeseriesService and is why
   * the seconds tiers are absent from a stock's historical picker.
   */
  TIMEFRAMES: {
    '5s': 5, '10s': 10, '15s': 15, '30s': 30,
    '1m': 60, '3m': 180, '5m': 300, '10m': 600, '15m': 900,
    // 30m and 1h are servable from 5s rows (1800 % 5 === 0, 3600 % 5 === 0) and
    // from 1m rows, so canServe() admits them for every stored resolution the
    // recorder produces. Added because a desk reads the session shape on 30m.
    '30m': 1800, '1h': 3600,
  },

  /**
   * What actually gets written to MySQL, per instrument class.
   *
   * Indices are a fixed set of five, so 5s rows are a bounded, predictable
   * volume (~4,500 rows per expiry per day) and buy full seconds-resolution
   * playback. Stocks are ~200 names and the same choice there would be ~12x the
   * volume across two orders of magnitude more instruments, so they persist at
   * 1m. Both are still SAMPLED at 5s while someone is watching them live; the
   * difference is only what survives the session.
   */
  /**
   * Stocks now persist at 5s as well (parity items 7 and 9).
   *
   * The seconds tiers are only servable from history when 5s rows exist — a 1m
   * row cannot be split into four 15s bars — so a stock recorded at 1m had its
   * whole Seconds group greyed out the moment the user stepped off "today".
   * With 30-day retention (RETENTION_DAYS) the extra volume is bounded: ~4,500
   * rows per stock-expiry per session, i.e. roughly 100k rows/month for one
   * stock, which MySQL does not notice at this table's width.
   *
   * Set VEGA_STOCK_RESOLUTION=1m to go back to the coarser, cheaper storage.
   */
  PERSIST_RESOLUTION: {
    index: process.env.VEGA_INDEX_RESOLUTION || '5s',
    stock: process.env.VEGA_STOCK_RESOLUTION || '5s',
  },

  /**
   * How many days of vega history to keep (parity item 8).
   *
   * The nightly cron in index.js deletes anything older across vega_timeseries,
   * vega_day_open and vega_chain_snapshots. One month is the stated retention;
   * it is also what makes 5s storage for stocks affordable.
   */
  RETENTION_DAYS: Math.max(1, Math.min(Number(process.env.VEGA_RETENTION_DAYS) || 30, 365)),

  /**
   * Stocks the headless recorder samples continuously, so they accumulate
   * history without anyone watching. Comma-separated tradingsymbols, e.g.
   * VEGA_RECORDED_STOCKS=RELIANCE,HDFCBANK,APLAPOLLO
   *
   * The literal value ALL enrols every F&O stock the instrument master turned
   * up, in alphabetical order, up to TOKEN_BUDGET — see RECORD_ALL_STOCKS.
   *
   * Any other F&O stock still works fully in live mode the moment a user selects
   * it, AND is persisted while being watched, so it accumulates history from its
   * first viewing onwards. Each recorded name costs
   * (2*STOCK_STRIKE_WINDOW+1)*2*STOCK_EXPIRY_COUNT standing tokens against
   * Kite's ~3,000 cap, the same budget the indices draw on.
   */
  /**
   * DEFAULTS TO THE WHOLE SUPPORTED UNIVERSE (constants/nifty50.js).
   *
   * The universe was chosen precisely so that every name in it fits inside the
   * token budget alongside the indices, so there is no reason to record a subset
   * of it — a supported stock that is not recorded has no history, which the
   * selector then has to disclose as "live only", for no benefit.
   *
   * VEGA_RECORDED_STOCKS still overrides this to record fewer (or different)
   * names. It cannot record a name outside the universe: recordedSymbols()
   * resolves every entry through instrumentService, which does not know
   * off-universe stocks at all.
   */
  RECORDED_STOCKS: envSymbolList('VEGA_RECORDED_STOCKS').length
    ? envSymbolList('VEGA_RECORDED_STOCKS')
    : nifty50.UNIVERSE_SYMBOLS.slice(),

  /** The supported equity universe, re-exported so callers need one import. */
  STOCK_UNIVERSE: nifty50.UNIVERSE_SYMBOLS.slice(),
  STOCK_UNIVERSE_MODE: nifty50.UNIVERSE_MODE,

  /**
   * Enrol EVERY discovered F&O stock in the headless recorder.
   *
   * READ THE BUDGET NOTE BEFORE TURNING THIS ON. Kite's ~3,000-token cap is a
   * hard exchange-side limit, not a tunable: at the default 8-a-side window and
   * one expiry a stock costs 34 tokens, so ~2,800 tokens minus the indices'
   * standing ~1,830 leaves room for roughly 28 stocks — not the ~200 in the F&O
   * list. With VEGA_EXPIRY_COUNT=1 for the indices too, the budget stretches to
   * roughly 70. Beyond that the set is truncated (alphabetically, deterministic)
   * and the names dropped are logged once.
   *
   * Stocks outside the standing set are NOT invisible: they stream live and are
   * persisted whenever a user has them open, so coverage grows with use.
   */
  RECORD_ALL_STOCKS: /^(1|true|yes|all)$/i.test(String(process.env.VEGA_RECORD_ALL_STOCKS || ''))
    || /(^|,)\s*ALL\s*(,|$)/i.test(String(process.env.VEGA_RECORDED_STOCKS || '')),

  /**
   * Ring-buffer depth for the in-memory live series, per {symbol, expiry}.
   *
   * 4,500 is one full 09:15-15:30 session at 5s. The buffer is what a newly
   * connected client is back-filled from and what the aggregator reads, and it
   * is bounded because an unbounded array per instrument is how a long-running
   * recorder turns into a memory leak.
   */
  LIVE_BUFFER_POINTS: Math.max(600, Number(process.env.VEGA_LIVE_BUFFER_POINTS) || 4500),

  TREND,
};
