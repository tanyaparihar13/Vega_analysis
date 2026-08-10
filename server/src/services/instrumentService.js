/**
 * Instrument Master.
 *
 * ------------------------------------------------------------------------
 * WHY THIS FILE WAS REWRITTEN
 * ------------------------------------------------------------------------
 * The file that shipped at this path was a byte-for-byte copy of
 * src/constants/instruments.js. It exported UNDERLYINGS / INDEX_TOKENS /
 * getUnderlying and nothing else, while seven modules called it expecting a
 * completely different API:
 *
 *   index.js                  -> refresh(), scheduleDailyRefresh(), getExpiries()
 *   optionChainService.js     -> getStrikeMap(), selectStrikes()
 *   subscriptionManager.js    -> getTokensForExpiry()
 *   optionStreamService.js    -> isReady(), getExpiries()
 *   optionChainController.js  -> isReady(), getExpiries()
 *   marketRoutes.js           -> isReady(), getExpiries()
 *
 * So boot threw `instrumentService.refresh is not a function` before the
 * feed ever started, and every chain endpoint 500'd. This file implements
 * that API for real. Nothing was removed — the constants re-export at the
 * bottom keeps any existing `instrumentService.UNDERLYINGS` reference alive.
 * ------------------------------------------------------------------------
 */

const cron = require('node-cron');
const db = require('../config/db');
const constants = require('../constants/instruments');
const nifty50 = require('../constants/nifty50');

const { UNDERLYINGS, OPTION_EXCHANGES } = constants;

// ---------------------------------------------------------------------------
// In-memory indexes. MySQL is the durable copy; these are what the hot path
// reads, because rebuilding a chain 1x/second must never touch the database.
// ---------------------------------------------------------------------------

let ready = false;
let lastRefreshAt = null;
let lastRefreshError = null;
let refreshInFlight = null;

// instrument_token -> instrument row
const byToken = new Map();

// tradingsymbol -> instrument row (options + futures + equity)
const bySymbol = new Map();

/**
 * 'EXCHANGE:tradingsymbol' -> cash-segment row.
 *
 * bySymbol alone cannot answer "the NSE listing of APLAPOLLO", because ~10,000
 * NSE and ~12,900 BSE equities share a keyspace and the last one indexed wins.
 * The exchange loop ends with BSE, so every dual-listed name resolved to its BSE
 * row — and the spot-token fill below, which requires the NSE row for an NFO
 * underlying, silently failed for almost every F&O stock. They then all dropped
 * out of listTradableUnderlyings(), which filters on `spotToken`.
 *
 * Symptom that hid the cause: getExpiries('APLAPOLLO') worked fine, so the name
 * looked healthy everywhere except the one list that gates the UI.
 */
const cashByExchangeSymbol = new Map();

// underlying key -> { expiries: Set<'YYYY-MM-DD'>, chains: Map<expiry, Map<strike, {CE, PE}>>, futures: Map<expiry, row> }
const byUnderlying = new Map();

// Lowercased search index: [{ q, tradingsymbol, token, name, exchange, type }]
let searchIndex = [];

// Equity/commodity underlyings discovered in the option master that are not in
// constants/instruments.js. Lets a user open RELIANCE / SBIN / TCS and get a
// real chain without hardcoding 200 symbols.
const derivedUnderlyings = new Map();

