'use strict';

const db = require('../config/db');

/**
 * record — one INSERT into admin_audit_log. Never throws into the caller's
 * request path: a failed audit write shouldn't roll back or fail the action
 * it's describing, so errors are logged and swallowed.
 */
async function record({ adminUserId, action, targetType = null, targetId = null, details = null, ip = null }) {
  try {
    await db.query(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details, ip_address)
       VALUES (:adminUserId, :action, :targetType, :targetId, :details, :ip)`,
      {
        adminUserId,
        action,
        targetType,
        targetId: targetId != null ? String(targetId) : null,
        details: details != null ? JSON.stringify(details) : null,
        ip,
      }
    );
  } catch (err) {
    console.error('[auditLogService] Failed to record audit entry:', err.message);
  }
}

// GET /api/admin/audit-log — paginated, newest first, joined to the admin's name.
async function list({ page = 1, pageSize = 50 } = {}) {
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const [rows] = await db.query(
    `SELECT a.*, u.name AS admin_name, u.email AS admin_email
     FROM admin_audit_log a
     JOIN users u ON u.id = a.admin_user_id
     ORDER BY a.created_at DESC
     LIMIT :limit OFFSET :offset`,
    { limit, offset }
  );
  const [[{ total }]] = await db.query('SELECT COUNT(*) AS total FROM admin_audit_log');

  return { rows, total: Number(total), page: Number(page) || 1, pageSize: limit };
}

module.exports = { record, list };
