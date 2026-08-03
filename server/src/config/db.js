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
  dateStrings: true,
});

// Test database connection
(async () => {
  try {
    const connection = await pool.getConnection();
    console.log("[DB] MySQL pool connected successfully");
    connection.release();
  } catch (err) {
    console.error("[DB] Failed to connect to MySQL:", err.message);
  }
})();

module.exports = pool;