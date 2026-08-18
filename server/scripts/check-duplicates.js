#!/usr/bin/env node
'use strict';

/**
 * DATABASE INTEGRITY REPORT — READ ONLY.
 *
 *   node scripts/check-duplicates.js
 *   npm run db:duplicates
 *
 * ===========================================================================
 * THIS SCRIPT NEVER WRITES. There is no --fix flag and no DELETE statement in
 * it. If duplicates are found it reports them and stops; removing anything from
 * a production financial history is a decision for a human with a backup, not
 * for a script run from a terminal.
 * ===========================================================================
 *
 * What it checks:
 *   1. Duplicate time-series points. The primary key
 *      (snapshot_date, symbol, expiry, resolution, sampled_at) makes these
 *      IMPOSSIBLE on the current schema — so a non-zero count here means the
 *      table predates the expiry/resolution key migration in schema.vega.sql
 *      and is still on the old shape. That is the finding, not the rows.
 *   2. Rows whose sampled_at falls outside the IST market window, which would
 *      indicate a timezone regression.
 *   3. Rows whose snapshot_date disagrees with the IST date of sampled_at —
 *      the "yesterday's data under today's date" failure mode.
 *   4. Baselines with no samples, and samples with no baseline.
 *   5. Whether the expected keys and indexes actually exist.
 */

const db = require('../src/config/db');

const RED = (s) => `\x1b[31m${s}\x1b[0m`;
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

let problems = 0;

function head(title) {
  console.log(`\n${BOLD('── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length)))}`);
}

function ok(msg) { console.log(`  ${GREEN('OK')}   ${msg}`); }
function bad(msg) { problems += 1; console.log(`  ${RED('FAIL')} ${msg}`); }
function warn(msg) { console.log(`  ${YELLOW('WARN')} ${msg}`); }

async function q(sql, params = {}) {
  const [rows] = await db.query(sql, params);
  return rows;
}

async function tableExists(name) {
  const rows = await q(
    `SELECT COUNT(*) AS n FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :name`, { name }
  );
  return Number(rows[0].n) > 0;
}

// ---------------------------------------------------------------- 1. schema
async function checkSchema() {
  head('Schema — keys and indexes');

  for (const table of ['vega_timeseries', 'vega_day_open']) {
    if (!(await tableExists(table))) { bad(`${table} does not exist — run npm run db:migrate`); continue; }
  }

  const pk = await q(
    `SELECT COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vega_timeseries'
        AND INDEX_NAME = 'PRIMARY' ORDER BY SEQ_IN_INDEX`
  );
  const cols = pk.map((r) => r.COLUMN_NAME);
  const expected = ['snapshot_date', 'symbol', 'expiry', 'resolution', 'sampled_at'];
  if (expected.every((c) => cols.includes(c))) {
    ok(`vega_timeseries PRIMARY KEY = (${cols.join(', ')})`);
  } else {
    bad(`vega_timeseries PRIMARY KEY is (${cols.join(', ') || 'none'}) — expected (${expected.join(', ')}).`);
    console.log('       Duplicate points are POSSIBLE on this shape. Run npm run db:migrate.');
  }

  const idx = await q(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vega_timeseries'`
  );
  const names = idx.map((r) => r.INDEX_NAME);
  if (names.includes('idx_vega_series')) ok('idx_vega_series present');
  else bad('idx_vega_series missing — every expiry-filtered read scans the day');
}

