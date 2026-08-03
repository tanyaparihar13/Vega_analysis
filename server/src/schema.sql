-- =====================================================
-- Vega Analysis - MySQL Schema
-- =====================================================

CREATE DATABASE IF NOT EXISTS vega_analysis
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE vega_analysis;

-- ---------------------------------------------------
-- USERS
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(160) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'premium', 'free') NOT NULL DEFAULT 'free',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  phone VARCHAR(20) DEFAULT NULL,
  last_login_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_active (is_active),
  INDEX idx_users_email (email)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- USERS.STATUS — admin approval workflow.
--
-- New signups land as 'pending' and CANNOT log in until an admin approves
-- them (see authController.login / adminController).
--
-- Guarded + backfilled, because this file re-runs on every boot:
--   * the column is added only once (MySQL < 8.0.29 has no
--     ADD COLUMN IF NOT EXISTS, and an unguarded ALTER would abort the rest
--     of this migration on the second run)
--   * EVERY pre-existing row is set to 'approved' in the same step. The
--     column defaults to 'pending', so without that backfill the very first
--     boot after this change would lock out every existing account —
--     including the admin.
-- ---------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'users'
             AND COLUMN_NAME = 'status');
SET @s := IF(@c = 0,
  "ALTER TABLE users ADD COLUMN status ENUM('pending','approved','rejected','blocked') NOT NULL DEFAULT 'pending' AFTER is_active",
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill runs only on the migration that created the column.
SET @s := IF(@c = 0, "UPDATE users SET status = 'approved'", 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @c := (SELECT COUNT(*) FROM information_schema.STATISTICS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'users'
             AND INDEX_NAME = 'idx_users_status');
SET @s := IF(@c = 0, 'CREATE INDEX idx_users_status ON users (status)', 'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- An admin must never be able to lock themselves out by approving nobody.
UPDATE users SET status = 'approved' WHERE role = 'admin' AND status <> 'approved';

-- ---------------------------------------------------
-- USERS.BROKER — which demat broker the user signed up with.
--
-- Collected on the public registration form and shown to the admin in the
-- approval queue, so the person approving knows who they are dealing with
-- before they act on the WhatsApp message.
--
-- NULLABLE ON PURPOSE. Every account created before this column existed has no
-- broker on record, and NULL says exactly that. A NOT NULL column with a
-- default would invent a broker for all of them — a wrong value the admin
-- would have no way to distinguish from a real one.
--
-- ENUM rather than VARCHAR to match how this schema models every other closed
-- set (role, status, plans.tier, subscriptions.status). The trade-off is that
-- supporting another broker later needs a migration here AND a matching change
-- to BROKERS in controllers/authController.js — the two lists must agree.
--
-- Guarded the same way as `status` above, because migrate.run() re-applies this
-- file on every boot and MySQL < 8.0.29 has no ADD COLUMN IF NOT EXISTS.
-- ---------------------------------------------------
SET @c := (SELECT COUNT(*) FROM information_schema.COLUMNS
           WHERE TABLE_SCHEMA = DATABASE()
             AND TABLE_NAME = 'users'
             AND COLUMN_NAME = 'broker');
SET @s := IF(@c = 0,
  "ALTER TABLE users ADD COLUMN broker ENUM('zerodha','angelone','dhan','upstox','groww') DEFAULT NULL AFTER phone",
  'SELECT 1');
PREPARE stmt FROM @s; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- ---------------------------------------------------
-- PLANS (subscription plan catalog, managed by admin)
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS plans (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  tier ENUM('free', 'premium') NOT NULL DEFAULT 'premium',
  price_inr DECIMAL(10,2) NOT NULL DEFAULT 0,
  duration_days INT UNSIGNED NOT NULL DEFAULT 30,
  features JSON DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- SUBSCRIPTIONS (per-user, links to a plan)
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  plan_id INT UNSIGNED NOT NULL,
  status ENUM('active', 'expired', 'cancelled') NOT NULL DEFAULT 'active',
  starts_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ends_at DATETIME NOT NULL,
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT,
  INDEX idx_sub_user (user_id),
  INDEX idx_sub_status (status),
  INDEX idx_sub_ends (ends_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- LOGIN HISTORY (for admin "view login history" + live activity)
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  ip_address VARCHAR(64) DEFAULT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  logout_at DATETIME DEFAULT NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_login_user (user_id),
  INDEX idx_login_time (login_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- WATCHLISTS
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS watchlists (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL DEFAULT 'My Watchlist',
  symbols JSON NOT NULL,  -- e.g. ["NIFTY 50", "RELIANCE", "NIFTY24JUL22000CE"]
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_watchlist_user (user_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- STRATEGIES (saved option strategies / analytics snapshots)
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS strategies (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  underlying VARCHAR(40) NOT NULL,        -- NIFTY, BANKNIFTY, etc.
  expiry DATE NOT NULL,
  legs JSON NOT NULL,                     -- array of {strike, type, action, qty}
  pcr DECIMAL(6,3) DEFAULT NULL,
  max_pain DECIMAL(10,2) DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_strategy_user (user_id),
  INDEX idx_strategy_underlying (underlying, expiry)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- ALERTS
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS alerts (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(60) NOT NULL,
  condition_type ENUM('price_above', 'price_below', 'vega_expansion', 'vega_contraction', 'oi_change') NOT NULL,
  target_value DECIMAL(14,4) NOT NULL,
  is_triggered TINYINT(1) NOT NULL DEFAULT 0,
  triggered_at DATETIME DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_alerts_user (user_id),
  INDEX idx_alerts_symbol (symbol),
  INDEX idx_alerts_active (is_active)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- ZERODHA SESSION (admin-owned Kite Connect session, encrypted token)
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS zerodha_sessions (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_user_id BIGINT UNSIGNED NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  public_token VARCHAR(255) DEFAULT NULL,
  kite_user_id VARCHAR(60) DEFAULT NULL,
  generated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- PLANS — de-duplicate + add the missing UNIQUE KEY on name.
--
-- `plans` had no unique key besides the AUTO_INCREMENT id, so the seed
-- INSERT's `ON DUPLICATE KEY UPDATE name = VALUES(name)` below could never
-- actually collide. migrate.run() runs on every server boot (index.js), and
-- nodemon restarts on every save, so every restart silently inserted three
-- more Free / Premium Monthly / Premium Yearly rows. This dedupes whatever
-- has already accumulated that way (skipping any duplicate still referenced
-- by a subscription, to avoid violating the FK), then adds the unique key so
-- the seed becomes a true upsert from here on. Wrapped in a handler so a
-- leftover conflict can never abort the rest of this migration file.
-- ---------------------------------------------------
DELETE p1 FROM plans p1
  INNER JOIN plans p2 ON p1.name = p2.name AND p1.id > p2.id
  LEFT JOIN subscriptions s ON s.plan_id = p1.id
WHERE s.id IS NULL;

DROP PROCEDURE IF EXISTS _vega_add_plans_name_unique;
CREATE PROCEDURE _vega_add_plans_name_unique()
BEGIN
  DECLARE CONTINUE HANDLER FOR SQLEXCEPTION BEGIN END;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'plans' AND INDEX_NAME = 'uq_plans_name'
  ) THEN
    ALTER TABLE plans ADD UNIQUE KEY uq_plans_name (name);
  END IF;
END;
CALL _vega_add_plans_name_unique();
DROP PROCEDURE IF EXISTS _vega_add_plans_name_unique;

-- ---------------------------------------------------
-- Seed default plans
-- ---------------------------------------------------
INSERT INTO plans (name, tier, price_inr, duration_days, features) VALUES
('Free', 'free', 0, 36500, JSON_ARRAY('Delayed market data', 'Limited watchlist')),
('Premium Monthly', 'premium', 999, 30, JSON_ARRAY('Real-time data','Full option chain','Greeks','Vega Analysis','Trading signals')),
('Premium Yearly', 'premium', 9999, 365, JSON_ARRAY('Real-time data','Full option chain','Greeks','Vega Analysis','Trading signals','Priority support'))
ON DUPLICATE KEY UPDATE name = VALUES(name);
