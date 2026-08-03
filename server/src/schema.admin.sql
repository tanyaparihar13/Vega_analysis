-- =====================================================
-- Admin audit log — records destructive/administrative actions
-- (user status/role changes, subscription assignment, data purge, backups).
-- "User activity" is intentionally NOT duplicated here — it's served from the
-- existing `login_history` table (see adminController.loginHistory).
-- =====================================================

USE vega_analysis;

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  admin_user_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(60) NOT NULL,        -- e.g. 'user.activate', 'data.purge', 'data.backup'
  target_type VARCHAR(40) DEFAULT NULL,
  target_id VARCHAR(60) DEFAULT NULL,
  details JSON DEFAULT NULL,
  ip_address VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_audit_admin (admin_user_id),
  INDEX idx_audit_action (action),
  INDEX idx_audit_time (created_at)
) ENGINE=InnoDB;
