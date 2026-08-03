/**
 * Vega tables diagnostic. Run from the server folder:
 *     node diagnose-vega.js
 *
 * Reads your real .env, connects to your real DB, and reports EXACTLY what
 * the vega tables look like — so we stop guessing why call_vega_diff is
 * "unknown".
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'vega_analysis',
  });

  console.log('\n=== Connected to database:', process.env.DB_NAME || 'vega_analysis', '===\n');

  // 1. Which vega tables exist?
  const [tables] = await conn.query(
    "SHOW TABLES LIKE 'vega%'"
  );
  console.log('Vega tables present:');
  console.log(tables.length ? tables.map(t => '   - ' + Object.values(t)[0]).join('\n') : '   (none)');

  // 2. What columns does vega_timeseries actually have?
  const [cols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vega_timeseries'
      ORDER BY ORDINAL_POSITION`
  );
  console.log('\nvega_timeseries columns:');
  if (!cols.length) {
    console.log('   (table does not exist)');
  } else {
    const names = cols.map(c => c.COLUMN_NAME);
    console.log('   ' + names.join(', '));
    console.log('\n   Has call_vega_diff? ', names.includes('call_vega_diff') ? '✅ YES (schema is correct)' : '❌ NO  (this is the bug — old table still here)');
  }

  // 3. Does vega_day_open exist?
  const [doCols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vega_day_open'`
  );
  console.log('\nvega_day_open exists? ', doCols.length ? '✅ YES' : '❌ NO');

  console.log('\n=== VERDICT ===');
  const names = cols.map(c => c.COLUMN_NAME);
  if (names.includes('call_vega_diff') && doCols.length) {
    console.log('✅ Schema is correct. If the server still errors, it needs a restart.');
  } else {
    console.log('❌ Old schema still in place. Run the FIX below, then migrate again.\n');
    console.log('   Database in use:', process.env.DB_NAME || 'vega_analysis');
    console.log('   (Make sure any DROP you run targets THIS database, not another one.)');
  }

  await conn.end();
})().catch(e => { console.error('Diagnostic failed:', e.message); process.exit(1); });