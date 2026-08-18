const db = require('../config/db');

/**
 * The IST trading date (B-11).
 *
 * These two writers used new Date().toISOString().slice(0,10) — the UTC date —
 * while snapshot_date everywhere else in the system is the IST trading day. It
 * happened to agree only because the capture crons fire at 15:35/15:40 IST
 * (10:05/10:10 UTC, the same calendar date). Any change to those schedules, or
 * a manual run in the evening, would have filed the rows under the wrong day.
 */
function todayIst() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Backs the two columns that CANNOT be derived from a live tick:
 *
 *   OI Change      = today's OI minus yesterday's CLOSING OI.
 *                    A Kite tick carries `oi` only — never a delta. You have
 *                    to snapshot OI at the close and diff against it.
 *
 *   IV Percentile  = where today's ATM IV sits in its own trailing history.
 *                    Needs a stored daily series.
 *
 * Both return null until data has been banked. Day one shows blanks. That is
 * correct — a fabricated value here would silently mislead.
 */

let baselineMap = new Map();   // instrument_token -> previous close OI
let ivHistory = new Map();     // symbol -> number[] (oldest first)

/** Loads the most recent OI baseline into memory. Call on boot and after capture. */
async function loadBaseline() {
  try {
    const [rows] = await db.query(
      `SELECT instrument_token, close_oi
         FROM oi_baseline
        WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM oi_baseline)`
    );
    baselineMap = new Map(rows.map((r) => [Number(r.instrument_token), Number(r.close_oi)]));
    console.log(`[OI Baseline] Loaded ${baselineMap.size} instruments`);
  } catch (err) {
    console.warn('[OI Baseline] Could not load:', err.message);
    baselineMap = new Map();
  }
  return baselineMap;
}

/**
 * Captures closing OI for everything currently in the tick cache.
 * Schedule this just after 15:30 IST on trading days.
 */
async function captureBaseline(latestTicks) {
  const rows = [];
  for (const tick of latestTicks.values()) {
    if (tick.oi != null) rows.push([tick.instrumentToken, tick.oi]);
  }
  if (!rows.length) {
    console.warn('[OI Baseline] Nothing to capture — tick cache is empty');
    return 0;
  }

  const today = todayIst();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    // Chunked to keep the packet under max_allowed_packet on big chains.
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      await conn.query(
        `INSERT INTO oi_baseline (snapshot_date, instrument_token, close_oi)
         VALUES ?
         ON DUPLICATE KEY UPDATE close_oi = VALUES(close_oi)`,
        [chunk.map(([token, oi]) => [today, token, oi])]
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  console.log(`[OI Baseline] Captured ${rows.length} instruments for ${today}`);
  return rows.length;
}

/** Appends today's ATM IV so IV percentile has something to sit against. */
async function recordAtmIv(symbol, atmIv) {
  if (atmIv == null) return;
  const today = todayIst();
  await db.query(
    `INSERT INTO iv_history (snapshot_date, symbol, atm_iv)
     VALUES (:date, :symbol, :iv)
     ON DUPLICATE KEY UPDATE atm_iv = VALUES(atm_iv)`,
    { date: today, symbol, iv: atmIv }
  );
  await loadIvHistory(symbol);
}

async function loadIvHistory(symbol, lookbackDays = 252) {
  try {
    const [rows] = await db.query(
      `SELECT atm_iv FROM iv_history
        WHERE symbol = :symbol
        ORDER BY snapshot_date DESC
        LIMIT :limit`,
      { symbol, limit: lookbackDays }
    );
    ivHistory.set(symbol, rows.map((r) => Number(r.atm_iv)).reverse());
  } catch (err) {
    console.warn(`[IV History] Could not load ${symbol}:`, err.message);
  }
  return ivHistory.get(symbol) || [];
}

async function loadAllIvHistory(symbols) {
  await Promise.all(symbols.map((s) => loadIvHistory(s)));
}

function getBaselineMap() { return baselineMap; }
function getIvHistorySync(symbol) { return ivHistory.get(symbol) || []; }

module.exports = {
  loadBaseline,
  captureBaseline,
  recordAtmIv,
  loadIvHistory,
  loadAllIvHistory,
  getBaselineMap,
  getIvHistorySync,
};