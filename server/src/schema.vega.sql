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
  expiry        DATE        DEFAULT NULL,
  captured_at   DATETIME    NOT NULL,

  open_chain    JSON        NOT NULL,
  call_strikes  JSON        DEFAULT NULL,
  put_strikes   JSON        DEFAULT NULL,

  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (snapshot_date, symbol)      -- one immutable baseline per symbol/day
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
  expiry        DATE        DEFAULT NULL,
  chain         JSON        NOT NULL,
  created_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (snapshot_date, symbol, sampled_at),
  INDEX idx_chain_snap (symbol, snapshot_date, sampled_at)
) ENGINE=InnoDB;