-- =====================================================
-- Vega Analysis — Day-Open baseline + per-minute differences
-- Faithful to the PHP addvega.php storage model, adapted for a DYNAMIC strike
-- set (recomputed each minute). Applied by `npm run db:migrate`.
--
-- The day-open baseline now stores the FULL per-strike chain (open_chain),
-- because a dynamic strike set must be re-summed against the morning chain
-- every minute. The per-minute table adds open_call_vega / open_put_vega so a
-- past day can show the (moving) day-open reference without the open chain.
-- =====================================================

USE vega_analysis;

-- Derived tables only — safe to drop & recreate; they re-fill from live ticks.

-- ---------------------------------------------------
-- VEGA DAY OPEN — the 09:16 snapshot, frozen for the session.
-- open_chain: JSON array of { strike, call:{vega,theta,gamma,delta,iv}, put:{...} }
-- call_strikes / put_strikes: the strike lists eligible AT OPEN (used only by
--   STRIKE_MODE='frozen'; dynamic mode recomputes them from open_chain).
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS vega_day_open (
  snapshot_date DATE        NOT NULL,
  symbol        VARCHAR(20) NOT NULL,
  expiry        DATE        NOT NULL,
  captured_at   DATETIME    NOT NULL,

  open_chain    JSON        NOT NULL,
  call_strikes  JSON        DEFAULT NULL,
  put_strikes   JSON        DEFAULT NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- One immutable baseline per symbol/EXPIRY/day. Expiry is part of the key
  -- because the recorder now tracks several expiries side by side and each one
  -- has its own 09:15 chain — sharing a key would let the next weekly overwrite
  -- the current weekly's baseline.
  PRIMARY KEY (snapshot_date, symbol, expiry)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- VEGA TIMESERIES — the vega_chart INSERT, every minute.
--   call_vega_diff = CurrentCallVega - DayOpenCallVega   (PHP diff1)
--   put_vega_diff  = CurrentPutVega  - DayOpenPutVega    (PHP diff2)
--   vega_diff      = put_vega_diff   - call_vega_diff     (PHP diff3)
-- Absolute current + day-open totals are kept so the UI can show raw numbers.
-- Trend (Bullish/Bearish/Sideways) is derived on read from the two diffs.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS vega_timeseries (
  snapshot_date     DATE          NOT NULL,
  symbol            VARCHAR(20)   NOT NULL,
  sampled_at        DATETIME      NOT NULL,
  expiry            DATE          NOT NULL,

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

  -- Expiry joins the key so the same minute can hold one row per tracked
  -- expiry. Without it the second expiry sampled in a minute would collide with
  -- the first and be silently overwritten by the ON DUPLICATE KEY UPDATE.
  PRIMARY KEY (snapshot_date, symbol, expiry, sampled_at),
  INDEX idx_vega_series (symbol, snapshot_date, expiry, sampled_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- VEGA CHAIN SNAPSHOTS — OPTIONAL raw per-minute chain archive (parity item 5).
-- Only written when VEGA_STORE_RAW_CHAINS=true. Created unconditionally so the
-- feature can be toggled on without a re-migrate. Enables historical replay /
-- recompute, like the PHP market_open table.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS vega_chain_snapshots (
  snapshot_date DATE        NOT NULL,
  symbol        VARCHAR(20) NOT NULL,
  sampled_at    DATETIME    NOT NULL,
  expiry        DATE        NOT NULL,
  chain         JSON        NOT NULL,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, symbol, expiry, sampled_at),
  INDEX idx_chain_snap (symbol, snapshot_date, expiry, sampled_at)
) ENGINE=InnoDB;

-- ===================================================================
-- EXPIRY-WISE UPGRADE for databases created before expiry joined the
-- primary keys above.
--
-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
-- an installation that has been recording since before this change still has
-- PRIMARY KEY (snapshot_date, symbol[, sampled_at]) and a nullable `expiry`.
-- On that schema the second expiry sampled in a minute collides with the first
-- and is overwritten, which is exactly the bug the new key prevents.
--
-- Every statement below is guarded by information_schema and is a no-op on a
-- database that is already on the new shape (including a fresh install, where
-- the CREATE TABLE above has just built it correctly), so `npm run db:migrate`
-- stays safe to run on every boot.
--
-- The UPDATEs only touch rows whose expiry is NULL. Such a row cannot be
-- attributed to an expiry at all and is unusable on the expiry-wise read path;
-- stamping it with its own snapshot_date keeps the row (nothing is deleted)
-- while letting the column become NOT NULL.
-- ===================================================================

UPDATE vega_day_open        SET expiry = snapshot_date WHERE expiry IS NULL;
UPDATE vega_timeseries      SET expiry = snapshot_date WHERE expiry IS NULL;
UPDATE vega_chain_snapshots SET expiry = snapshot_date WHERE expiry IS NULL;

-- vega_day_open: (snapshot_date, symbol) -> (snapshot_date, symbol, expiry)
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'vega_day_open'
             AND INDEX_NAME = 'PRIMARY'
             AND COLUMN_NAME = 'expiry');
SET @s := IF(@c = 0,
  'ALTER TABLE vega_day_open
     MODIFY expiry DATE NOT NULL,
     DROP PRIMARY KEY,
     ADD PRIMARY KEY (snapshot_date, symbol, expiry)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- vega_timeseries: (snapshot_date, symbol, sampled_at)
--               -> (snapshot_date, symbol, expiry, sampled_at)
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'vega_timeseries'
             AND INDEX_NAME = 'PRIMARY'
             AND COLUMN_NAME = 'expiry');
SET @s := IF(@c = 0,
  'ALTER TABLE vega_timeseries
     MODIFY expiry DATE NOT NULL,
     DROP PRIMARY KEY,
     ADD PRIMARY KEY (snapshot_date, symbol, expiry, sampled_at)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- The read index has to lead with expiry too, or every expiry-filtered series
-- read falls back to scanning the whole day for the symbol.
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'vega_timeseries'
             AND INDEX_NAME = 'idx_vega_series'
             AND COLUMN_NAME = 'expiry');
SET @s := IF(@c = 0,
  'ALTER TABLE vega_timeseries
     DROP INDEX idx_vega_series,
     ADD INDEX idx_vega_series (symbol, snapshot_date, expiry, sampled_at)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- vega_chain_snapshots (optional archive, same treatment for consistency).
SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'vega_chain_snapshots'
             AND INDEX_NAME = 'PRIMARY'
             AND COLUMN_NAME = 'expiry');
SET @s := IF(@c = 0,
  'ALTER TABLE vega_chain_snapshots
     MODIFY expiry DATE NOT NULL,
     DROP PRIMARY KEY,
     ADD PRIMARY KEY (snapshot_date, symbol, expiry, sampled_at)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'vega_chain_snapshots'
             AND INDEX_NAME = 'idx_chain_snap'
             AND COLUMN_NAME = 'expiry');
SET @s := IF(@c = 0,
  'ALTER TABLE vega_chain_snapshots
     DROP INDEX idx_chain_snap,
     ADD INDEX idx_chain_snap (symbol, snapshot_date, expiry, sampled_at)',
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;