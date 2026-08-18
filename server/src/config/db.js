const mysql = require("mysql2/promise");
require("dotenv").config();

if (process.env.NODE_ENV !== 'production') {
  // Dev-only diagnostic — never log DB_PASSWORD or other secrets.
  console.log(`[DB] Connecting to ${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME} as ${process.env.DB_USER}`);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  namedPlaceholders: true,
  /**
   * LOAD-BEARING — do not turn this off (see B-07).
   *
   * With dateStrings, DATE and DATETIME columns come back as 'YYYY-MM-DD' and
   * 'YYYY-MM-DD HH:MM:SS' strings. Every date path in this application is
   * written against that: expiryKey(), rowToPoint() (which appends 'Z' to read
   * the value as the UTC it was written in), toIsoDate() and yearsToExpiry().
   *
   * Switching it to false hands those functions JS Date objects instead. That
   * is now caught loudly rather than silently — yearsToExpiry throws on an
   * unparseable value instead of returning NaN — but the correct configuration
   * is still this one.
   */
  dateStrings: true,
});

// Test database connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("[DB] MySQL pool connected successfully");
    connection.release();
  } catch (err) {
    // mysql2 connection errors carry the reason in `code` and often leave
    // `message` empty — printing message alone gave a bare "Failed to connect".
    console.error("[DB] Failed to connect to MySQL:", err.code || err.message);
  }
})();

module.exports = pool;