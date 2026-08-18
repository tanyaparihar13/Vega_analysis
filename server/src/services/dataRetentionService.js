'use strict';

const db = require('../config/db');

/**
 * B-12: the cutoff is CURDATE(), not NOW().
 *
 * These columns hold a DATE (the IST trading day) or a DATETIME. NOW() is MySQL
 * server-local wall time, while vegaTimeseriesService.purgeOldHistory() — which
 * sweeps the same vega tables — uses CURDATE(). Two retention paths on two
 * different clocks can disagree at the day boundary about whether a row is
 * inside the window. One clock, and it is the one the read path keys off.
 */

/**
 * Purgeable tables, whitelisted by name -> date column. The table name is
 * NEVER taken from the request as a raw string into SQL — it is only ever
 * used as a key into this object, so an unrecognized value simply doesn't
 * resolve to anything (see resolve() below).
 */
const PURGE_TARGETS = {
  vega_timeseries: 'snapshot_date',
  vega_chain_snapshots: 'snapshot_date',
  login_history: 'login_at',
};

function resolve(table) {
  const dateColumn = PURGE_TARGETS[table];
  if (!dateColumn) {
    throw new Error(`Unsupported purge table: ${table}. Allowed: ${Object.keys(PURGE_TARGETS).join(', ')}`);
  }
  return dateColumn;
}

async function countPurgeCandidates({ table, olderThanDays }) {
  const dateColumn = resolve(table);
  const days = Math.max(Number(olderThanDays) || 0, 0);
  const [[{ count }]] = await db.query(
    `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${dateColumn}\` < CURDATE() - INTERVAL :days DAY`,
    { days }
  );
  return Number(count);
}

async function purge({ table, olderThanDays }) {
  const dateColumn = resolve(table);
  const days = Math.max(Number(olderThanDays) || 0, 0);
  const [result] = await db.query(
    `DELETE FROM \`${table}\` WHERE \`${dateColumn}\` < CURDATE() - INTERVAL :days DAY`,
    { days }
  );
  return result.affectedRows;
}

module.exports = { PURGE_TARGETS, countPurgeCandidates, purge };
