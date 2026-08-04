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

const DELTA_START = {
  // Per-underlying delta floor. PHP's addvega.php only ever had one `start`
  // value for every instrument (0.05); this deliberately diverges from that
  // parity default — NIFTY keeps the tighter 0.05 floor, while the other four
  // underlyings use a 0.20 floor to exclude far-OTM noise from their sums.
  NIFTY: 0.05,
  BANKNIFTY: 0.20,
  FINNIFTY: 0.20,
  MIDCPNIFTY: 0.20,
  SENSEX: 0.05,
};

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

module.exports = {
  DELTA_START,
  DEFAULT_START: 0.05,
  DELTA_MAX: 0.6,           // PHP: hard-coded 0.6 ceiling in addvega.php
  STRIKE_MODE: 'dynamic',   // 'dynamic' (addvega.php parity) | 'frozen'
  STRIKE_WINDOW: 30,        // how many strikes either side of ATM to build

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
  MARKET_OPEN_MIN: 555,     // 09:15 IST, in minutes-from-midnight
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
  TIMEZONE: 'Asia/Kolkata',
  STORE_RAW_CHAINS: false,  // set true via env to also archive raw per-minute chains

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
  PERSIST_RESOLUTION: {
    index: process.env.VEGA_INDEX_RESOLUTION || '5s',
    stock: process.env.VEGA_STOCK_RESOLUTION || '1m',
  },

  /**
   * Stocks the headless recorder samples continuously, so they accumulate
   * history without anyone watching. Comma-separated tradingsymbols, e.g.
   * VEGA_RECORDED_STOCKS=RELIANCE,HDFCBANK,APLAPOLLO
   *
   * Any other F&O stock still works fully in live mode the moment a user selects
   * it — it simply has no history from before its first viewing. Keep this list
   * short: each name costs (2*STRIKE_WINDOW+1)*2*EXPIRY_COUNT standing tokens
   * against Kite's ~3,000 cap, the same budget the indices draw on.
   */
  RECORDED_STOCKS: String(process.env.VEGA_RECORDED_STOCKS || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

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
