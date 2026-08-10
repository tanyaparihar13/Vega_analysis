/**
 * Migration runner.
 *
 * package.json already declared `"db:migrate": "node src/config/migrate.js"`,
 * but the file did not exist — running it gave you MODULE_NOT_FOUND. This is
 * that file.
 *
 * Applies every schema*.sql in src/, in dependency order, idempotently.
 * Safe to run on every boot: every statement is CREATE TABLE IF NOT EXISTS,
 * an INSERT ... ON DUPLICATE KEY UPDATE, or an information_schema-guarded
 * ALTER, so re-running is a no-op.
 *
 *   npm run db:migrate          apply everything
 *   require('./migrate').run()  called automatically from index.js at boot
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

// Order matters: schema.sql creates `users`, which oauth_states references
// with a foreign key.


// schema.onboarding.sql is last: it declares foreign keys onto `users` and
// backfills from it, so `users` must already exist and be populated.
const MIGRATIONS = [
  'schema.sql',
  'schema.options.sql',
  'schema.instruments.sql',
  'schema.vega.sql',
  'schema.admin.sql',
  'schema.onboarding.sql',
];
/**
 * Migrations need a connection that is NOT bound to a database, because
 * schema.sql starts with CREATE DATABASE. The app pool in config/db.js
 * connects straight to DB_NAME and would fail on a fresh install before the
 * database exists.
 *
 * multipleStatements is enabled here and nowhere else. These files are ours
 * and contain no user input; turning it on for the app pool would widen SQL
 * injection from "read one row" to "run any statement".
 */
async function createMigrationConnection() {
  return mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });
}

async function run({ verbose = true } = {}) {
  const log = verbose ? console.log : () => {};
  let conn;

  try {
    conn = await createMigrationConnection();
  } catch (err) {
    console.error('[Migrate] Cannot reach MySQL:', err.message);
    console.error('[Migrate] Check DB_HOST / DB_PORT / DB_USER / DB_PASSWORD in server/.env');
    throw err;
  }

  const applied = [];

  try {
    for (const file of MIGRATIONS) {
      const fullPath = path.join(__dirname, '..', file);

      if (!fs.existsSync(fullPath)) {
        console.warn(`[Migrate] Skipping ${file} — not found at ${fullPath}`);
        continue;
      }

      const sql = fs.readFileSync(fullPath, 'utf8');
      log(`[Migrate] Applying ${file}…`);

      try {
        await conn.query(sql);
        applied.push(file);
        log(`[Migrate] ✓ ${file}`);
      } catch (err) {
        // A duplicate-object error means a previous run already did this. Not
        // a failure — keep going rather than blocking boot.
        if (
          err.code === 'ER_DUP_KEYNAME' ||
          err.code === 'ER_DUP_FIELDNAME' ||
          err.code === 'ER_TABLE_EXISTS_ERROR'
        ) {
          log(`[Migrate] ✓ ${file} (already applied)`);
          applied.push(file);
          continue;
        }
        console.error(`[Migrate] ✗ ${file}: ${err.sqlMessage || err.message}`);
        throw err;
      }
    }

    log(`[Migrate] Done — ${applied.length}/${MIGRATIONS.length} files applied.`);
    return applied;
  } finally {
    await conn.end().catch(() => {});
  }
}

// Direct invocation: `npm run db:migrate`
if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Migrate] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run };