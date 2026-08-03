'use strict';

const db = require('../config/db');

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
    `SELECT COUNT(*) AS count FROM \`${table}\` WHERE \`${dateColumn}\` < DATE_SUB(NOW(), INTERVAL :days DAY)`,
    { days }
  );
  return Number(count);
}

async function purge({ table, olderThanDays }) {
  const dateColumn = resolve(table);
  const days = Math.max(Number(olderThanDays) || 0, 0);
  const [result] = await db.query(
    `DELETE FROM \`${table}\` WHERE \`${dateColumn}\` < DATE_SUB(NOW(), INTERVAL :days DAY)`,
    { days }
  );
  return result.affectedRows;
}

module.exports = { PURGE_TARGETS, countPurgeCandidates, purge };