// ------------------------------------------------------------ 2. duplicates
async function checkDuplicates() {
  head('Duplicate time-series points');

  const dupes = await q(
    `SELECT snapshot_date, symbol, expiry, resolution, sampled_at, COUNT(*) AS n
       FROM vega_timeseries
      GROUP BY snapshot_date, symbol, expiry, resolution, sampled_at
     HAVING n > 1
      ORDER BY n DESC, snapshot_date DESC
      LIMIT 50`
  );

  if (!dupes.length) { ok('No duplicate points on (date, symbol, expiry, resolution, sampled_at)'); return; }

  bad(`${dupes.length} duplicated key(s) found (showing up to 50)`);
  console.log('\n    DATE       | SYMBOL     | EXPIRY     | RES | SAMPLED AT          | COUNT');
  console.log('    -----------|------------|------------|-----|---------------------|------');
  for (const d of dupes) {
    console.log(`    ${String(d.snapshot_date).slice(0, 10)} | ${String(d.symbol).padEnd(10)} | ${String(d.expiry).slice(0, 10)} | ${String(d.resolution).padEnd(3)} | ${String(d.sampled_at).padEnd(19)} | ${d.n}`);
  }

  const summary = await q(
    `SELECT symbol, expiry, resolution, COUNT(*) AS affected_keys, SUM(n - 1) AS surplus_rows
       FROM (SELECT symbol, expiry, resolution, COUNT(*) AS n
               FROM vega_timeseries
              GROUP BY snapshot_date, symbol, expiry, resolution, sampled_at
             HAVING n > 1) t
      GROUP BY symbol, expiry, resolution ORDER BY surplus_rows DESC`
  );
  console.log('\n    Affected symbols / expiries / timeframes:');
  for (const s of summary) {
    console.log(`      ${String(s.symbol).padEnd(12)} exp ${String(s.expiry).slice(0, 10)}  res ${s.resolution}  keys ${s.affected_keys}  surplus rows ${s.surplus_rows}`);
  }
  const dates = await q(
    `SELECT DISTINCT snapshot_date FROM (
       SELECT snapshot_date, COUNT(*) AS n FROM vega_timeseries
        GROUP BY snapshot_date, symbol, expiry, resolution, sampled_at HAVING n > 1) t
      ORDER BY snapshot_date`
  );
  console.log(`    Affected dates: ${dates.map((d) => String(d.snapshot_date).slice(0, 10)).join(', ')}`);
  console.log(`\n    ${YELLOW('NOTHING HAS BEEN DELETED.')} Review the above, take a backup, then decide.`);
}

// --------------------------------------------------- 3. date/time integrity
async function checkDates() {
  head('Date / timezone integrity');

  /**
   * snapshot_date is the IST trading day; sampled_at is UTC. For a real sample
   * (09:15-15:30 IST == 03:45-10:00 UTC) they are the same calendar date. A row
   * where they disagree means a timezone regression somewhere in the writer.
   */
  const mismatched = await q(
    `SELECT snapshot_date, symbol, expiry, MIN(sampled_at) AS first_at, COUNT(*) AS n
       FROM vega_timeseries
      WHERE DATE(CONVERT_TZ(sampled_at, '+00:00', '+05:30')) <> snapshot_date
      GROUP BY snapshot_date, symbol, expiry
      ORDER BY snapshot_date DESC LIMIT 20`
  ).catch(() => null);

  if (mismatched === null) {
    warn('CONVERT_TZ returned NULL — MySQL timezone tables are not loaded.');
    console.log('       Load them with: mysql_tzinfo_to_sql /usr/share/zoneinfo | mysql -u root -p mysql');
    console.log('       (This check is skipped; nothing else in the app depends on CONVERT_TZ.)');
  } else if (!mismatched.length) {
    ok('Every row\'s snapshot_date matches the IST date of its sampled_at');
  } else {
    bad(`${mismatched.length} group(s) where snapshot_date disagrees with the IST date of sampled_at`);
    for (const m of mismatched) {
      console.log(`      ${String(m.snapshot_date).slice(0, 10)}  ${m.symbol}  exp ${String(m.expiry).slice(0, 10)}  first ${m.first_at}  rows ${m.n}`);
    }
  }

  const outside = await q(
    `SELECT COUNT(*) AS n FROM vega_timeseries
      WHERE TIME(sampled_at) < '03:40:00' OR TIME(sampled_at) > '10:05:00'`
  );
  if (Number(outside[0].n) === 0) ok('All samples fall inside 09:15-15:30 IST (03:45-10:00 UTC)');
  else bad(`${outside[0].n} row(s) sampled outside the IST market window`);

  const future = await q(`SELECT COUNT(*) AS n FROM vega_timeseries WHERE sampled_at > UTC_TIMESTAMP()`);
  if (Number(future[0].n) === 0) ok('No future-dated samples');
  else bad(`${future[0].n} row(s) with a sampled_at in the future`);
}

