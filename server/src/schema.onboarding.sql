-- =====================================================
-- Vega Analysis — Onboarding funnel
--
-- Registration is now TWO steps. Step 1 creates the account; step 2 records
-- which route to access the user chose, hands their details to the admin over
-- WhatsApp, and raises an admin notification.
--
-- Additive only. Nothing existing is dropped or altered — `users.broker` was
-- already NULLable, which is exactly what step 1 needs now that the broker is
-- no longer collected on the form.
--
-- Applied by `npm run db:migrate` (and on every boot via config/migrate.js).
-- =====================================================

USE vega_analysis;

-- ---------------------------------------------------
-- USER ONBOARDING — one row per registered user.
--
-- ONE ROW PER USER, not per selection: the funnel state IS the row, and a user
-- who changes their mind updates it rather than creating a second, contradictory
-- record for the admin to reconcile. UNIQUE KEY on user_id enforces that.
--
-- WHY selected_option AND payment_intent AND broker_choice.
-- They are not redundant. `selected_option` is what the user clicked — one
-- value, always present once step 2 completes, and the only thing the WhatsApp
-- message quotes. The other two are the CONSEQUENCE of that click, split apart
-- because they drive different admin workflows and different follow-up states:
-- a lifetime buyer needs payment chased, a broker lead needs an account opening
-- confirmed. Deriving them on read would put that mapping in every query.
--
-- The three status columns start at 'none' rather than NULL so a filtered admin
-- query never has to write `IS NULL OR = 'x'`.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS user_onboarding (
  id                  BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id             BIGINT UNSIGNED NOT NULL,
  registration_source VARCHAR(40) NOT NULL DEFAULT 'web',

  -- What the user chose in step 2. NULL until they choose.
  selected_option     ENUM('lifetime','dhan','angel_one') DEFAULT NULL,
  payment_intent      ENUM('lifetime')                    DEFAULT NULL,
  broker_choice       ENUM('dhan','angel_one')            DEFAULT NULL,
  price_inr           DECIMAL(10,2)                       DEFAULT NULL,
  selected_at         DATETIME                            DEFAULT NULL,

  -- Funnel state the admin drives.
  whatsapp_status     ENUM('not_sent','opened','confirmed') NOT NULL DEFAULT 'not_sent',
  whatsapp_opened_at  DATETIME DEFAULT NULL,
  payment_status      ENUM('none','pending','received')     NOT NULL DEFAULT 'none',
  payment_received_at DATETIME DEFAULT NULL,
  broker_status       ENUM('none','pending','completed')    NOT NULL DEFAULT 'none',
  broker_completed_at DATETIME DEFAULT NULL,

  contacted_at        DATETIME DEFAULT NULL,
  activated_at        DATETIME DEFAULT NULL,
  admin_note          VARCHAR(500) DEFAULT NULL,
  handled_by          BIGINT UNSIGNED DEFAULT NULL,

  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  UNIQUE KEY uq_onboarding_user (user_id),
  FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
  -- SET NULL, not CASCADE: deleting the admin who handled a lead must not
  -- delete the lead.
  FOREIGN KEY (handled_by) REFERENCES users(id) ON DELETE SET NULL,

  INDEX idx_onb_option  (selected_option),
  INDEX idx_onb_payment (payment_status),
  INDEX idx_onb_broker  (broker_status),
  INDEX idx_onb_created (created_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- ADMIN NOTIFICATIONS
--
-- Deliberately generic (`type` + `payload`) rather than an onboarding-specific
-- table: the first consumer is the onboarding funnel, but the admin console
-- already has several things worth surfacing this way (session expiry, feed
-- down, recorder truncation) and none of them warrant their own table.
-- ---------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_notifications (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  type       VARCHAR(40)  NOT NULL,          -- e.g. 'onboarding.selected'
  title      VARCHAR(160) NOT NULL,
  body       VARCHAR(600) DEFAULT NULL,
  user_id    BIGINT UNSIGNED DEFAULT NULL,
  payload    JSON DEFAULT NULL,
  is_read    TINYINT(1) NOT NULL DEFAULT 0,
  read_at    DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_notif_unread (is_read, created_at),
  INDEX idx_notif_type   (type)
) ENGINE=InnoDB;

-- ---------------------------------------------------
-- BACKFILL — every existing non-admin account gets a row.
--
-- Without this the admin Onboarding tab would be blind to every account created
-- before this table existed, which is the entire current user base. They are
-- marked 'legacy' so they are distinguishable from real funnel entries, and
-- their selected_option stays NULL because nobody ever asked them.
--
-- INSERT IGNORE + the UNIQUE KEY makes this idempotent, which it must be:
-- migrate.run() re-applies this file on every boot.
-- ---------------------------------------------------
INSERT IGNORE INTO user_onboarding (user_id, registration_source, created_at)
SELECT id, 'legacy', created_at FROM users WHERE role <> 'admin';

-- An account that is already approved has, by definition, finished the funnel.
-- Marking it activated keeps the admin's "needs action" filter honest instead of
-- showing every long-standing user as an outstanding lead.
UPDATE user_onboarding uo
  JOIN users u ON u.id = uo.user_id
   SET uo.activated_at = COALESCE(uo.activated_at, u.created_at)
 WHERE uo.registration_source = 'legacy'
   AND u.status = 'approved'
   AND uo.activated_at IS NULL;