const IST = { timezone: 'Asia/Kolkata' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Kite returns `expiry` as a JS Date (kiteconnect parses it) for derivative
 * segments and an empty string for cash. Everything downstream — the API, the
 * WebSocket protocol, the client <select> — keys off 'YYYY-MM-DD', so we
 * normalise once, here, in IST.
 *
 * Using toISOString() would be wrong: an expiry parsed as 2026-07-30T00:00:00
 * in a UTC+5:30 process serialises back to 2026-07-29 in UTC. That off-by-one
 * silently drops the front-month expiry from the dropdown.
 */
function toExpiryKey(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, 10);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  // Shift into IST, then read the calendar date.
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** Today's date in IST, as 'YYYY-MM-DD'. Expiries before this are dead. */
function todayIst() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function emptyUnderlyingBucket() {
  return { expiries: new Set(), chains: new Map(), futures: new Map() };
}

function bucketFor(name) {
  if (!byUnderlying.has(name)) byUnderlying.set(name, emptyUnderlyingBucket());
  return byUnderlying.get(name);
}

/**
 * Resolve the underlying key a caller passed. Checks the curated five first,
 * then anything the option master turned up (equity F&O).
 */
function resolveUnderlying(symbol) {
  if (!symbol) return null;
  const key = String(symbol).toUpperCase();
  return constants.getUnderlying(key) || derivedUnderlyings.get(key) || null;
}

// ---------------------------------------------------------------------------
// Refresh — download the master from Kite and index it
// ---------------------------------------------------------------------------

/**
 * Downloads every instrument for the exchanges we care about and rebuilds the
 * in-memory index, then persists to MySQL.
 *
 * Concurrency: Kite's instrument dump is ~8 MB of CSV per exchange and this is
 * called from boot, from a cron, and from the admin panel. Overlapping runs
 * would double the memory and interleave writes, so callers share one promise.
 *
 * @param {import('kiteconnect').KiteConnect} kc  authenticated client
 * @param {object} [opts]
 * @param {boolean} [opts.force] rebuild even if we refreshed today
 */
async function refresh(kc, opts = {}) {
  if (!kc) throw new Error('instrumentService.refresh() requires an authenticated KiteConnect instance');

  if (refreshInFlight) {
    console.log('[Instruments] Refresh already running — joining it.');
    return refreshInFlight;
  }

  if (!opts.force && ready && lastRefreshAt && toExpiryKey(lastRefreshAt) === todayIst()) {
    console.log('[Instruments] Already refreshed today — skipping.');
    return { skipped: true, count: byToken.size };
  }

  refreshInFlight = (async () => {
    const started = Date.now();

    // Options live in NFO/BFO; spot equity and the index levels live in
    // NSE/BSE. We need both — the chain is useless without a spot.
    const spotExchanges = [...new Set(Object.values(UNDERLYINGS).map((u) => u.spotExchange))];
    const exchanges = [...new Set([...OPTION_EXCHANGES, ...spotExchanges])];

    const collected = [];
    for (const exchange of exchanges) {
      try {
        const rows = await kc.getInstruments(exchange);
        console.log(`[Instruments] ${exchange}: ${rows.length} contracts`);
        collected.push(...rows.map((r) => ({ ...r, exchange: r.exchange || exchange })));
      } catch (err) {
        // One bad segment must not lose the other four. BFO in particular
        // 403s on accounts without a BSE F&O subscription.
        console.error(`[Instruments] ${exchange} download failed: ${err.message}`);
      }
    }

    if (!collected.length) {
      lastRefreshError = 'All instrument downloads failed';
      throw new Error(lastRefreshError);
    }

    buildIndexes(collected);

    try {
      await persist(collected);
    } catch (err) {
      // A DB write failure is bad but not fatal — the in-memory index is
      // already live and the chain works. Log loudly, keep serving.
      console.error('[Instruments] MySQL persist failed (memory index is still live):', err.message);
    }

    ready = true;
    lastRefreshAt = new Date();
    lastRefreshError = null;

    console.log(
      `[Instruments] Ready — ${byToken.size} instruments, ` +
      `${byUnderlying.size} underlyings, ${searchIndex.length} searchable, ` +
      `in ${((Date.now() - started) / 1000).toFixed(1)}s`
    );

    return { count: byToken.size, underlyings: byUnderlying.size, durationMs: Date.now() - started };
  })().finally(() => { refreshInFlight = null; });

  return refreshInFlight;
}

function buildIndexes(rows) {
  byToken.clear();
  bySymbol.clear();
  cashByExchangeSymbol.clear();
  byUnderlying.clear();
  derivedUnderlyings.clear();
  const index = [];

  const today = todayIst();

  // Map an option's `name` back to a curated underlying key where one exists.
  const curatedByName = new Map(
    Object.values(UNDERLYINGS).map((u) => [u.instrumentName.toUpperCase(), u])
  );

  for (const raw of rows) {
    const token = Number(raw.instrument_token);
    if (!Number.isFinite(token)) continue;

    const expiry = toExpiryKey(raw.expiry);
    const row = {
      instrumentToken: token,
      exchangeToken: Number(raw.exchange_token) || null,
      tradingsymbol: raw.tradingsymbol,
      name: raw.name || null,
      expiry,
      strike: Number(raw.strike) || 0,
      tickSize: Number(raw.tick_size) || 0.05,
      lotSize: Number(raw.lot_size) || 0,
      instrumentType: raw.instrument_type, // CE | PE | FUT | EQ
      segment: raw.segment,
      exchange: raw.exchange,
    };

    byToken.set(token, row);
    bySymbol.set(row.tradingsymbol, row);
    if (row.instrumentType === 'EQ') {
      cashByExchangeSymbol.set(`${row.exchange}:${row.tradingsymbol}`, row);
    }

    index.push({
      q: `${row.tradingsymbol} ${row.name || ''}`.toLowerCase(),
      tradingsymbol: row.tradingsymbol,
      token,
      name: row.name,
      exchange: row.exchange,
      type: row.instrumentType,
      expiry,
      strike: row.strike,
    });

    const isOption = row.instrumentType === 'CE' || row.instrumentType === 'PE';
    const isFuture = row.instrumentType === 'FUT';
    if ((!isOption && !isFuture) || !row.name || !expiry) continue;

    // Drop contracts that already expired. Kite's dump keeps same-day expiries
    // until the file rolls, which is correct — traders need the chain on
    // expiry day itself — so the comparison is `<`, not `<=`.
    if (expiry < today) continue;

    const underlyingKey = row.name.toUpperCase();

    /**
     * THE UNIVERSE GATE.
     *
     * The instrument TABLE keeps every contract — persist() below writes the
     * whole dump, so the option chain, the watchlist search box and (critically)
     * the cash-segment spot-token matching all keep working on the full master.
     * What is gated here is the set of underlyings the product will TRADE ON:
     * the five curated indices, plus the equity names in constants/nifty50.js.
     *
     * Gating at this one point is what makes the restriction total without a
     * filter in every consumer. Everything downstream resolves a symbol through
     * resolveUnderlying() — the /vega/instruments catalogue, the WebSocket
     * subscribe handler, the series routes, the recorder's target list and the
     * token selection — so an off-universe name simply does not exist to any of
     * them, rather than existing and being filtered out in five places that can
     * drift apart.
     *
     * Skipping BEFORE bucketFor() also keeps byUnderlying from holding the
     * per-expiry strike Maps of ~175 unsupported stocks, which is the bulk of
     * this index's memory.
     */
    if (!curatedByName.has(underlyingKey) && !nifty50.isInUniverse(underlyingKey)) continue;

    const bucket = bucketFor(underlyingKey);

    if (isFuture) {
      bucket.futures.set(expiry, row);
      continue;
    }

    bucket.expiries.add(expiry);

    if (!bucket.chains.has(expiry)) bucket.chains.set(expiry, new Map());
    const strikeMap = bucket.chains.get(expiry);
    if (!strikeMap.has(row.strike)) strikeMap.set(row.strike, { CE: null, PE: null });
    strikeMap.get(row.strike)[row.instrumentType] = row;

    // Register non-curated F&O names (RELIANCE, SBIN, TCS, HDFCBANK…) so the
    // chain builder can serve them too.
    if (!curatedByName.has(underlyingKey) && !derivedUnderlyings.has(underlyingKey)) {
      derivedUnderlyings.set(underlyingKey, buildDerivedConfig(underlyingKey, row));
    }
  }

  // Fill in the spot token for derived (equity) underlyings by matching the
  // cash-segment EQ listing on the same exchange family.
  //
  // Looked up by EXCHANGE:SYMBOL, not symbol alone — see cashByExchangeSymbol.
  // A dual-listed name must resolve to the listing that matches its option
  // segment (NFO -> NSE, BFO -> BSE), and the fallback covers a BFO underlying
  // that only has an NSE cash listing, which is better than no spot at all.
  for (const [key, cfg] of derivedUnderlyings) {
    const preferred = cfg.optionExchange === 'BFO' ? 'BSE' : 'NSE';
    const cash = cashByExchangeSymbol.get(`${preferred}:${key}`)
      || cashByExchangeSymbol.get(`${preferred === 'BSE' ? 'NSE' : 'BSE'}:${key}`);
    if (cash) {
      cfg.spotToken = cash.instrumentToken;
      cfg.spotSymbol = cash.tradingsymbol;
      cfg.spotExchange = cash.exchange;
    }
  }

  // Infer a strike step per derived underlying from its own listed strikes —
  // hardcoding 50 would put the ATM highlight on the wrong row for anything
  // that lists in 20s or 2.5s.
  for (const [key, cfg] of derivedUnderlyings) {
    const bucket = byUnderlying.get(key);
    if (!bucket) continue;
    const nearest = [...bucket.expiries].sort()[0];
    const strikes = nearest ? [...bucket.chains.get(nearest).keys()].sort((a, b) => a - b) : [];
    cfg.strikeStep = inferStrikeStep(strikes) || cfg.strikeStep;
    const sample = nearest ? bucket.chains.get(nearest).get(strikes[0]) : null;
    cfg.lotSize = sample?.CE?.lotSize || sample?.PE?.lotSize || cfg.lotSize;
  }

  searchIndex = index;

  reportUniverse();
}

/**
 * Say out loud which of the configured universe actually resolved to a live,
 * subscribable chain — and which did not.
 *
 * A name in constants/nifty50.js can fail to resolve for three reasons, and all
 * of them are silent without this: it was renamed or delisted, it dropped out of
 * the F&O ban/eligibility list, or its cash listing did not match so it has no
 * spotToken (listTradableUnderlyings() filters on spotToken, so it would vanish
 * from the dropdown while getExpiries() kept working — the exact failure the
 * cashByExchangeSymbol index was built to fix).
 *
 * Also prints the standing token cost, because the universe size is a direct
 * consequence of the budget and an operator changing VEGA_STOCK_UNIVERSE needs
 * to see the arithmetic move.
 */
function reportUniverse() {
  if (nifty50.UNIVERSE_MODE === 'all') {
    console.warn(
      `[Instruments] VEGA_STOCK_UNIVERSE=ALL — ${derivedUnderlyings.size} equity underlyings enrolled. `
      + 'This exceeds the single-connection token budget; expect truncation in ensureSubscriptions().'
    );
    return;
  }

  const resolved = [];
  const missing = [];
  const noSpot = [];

  for (const symbol of nifty50.UNIVERSE_SYMBOLS) {
    const cfg = derivedUnderlyings.get(symbol.toUpperCase());
    if (!cfg) missing.push(symbol);
    else if (!cfg.spotToken) noSpot.push(symbol);
    else resolved.push(symbol);
  }

  const vcfg = require('../config/vegaConfig');
  const perStock = nifty50.stockTokenCost(vcfg.STOCK_STRIKE_WINDOW, vcfg.STOCK_EXPIRY_COUNT);
  const perIndex = ((2 * vcfg.STRIKE_WINDOW + 1) * 2 + 2) * vcfg.EXPIRY_COUNT;
  const indexCount = Object.values(UNDERLYINGS).filter((u) => getExpiries(u.key).length).length;
  const projected = indexCount * perIndex + resolved.length * perStock;

  console.log(
    `[Instruments] Universe: ${resolved.length}/${nifty50.UNIVERSE_SYMBOLS.length} stocks live, `
    + `${indexCount} indices live`
  );
  console.log(
    `[Instruments] Standing token cost ~${projected} of ${vcfg.TOKEN_BUDGET} budget `
    + `(${indexCount} x ${perIndex} index + ${resolved.length} x ${perStock} stock)`
    + (projected > vcfg.TOKEN_BUDGET ? '  ** OVER BUDGET — targets will be dropped **' : '')
  );

  if (missing.length) {
    console.warn(`[Instruments] ⚠ No live option chain for: ${missing.join(', ')} `
      + '(renamed, delisted, or out of F&O — update constants/nifty50.js)');
  }
  if (noSpot.length) {
    console.warn(`[Instruments] ⚠ No spot token resolved for: ${noSpot.join(', ')} `
      + '(cash listing did not match — these will not appear in the selector)');
  }
}

function buildDerivedConfig(key, sampleContract) {
  const optionExchange = sampleContract.exchange === 'BFO' ? 'BFO' : 'NFO';
  return {
    key,
    label: key,
    instrumentName: key,
    spotToken: null,          // filled in from the cash segment below
    spotSymbol: key,
    spotExchange: optionExchange === 'BFO' ? 'BSE' : 'NSE',
    optionExchange,
    strikeStep: 50,
    lotSize: sampleContract.lotSize || 0,
    derived: true,
  };
}

/** Most common positive gap between consecutive strikes. */
function inferStrikeStep(strikes) {
  if (!strikes || strikes.length < 3) return null;
  const gaps = new Map();
  for (let i = 1; i < strikes.length; i++) {
    const gap = Number((strikes[i] - strikes[i - 1]).toFixed(4));
    if (gap > 0) gaps.set(gap, (gaps.get(gap) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [gap, count] of gaps) {
    if (count > bestCount) { best = gap; bestCount = count; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Replaces the instruments table in one transaction.
 *
 * DELETE + chunked INSERT rather than TRUNCATE: TRUNCATE causes an implicit
 * commit in MySQL, which would break the transaction and leave the table empty
 * if the inserts then failed. This way a failed refresh rolls back to
 * yesterday's master instead of to nothing.
 */
async function persist(rows) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM instruments');

    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => [
        Number(r.instrument_token),
        Number(r.exchange_token) || null,
        r.tradingsymbol,
        r.name || null,
        toExpiryKey(r.expiry),
        Number(r.strike) || 0,
        Number(r.tick_size) || 0.05,
        Number(r.lot_size) || 0,
        r.instrument_type,
        r.segment,
        r.exchange,
      ]);

      await conn.query(
        `INSERT INTO instruments
           (instrument_token, exchange_token, tradingsymbol, name, expiry,
            strike, tick_size, lot_size, instrument_type, segment, exchange)
         VALUES ?
         ON DUPLICATE KEY UPDATE tradingsymbol = VALUES(tradingsymbol)`,
        [chunk]
      );
    }

    await conn.query(
      `INSERT INTO instrument_refresh_log (refreshed_at, instrument_count, status)
       VALUES (NOW(), :count, 'success')`,
      { count: rows.length }
    );

    await conn.commit();
    console.log(`[Instruments] Persisted ${rows.length} rows to MySQL`);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/**
 * Rebuilds the memory index from MySQL without calling Kite.
 *
 * This is what makes the chain survive a restart outside market hours, or a
 * restart before an admin has re-authenticated for the day. Contracts do not
 * change intraday, so yesterday's master is correct until the next 08:15.
 */
async function loadFromDatabase() {
  try {
    const [rows] = await db.query(
      `SELECT instrument_token, exchange_token, tradingsymbol, name, expiry,
              strike, tick_size, lot_size, instrument_type, segment, exchange
         FROM instruments`
    );
    if (!rows.length) {
      console.log('[Instruments] MySQL cache is empty — waiting for a Kite refresh.');
      return false;
    }
    buildIndexes(rows);
    ready = true;
    lastRefreshAt = new Date();
    console.log(`[Instruments] Restored ${byToken.size} instruments from MySQL cache`);
    return true;
  } catch (err) {
    console.warn('[Instruments] Could not load MySQL cache:', err.message);
    return false;
  }
}

/**
 * Kite regenerates the instrument dump every morning around 07:00 IST. 08:15
 * is after that and before the 09:15 open, so the master is fresh for the day
 * without racing the file generation.
 */
function scheduleDailyRefresh(kc) {
  cron.schedule('15 8 * * 1-5', async () => {
    console.log('[Instruments] Daily refresh…');
    try {
      await refresh(kc, { force: true });
    } catch (err) {
      lastRefreshError = err.message;
      console.error('[Instruments] Daily refresh failed:', err.message);
    }
  }, IST);
  console.log('[Instruments] Daily refresh scheduled for 08:15 IST (Mon-Fri)');
}

// ---------------------------------------------------------------------------
// Query API — everything the option chain calls
// ---------------------------------------------------------------------------

function isReady() {
  return ready && byToken.size > 0;
}

/** Sorted, future-only expiries for an underlying. Nearest first, like Kite. */
function getExpiries(symbol) {
  const cfg = resolveUnderlying(symbol);
  if (!cfg) return [];
  const bucket = byUnderlying.get(cfg.instrumentName.toUpperCase());
  if (!bucket) return [];
  const today = todayIst();
  return [...bucket.expiries].filter((e) => e >= today).sort();
}

/**
 * The full CE/PE board for one expiry.
 * @returns {{ strikes: number[], byStrike: Object<number, {CE, PE}> }}
 */
function getStrikeMap(symbol, expiry) {
  const cfg = resolveUnderlying(symbol);
  if (!cfg) return { strikes: [], byStrike: {} };

  const bucket = byUnderlying.get(cfg.instrumentName.toUpperCase());
  const strikeMap = bucket?.chains.get(expiry);
  if (!strikeMap) return { strikes: [], byStrike: {} };

  const strikes = [...strikeMap.keys()].filter((s) => s > 0).sort((a, b) => a - b);
  const byStrike = {};
  for (const strike of strikes) byStrike[strike] = strikeMap.get(strike);

  return { strikes, byStrike };
}

/**
 * The `window` strikes either side of spot, plus spot's own strike.
 *
 * NIFTY lists ~140 strikes per weekly expiry. Subscribing all of them across
 * five indices blows past Kite's ~3,000-token-per-connection cap, and nobody
 * reads a 280-row table. 20 either side is what Kite itself renders.
 */
function selectStrikes(strikes, spot, window = 20) {
  if (!Array.isArray(strikes) || !strikes.length) return [];
  if (spot == null) {
    // No spot yet (pre-open, or first tick not in). Centre on the board so the
    // table still paints instead of showing an empty shell.
    const mid = Math.floor(strikes.length / 2);
    return strikes.slice(Math.max(0, mid - window), mid + window + 1);
  }

  // Index of the listed strike nearest spot.
  let atmIndex = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const distance = Math.abs(strikes[i] - spot);
    if (distance < bestDistance) { bestDistance = distance; atmIndex = i; }
  }

  return strikes.slice(Math.max(0, atmIndex - window), atmIndex + window + 1);
}

/**
 * Instrument tokens to subscribe for one {symbol, expiry} view.
 * Used by subscriptionManager to build the union across all clients.
 */
function getTokensForExpiry(symbol, expiry, { spot = null, strikeWindow = 20 } = {}) {
  const { strikes, byStrike } = getStrikeMap(symbol, expiry);
  const selected = selectStrikes(strikes, spot, strikeWindow);

  const tokens = [];
  for (const strike of selected) {
    const pair = byStrike[strike];
    if (pair?.CE) tokens.push(pair.CE.instrumentToken);
    if (pair?.PE) tokens.push(pair.PE.instrumentToken);
  }

  // The nearest future is what a Kite-style header shows next to spot.
  const cfg = resolveUnderlying(symbol);
  const future = cfg ? getNearestFuture(cfg.key) : null;
  if (future) tokens.push(future.instrumentToken);

  return { tokens, strikes: selected, future };
}

function getNearestFuture(symbol) {
  const cfg = resolveUnderlying(symbol);
  if (!cfg) return null;
  const bucket = byUnderlying.get(cfg.instrumentName.toUpperCase());
  if (!bucket || !bucket.futures.size) return null;
  const nearest = [...bucket.futures.keys()].sort()[0];
  return bucket.futures.get(nearest) || null;
}

function getInstrument(token) {
  return byToken.get(Number(token)) || null;
}

function getInstrumentBySymbol(tradingsymbol) {
  return bySymbol.get(tradingsymbol) || null;
}

/**
 * Fast prefix/substring search over the master. Backs the watchlist search box.
 * Exact tradingsymbol matches float to the top, then prefix, then substring.
 */
function search(query, { limit = 25, types = null, exchanges = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];

  const exact = [];
  const prefix = [];
  const contains = [];

  for (const entry of searchIndex) {
    if (types && !types.includes(entry.type)) continue;
    if (exchanges && !exchanges.includes(entry.exchange)) continue;

    const symbol = entry.tradingsymbol.toLowerCase();
    if (symbol === q) exact.push(entry);
    else if (symbol.startsWith(q)) prefix.push(entry);
    else if (entry.q.includes(q)) contains.push(entry);

    if (exact.length >= limit) break;
  }

  return [...exact, ...prefix, ...contains].slice(0, limit).map((e) => ({
    tradingsymbol: e.tradingsymbol,
    instrumentToken: e.token,
    name: e.name,
    exchange: e.exchange,
    instrumentType: e.type,
    expiry: e.expiry,
    strike: e.strike,
  }));
}

/** Every underlying that actually has a live chain — curated first. */
function listTradableUnderlyings() {
  const curated = Object.values(UNDERLYINGS)
    .filter((u) => getExpiries(u.key).length)
    .map((u) => ({ ...u, derived: false }));

  const derived = [...derivedUnderlyings.values()]
    .filter((u) => u.spotToken && getExpiries(u.key).length)
    .sort((a, b) => a.key.localeCompare(b.key));

  return [...curated, ...derived];
}

function getStats() {
  return {
    ready: isReady(),
    instrumentCount: byToken.size,
    underlyingCount: byUnderlying.size,
    derivedUnderlyingCount: derivedUnderlyings.size,
    searchableCount: searchIndex.length,
    lastRefreshAt: lastRefreshAt ? lastRefreshAt.toISOString() : null,
    lastRefreshError,
    refreshing: refreshInFlight !== null,
  };
}

module.exports = {
  // lifecycle
  refresh,
  loadFromDatabase,
  scheduleDailyRefresh,
  isReady,
  getStats,

  // chain queries (called by optionChainService / subscriptionManager /
  // optionStreamService / optionChainController / marketRoutes)
  getExpiries,
  getStrikeMap,
  selectStrikes,
  getTokensForExpiry,
  getNearestFuture,

  // lookups
  getInstrument,
  getInstrumentBySymbol,
  search,
  resolveUnderlying,
  listTradableUnderlyings,

  // Re-exported so any existing `instrumentService.UNDERLYINGS` reference in
  // your code keeps working — nothing that used the old file breaks.
  UNDERLYINGS: constants.UNDERLYINGS,
  INDEX_TOKENS: constants.INDEX_TOKENS,
  TOKEN_TO_SYMBOL: constants.TOKEN_TO_SYMBOL,
  SUBSCRIBED_TOKENS: constants.SUBSCRIBED_TOKENS,
  OPTION_EXCHANGES: constants.OPTION_EXCHANGES,
  getUnderlying: constants.getUnderlying,
  listUnderlyings: constants.listUnderlyings,
};