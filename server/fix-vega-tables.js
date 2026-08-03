/**
 * One-shot fixer for the vega tables — CORRECTED VERSION.
 *
 * Recreates vega_day_open / vega_timeseries with the schema that
 * services/vegaTimeseriesService.js actually expects (open_chain JSON,
 * open_call_vega, open_put_vega) instead of the old flat-column shape.
 */
const mysql = require('mysql2/promise');
require('dotenv').config();

const DDL = `
DROP TABLE IF EXISTS vega_timeseries;
DROP TABLE IF EXISTS vega_day_open;

CREATE TABLE vega_day_open (
  snapshot_date DATE        NOT NULL,
  symbol        VARCHAR(20) NOT NULL,
  expiry        DATE        DEFAULT NULL,
  captured_at   DATETIME    NOT NULL,

  open_chain    JSON        NOT NULL,
  call_strikes  JSON        DEFAULT NULL,
  put_strikes   JSON        DEFAULT NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (snapshot_date, symbol)
) ENGINE=InnoDB;

CREATE TABLE vega_timeseries (
  snapshot_date     DATE          NOT NULL,
  symbol            VARCHAR(20)   NOT NULL,
  sampled_at        DATETIME      NOT NULL,
  expiry            DATE          DEFAULT NULL,

  call_vega_diff    DECIMAL(16,4) NOT NULL DEFAULT 0,
  put_vega_diff     DECIMAL(16,4) NOT NULL DEFAULT 0,
  vega_diff         DECIMAL(16,4) NOT NULL DEFAULT 0,

  current_call_vega DECIMAL(16,4) NOT NULL DEFAULT 0,
  current_put_vega  DECIMAL(16,4) NOT NULL DEFAULT 0,
  open_call_vega    DECIMAL(16,4) NOT NULL DEFAULT 0,
  open_put_vega     DECIMAL(16,4) NOT NULL DEFAULT 0,

  price             DECIMAL(14,4) DEFAULT NULL,
  call_strike_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  put_strike_count  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (snapshot_date, symbol, sampled_at),
  INDEX idx_vega_series (symbol, snapshot_date, sampled_at)
) ENGINE=InnoDB;
`;

(async () => {
  const dbName = process.env.DB_NAME || 'vega_analysis';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    database: dbName,
    multipleStatements: true,
  });

  console.log(`\n[Fix v2] Connected to database: ${dbName}`);
  console.log('[Fix v2] Dropping and recreating vega_day_open + vega_timeseries…');

  await conn.query(DDL);

  const [dayOpenCols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vega_day_open'
      ORDER BY ORDINAL_POSITION`
  );
  const [seriesCols] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vega_timeseries'
      ORDER BY ORDINAL_POSITION`
  );

  const dayOpenNames = dayOpenCols.map((c) => c.COLUMN_NAME);
  const seriesNames = seriesCols.map((c) => c.COLUMN_NAME);

  console.log('\n[Fix v2] vega_day_open columns:', dayOpenNames.join(', '));
  console.log('[Fix v2] Has open_chain?      ', dayOpenNames.includes('open_chain') ? '✅ YES' : '❌ NO');

  console.log('\n[Fix v2] vega_timeseries columns:', seriesNames.join(', '));
  console.log('[Fix v2] Has open_call_vega?  ', seriesNames.includes('open_call_vega') ? '✅ YES' : '❌ NO');
  console.log('[Fix v2] Has open_put_vega?   ', seriesNames.includes('open_put_vega') ? '✅ YES' : '❌ NO');

  const ok = dayOpenNames.includes('open_chain')
    && seriesNames.includes('open_call_vega')
    && seriesNames.includes('open_put_vega');

  if (ok) {
    console.log('\n✅ DONE. Schema now matches vegaTimeseriesService.js.');
    console.log('   Restart the server (npm run dev) and let it capture a fresh day-open at/after 09:16 IST.\n');
  } else {
    console.log('\n❌ Something is still off. Send me this output.\n');
  }

  await conn.end();
})().catch((e) => { console.error('[Fix v2] Failed:', e.message); process.exit(1); });