// ------------------------------------------------------ 4. referential sanity
async function checkOrphans() {
  head('Baselines and samples');

  const noSamples = await q(
    `SELECT o.snapshot_date, o.symbol, o.expiry FROM vega_day_open o
      LEFT JOIN vega_timeseries t
        ON t.snapshot_date = o.snapshot_date AND t.symbol = o.symbol AND t.expiry = o.expiry
      WHERE t.symbol IS NULL ORDER BY o.snapshot_date DESC LIMIT 20`
  );
  if (!noSamples.length) ok('Every day-open baseline has samples');
  else {
    warn(`${noSamples.length} baseline(s) with no samples — these show as empty sessions in the date picker`);
    for (const o of noSamples) console.log(`      ${String(o.snapshot_date).slice(0, 10)}  ${o.symbol}  exp ${String(o.expiry).slice(0, 10)}`);
  }

  const noBaseline = await q(
    `SELECT t.snapshot_date, t.symbol, t.expiry, COUNT(*) AS n FROM vega_timeseries t
      LEFT JOIN vega_day_open o
        ON t.snapshot_date = o.snapshot_date AND t.symbol = o.symbol AND t.expiry = o.expiry
      WHERE o.symbol IS NULL
      GROUP BY t.snapshot_date, t.symbol, t.expiry ORDER BY t.snapshot_date DESC LIMIT 20`
  );
  if (!noBaseline.length) ok('Every sample group has a day-open baseline');
  else {
    warn(`${noBaseline.length} sample group(s) with no baseline row`);
    for (const t of noBaseline) console.log(`      ${String(t.snapshot_date).slice(0, 10)}  ${t.symbol}  exp ${String(t.expiry).slice(0, 10)}  rows ${t.n}`);
  }
}

// ------------------------------------------------------------- 5. inventory
async function inventory() {
  head('Inventory');
  const rows = await q(
    `SELECT COUNT(*) AS rows_total, COUNT(DISTINCT symbol) AS symbols,
            COUNT(DISTINCT snapshot_date) AS days,
            MIN(snapshot_date) AS first_day, MAX(snapshot_date) AS last_day
       FROM vega_timeseries`
  );
  const r = rows[0];
  console.log(`  rows ${r.rows_total}   symbols ${r.symbols}   days ${r.days}   range ${String(r.first_day).slice(0, 10)} .. ${String(r.last_day).slice(0, 10)}`);

  const byRes = await q(`SELECT resolution, COUNT(*) AS n FROM vega_timeseries GROUP BY resolution`);
  console.log(`  by resolution: ${byRes.map((x) => `${x.resolution}=${x.n}`).join('  ')}`);
}

(async () => {
  console.log(BOLD('\nVega Analysis — database integrity report (READ ONLY)\n'));
  try {
    await checkSchema();
    await checkDuplicates();
    await checkDates();
    await checkOrphans();
    await inventory();
  } catch (err) {
    console.error(`\n${RED('Could not complete the report:')} ${err.message}`);
    process.exit(2);
  }

  console.log(`\n${BOLD('── Result ' + '─'.repeat(62))}`);
  if (problems === 0) console.log(`  ${GREEN('No integrity problems found.')}\n`);
  else console.log(`  ${RED(problems + ' problem(s) found.')} Nothing was modified. Review, back up, then decide.\n`);

  process.exit(0);
})();
