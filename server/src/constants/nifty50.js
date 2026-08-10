'use strict';

/**
 * THE STOCK UNIVERSE — the 26 NIFTY 50 names this deployment supports.
 *
 * ===========================================================================
 * WHY 26 AND NOT 50
 * ===========================================================================
 * This is not a product preference. It is the largest set that fits inside ONE
 * Kite Connect WebSocket connection alongside the five indices, computed from
 * the subscription arithmetic in vegaTimeseriesService.ensureSubscriptions():
 *
 *   charged(target) = 2 * min(2w+1, boardSize) + future + spot
 *
 *   5 indices  x 3 expiries x (2*61 + 2)  = 1,860 tokens
 *   26 stocks  x 1 expiry   x (2*17 + 2)  =   936 tokens
 *                                  TOTAL  = 2,796  <=  TOKEN_BUDGET (2,800)
 *
 * A 27th stock costs 36 more and lands on 2,832, past the budget — at which
 * point ensureSubscriptions() DROPS it. A dropped stock does not fail loudly:
 * it receives no ticks, so every Greek solves to null, isUsableOpenChain()
 * refuses to freeze its day-open baseline, and it records ZERO rows for the day
 * while still appearing in the UI as a selectable instrument. Showing a name we
 * cannot reliably feed is worse than not showing it, which is why this list is
 * the single source of truth for what the product offers.
 *
 * Kite's own ceiling is ~3,000 tokens per connection; the 2,800 budget leaves
 * the difference for the option-chain subscriptions live browsers add on top
 * (~83 tokens per distinct {symbol, expiry} being viewed).
 *
 * ===========================================================================
 * SELECTION CRITERIA
 * ===========================================================================
 * The most liquid, most actively traded NIFTY 50 names by options activity —
 * a thin option board produces unsolvable IVs, which produce null Greeks, which
 * produce a flat Vega curve that looks like data but is not.
 *
 * ===========================================================================
 * ⚠ MAINTENANCE
 * ===========================================================================
 * NIFTY 50 is reconstituted semi-annually (March / September). VERIFY this list
 * against the current NSE factsheet before each go-live. buildIndexes() logs any
 * entry that does not resolve to a live option chain, so a stale name is loud
 * rather than silent — but a name that has been ADDED to the index will not
 * appear here on its own.
 *
 * Override without a code change:
 *   VEGA_STOCK_UNIVERSE=RELIANCE,TCS,INFY     restrict to exactly these
 *   VEGA_STOCK_UNIVERSE=ALL                   every F&O stock (exceeds the
 *                                             token budget — expect truncation)
 */

/** NSE tradingsymbols, in the order they are enrolled in the recorder. */
const NIFTY50_CORE = [
  // Banking & financials
  'HDFCBANK',
  'ICICIBANK',
  'SBIN',
  'AXISBANK',
  'KOTAKBANK',
  'BAJFINANCE',
  'BAJAJFINSV',
  // Energy & infrastructure
  'RELIANCE',
  'LT',
  'NTPC',
  'POWERGRID',
  'ULTRACEMCO',
  // IT
  'TCS',
  'INFY',
  'HCLTECH',
  'WIPRO',
  // Consumer
  'ITC',
  'HINDUNILVR',
  'MARUTI',
  'BHARTIARTL',
  // Auto & metals
  /**
   * TMPV, not TATAMOTORS.
   *
   * Tata Motors has demerged, and the old `TATAMOTORS` underlying no longer
   * exists in Kite's master at all — not as an option, not as a cash listing.
   * Verified against the live instrument dump on this deployment:
   *
   *   TMCV   "TATA MOTORS"           commercial vehicles — cash only, NO options
   *   TMPV   "TATA MOTORS PASS VEH"  passenger vehicles  — 131 option contracts
   *
   * TMPV is therefore the only Tata Motors entity that can produce a Vega
   * series. Leaving 'TATAMOTORS' here would have silently cost a slot: it
   * resolves to nothing, so the universe would run 25 stocks against a budget
   * sized for 26.
   */
  'TMPV',
  'M&M',
  'TATASTEEL',
  // Pharma
  'SUNPHARMA',
  // Adani group
  'ADANIENT',
  'ADANIPORTS',
];

/**
 * Parse VEGA_STOCK_UNIVERSE.
 * @returns {{ mode: 'all'|'list', symbols: string[] }}
 */
function readUniverseEnv() {
  const raw = String(process.env.VEGA_STOCK_UNIVERSE || '').trim();
  if (!raw) return { mode: 'list', symbols: NIFTY50_CORE };
  if (/^all$/i.test(raw)) return { mode: 'all', symbols: [] };

  const symbols = raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  return symbols.length ? { mode: 'list', symbols } : { mode: 'list', symbols: NIFTY50_CORE };
}

const UNIVERSE = readUniverseEnv();

/** Uppercased Set for O(1) membership tests on the instrument-indexing hot path. */
const UNIVERSE_SET = new Set(UNIVERSE.symbols.map((s) => s.toUpperCase()));

/**
 * Is this equity underlying inside the supported universe?
 *
 * Always true in 'all' mode. Indices are NOT routed through here — they are the
 * curated five in constants/instruments.js and are never gated.
 */
function isInUniverse(symbol) {
  if (UNIVERSE.mode === 'all') return true;
  if (!symbol) return false;
  return UNIVERSE_SET.has(String(symbol).toUpperCase());
}

/** The configured token cost of one stock, for the boot-time budget report. */
function stockTokenCost(strikeWindow, expiryCount) {
  return ((2 * strikeWindow + 1) * 2 + 2) * expiryCount;
}

module.exports = {
  NIFTY50_CORE,
  UNIVERSE_MODE: UNIVERSE.mode,
  UNIVERSE_SYMBOLS: UNIVERSE.symbols,
  UNIVERSE_SET,
  isInUniverse,
  stockTokenCost,
};
