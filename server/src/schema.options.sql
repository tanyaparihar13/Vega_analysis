-- =====================================================
-- Vega Analysis — Option Chain additions
-- Run AFTER schema.sql:
--   mysql -u root -p vega_analysis < server/src/schema.options.sql
-- Additive only. Nothing existing is dropped or altered.
-- =====================================================

USE vega_analysis;

-- ---------------------------------------------------
-- OI BASELINE
-- Yesterday's CLOSING open interest per contract.
-- A Kite tick carries absolute `oi` only, never a delta, so "OI Change"
-- is impossible without this table. Populate it just after 15:30 IST.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS oi_baseline (
  snapshot_date DATE NOT NULL,
  instrument_token BIGINT UNSIGNED NOT NULL,
  close_oi BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, instrument_token),
  INDEX idx_oi_token (instrument_token),
  INDEX idx_oi_date (snapshot_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- IV HISTORY
-- Daily ATM implied volatility per underlying. IV Percentile is a ranking
-- against this series — it cannot be computed from a single day's data.
-- Expect NULL in the UI until ~20 trading days are banked.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS iv_history (
  snapshot_date DATE NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  atm_iv DECIMAL(8,4) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, symbol),
  INDEX idx_iv_symbol (symbol, snapshot_date)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- Retention: neither table needs unbounded growth.
-- oi_baseline only ever reads the newest row set; iv_history reads ~252 days.
-- Run these monthly, or wire them into the existing node-cron schedule.
-- ---------------------------------------------------
-- DELETE FROM oi_baseline WHERE snapshot_date < CURDATE() - INTERVAL 7 DAY;
-- DELETE FROM iv_history  WHERE snapshot_date < CURDATE() - INTERVAL 3 YEAR;
