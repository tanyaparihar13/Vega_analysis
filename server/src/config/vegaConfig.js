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
  MARKET_OPEN_MIN: 555,     // 09:15 IST, in minutes-from-midnight
  MARKET_CLOSE_MIN: 930,    // 15:30 IST
  SAMPLE_CRON: '*/1 9-15 * * 1-5', // every minute, market hours, Mon-Fri
  TIMEZONE: 'Asia/Kolkata',
  STORE_RAW_CHAINS: false,  // set true via env to also archive raw per-minute chains
  TREND,
};
