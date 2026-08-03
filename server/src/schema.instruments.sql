-- =====================================================
-- Vega Analysis — Instrument Master + OAuth state
-- Additive only. Nothing existing is dropped or altered.
-- Applied automatically by `npm run db:migrate`.
-- =====================================================

USE vega_analysis;

-- ---------------------------------------------------
-- INSTRUMENTS
-- The full NSE / BSE / NFO / BFO master, refreshed daily at 08:15 IST.
--
-- This is the durable copy. instrumentService keeps a memory index for the
-- hot path; this table is what lets the chain survive a restart before an
-- admin has re-authenticated for the day.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS instruments (
  instrument_token BIGINT UNSIGNED NOT NULL,
  exchange_token   BIGINT UNSIGNED DEFAULT NULL,
  tradingsymbol    VARCHAR(80)  NOT NULL,
  name             VARCHAR(120) DEFAULT NULL,
  expiry           DATE         DEFAULT NULL,
  strike           DECIMAL(14,4) NOT NULL DEFAULT 0,
  tick_size        DECIMAL(10,4) NOT NULL DEFAULT 0.05,
  lot_size         INT UNSIGNED  NOT NULL DEFAULT 0,
  instrument_type  VARCHAR(10)   NOT NULL,   -- CE | PE | FUT | EQ
  segment          VARCHAR(30)   NOT NULL,
  exchange         VARCHAR(10)   NOT NULL,
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (instrument_token),

  -- The chain builder's only real query shape: "give me every contract for
  -- this underlying and expiry". Without this composite index that is a full
  -- scan of ~100k rows.
  INDEX idx_instr_chain (name, expiry, strike),
  INDEX idx_instr_symbol (tradingsymbol),
  INDEX idx_instr_exchange_type (exchange, instrument_type),
  INDEX idx_instr_expiry (expiry)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- INSTRUMENT REFRESH LOG
-- So the admin panel can answer "when was the master last downloaded?"
-- without guessing from row timestamps.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS instrument_refresh_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  refreshed_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  instrument_count INT UNSIGNED NOT NULL DEFAULT 0,
  status           ENUM('success','failed') NOT NULL DEFAULT 'success',
  error_message    VARCHAR(500) DEFAULT NULL,
  INDEX idx_refresh_time (refreshed_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- OAUTH STATES
--
-- THIS TABLE IS THE FIX FOR "Invalid or expired OAuth state."
--
-- zerodhaController held pending states in a module-level `Map`. The OAuth
-- round trip takes 20-60 seconds (you leave the app, log into Kite, approve,
-- come back). Anything that restarts the Node process inside that window
-- empties the Map, so the callback arrives with a state the server has no
-- record of and is rejected.
--
-- Under nodemon that is guaranteed, not occasional: saving any file while the
-- Kite login tab is open wipes the state. It also breaks under pm2 cluster
-- mode or any second instance, because the callback can land on a different
-- process than the one that issued the state.
--
-- Persisting the nonce makes the flow survive restarts and multiple workers.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_states (
  state         VARCHAR(64) NOT NULL,
  admin_user_id BIGINT UNSIGNED NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at    DATETIME NOT NULL,
  consumed_at   DATETIME DEFAULT NULL,
  PRIMARY KEY (state),
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_oauth_expiry (expires_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- APP SETTINGS
-- Small key/value store so the admin panel can change the strike window,
-- push interval and risk-free rate without an .env edit + restart.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   VARCHAR(80) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(500) NOT NULL,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('option_strike_window',   '20'),
  ('chain_push_interval_ms', '1000'),
  ('risk_free_rate',         '0.065')
ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key);

-- ---------------------------------------------------
-- ZERODHA SESSIONS — additive columns.
--
-- Your brief asks to store login_time and public_token explicitly.
-- public_token and generated_at already exist in schema.sql; these add the
-- refresh bookkeeping and give status queries an index to use instead of
-- filesorting every row.
--
-- Guarded because MySQL < 8.0.29 has no `ADD COLUMN IF NOT EXISTS`, so a
-- second run would otherwise abort the whole migration.
-- ---------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'zerodha_sessions'
             AND COLUMN_NAME = 'last_verified_at');
SET @s := IF(@c = 0,
  'ALTER TABLE zerodha_sessions ADD COLUMN last_verified_at DATETIME DEFAULT NULL',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'zerodha_sessions'
             AND INDEX_NAME = 'idx_zsession_active');
SET @s := IF(@c = 0,
  'CREATE INDEX idx_zsession_active ON zerodha_sessions (is_active, generated_at)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;
