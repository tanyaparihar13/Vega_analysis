'use strict';

/**
 * chainSnapshotStore — OPTIONAL raw option-chain persistence (parity item 5).
 *
 * The PHP reference stored every minute's full option chain in `market_open`,
 * which let it recompute history and replay a past minute's chain. Our engine
 * normally keeps only the day-open chain plus the computed diffs, which is far
 * lighter. Turn this module on (VEGA_STORE_RAW_CHAINS=true) to additionally
 * archive the trimmed per-minute chain, enabling historical recompute/replay.
 *
 * It is deliberately isolated: if the table is missing or the flag is off,
 * every call is a cheap no-op and nothing else in the pipeline is affected.
 */

const db = require('../config/db');
const { STORE_RAW_CHAINS } = require('../config/vegaConfig');

let warned = false;

/** Trim a full chain row to just what a recompute needs (keeps rows small). */
function trimChain(chain) {
  return chain.map((r) => ({
    strike: r.strike,
    call: {
      vega: r.call?.vega ?? null, theta: r.call?.theta ?? null,
      gamma: r.call?.gamma ?? null, delta: r.call?.delta ?? null, iv: r.call?.iv ?? null,
      ltp: r.call?.ltp ?? null,   // the traded price the IV was solved from
    },
    put: {
      vega: r.put?.vega ?? null, theta: r.put?.theta ?? null,
      gamma: r.put?.gamma ?? null, delta: r.put?.delta ?? null, iv: r.put?.iv ?? null,
      ltp: r.put?.ltp ?? null,
    },
  }));
}

/**
 * Persist one snapshot. No-op unless the feature flag is on.
 * @param {{date:string, symbol:string, sampledAt:Date, expiry:string, chain:Array}} snap
 */
async function persist({ date, symbol, sampledAt, expiry, chain }) {
  if (!STORE_RAW_CHAINS) return;
  try {
    await db.query(
      `INSERT INTO vega_chain_snapshots (snapshot_date, symbol, sampled_at, expiry, chain)
       VALUES (:date, :symbol, :sampledAt, :expiry, :chain)
       ON DUPLICATE KEY UPDATE chain = VALUES(chain), expiry = VALUES(expiry)`,
      {
        date,
        symbol,
        sampledAt: sampledAt.toISOString().slice(0, 19).replace('T', ' '),
        expiry,
        chain: JSON.stringify(trimChain(chain)),
      }
    );
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[ChainSnapshot] persist disabled — table missing or write failed:', err.message);
    }
  }
}

/** Read a stored chain back (for replay/recompute tooling). */
async function getSnapshot(symbol, date, sampledAt) {
  const [rows] = await db.query(
    `SELECT chain FROM vega_chain_snapshots
      WHERE symbol = :symbol AND snapshot_date = :date AND sampled_at = :sampledAt`,
    { symbol: String(symbol).toUpperCase(), date, sampledAt }
  );
  if (!rows.length) return null;
  try {
    return typeof rows[0].chain === 'string' ? JSON.parse(rows[0].chain) : rows[0].chain;
  } catch {
    return null;
  }
}

/**
 * The EARLIEST archived chain for a session, at or after `notBefore`.
 *
 * This is the correct recovery for a day-open baseline that was missed because
 * the process was down at 09:16. The alternative — capturing whatever board is
 * in front of us at 09:30 and calling it the open — silently re-origins the
 * whole day's `current - open` series. If the archive is on, the real 09:16
 * chain is sitting right here and should be used instead of inventing one.
 *
 * `notBefore` is a 'HH:MM:SS' IST wall-clock time. sampled_at is stored in UTC
 * (persistSamples -> fmtSql -> toISOString), so the comparison is done in UTC
 * to match the column, exactly as loadDelayed does.
 *
 * Returns null when the archive is off, the table is missing, or the session
 * has nothing at or after the cutoff — every one of which is an ordinary
 * condition the caller must handle, not an error.
 *
 * @returns {Promise<{chain:Array, sampledAt:string}|null>}
 */
async function earliestChain(symbol, date, expiry, notBefore = '09:16:00') {
  if (!STORE_RAW_CHAINS) return null;
  try {
    // 'YYYY-MM-DDTHH:MM:SS+05:30' -> the UTC the column actually holds.
    const cutoff = new Date(`${date}T${notBefore}+05:30`)
      .toISOString().slice(0, 19).replace('T', ' ');

    const [rows] = await db.query(
      `SELECT chain, sampled_at FROM vega_chain_snapshots
        WHERE symbol = :symbol AND snapshot_date = :date
          AND (:expiry IS NULL OR expiry = :expiry)
          AND sampled_at >= :cutoff
        ORDER BY sampled_at ASC
        LIMIT 1`,
      { symbol: String(symbol).toUpperCase(), date, expiry: expiry || null, cutoff }
    );
    if (!rows.length) return null;
    const chain = typeof rows[0].chain === 'string' ? JSON.parse(rows[0].chain) : rows[0].chain;
    return Array.isArray(chain) && chain.length
      ? { chain, sampledAt: String(rows[0].sampled_at) }
      : null;
  } catch (err) {
    console.warn('[ChainSnapshot] earliestChain failed:', err.message);
    return null;
  }
}

module.exports = { persist, getSnapshot, earliestChain, enabled: () => STORE_RAW_CHAINS };