const db = require('../config/db');
const auditLogService = require('../services/auditLogService');

const USER_STATUSES = ['pending', 'approved', 'rejected', 'blocked'];

// GET /api/admin/users?status=pending|approved|rejected|blocked
async function listUsers(req, res) {
  const { status } = req.query;

  // `status` is validated against a whitelist and only ever reaches SQL as a
  // bound parameter — never interpolated.
  const where = status && USER_STATUSES.includes(status) ? 'WHERE status = :status' : '';

  const [rows] = await db.query(
    `SELECT id, name, email, phone, broker, role, is_active, status, last_login_at, created_at
     FROM users ${where} ORDER BY created_at DESC`,
    status ? { status } : {}
  );

  // Counts drive the Pending/Active/Blocked tab badges in one round trip.
  const [[counts]] = await db.query(
    `SELECT
       SUM(status = 'pending')  AS pending,
       SUM(status = 'approved') AS approved,
       SUM(status = 'rejected') AS rejected,
       SUM(status = 'blocked')  AS blocked,
       COUNT(*)                 AS total
     FROM users`
  );

  res.json({
    users: rows,
    counts: {
      pending: Number(counts.pending || 0),
      approved: Number(counts.approved || 0),
      rejected: Number(counts.rejected || 0),
      blocked: Number(counts.blocked || 0),
      total: Number(counts.total || 0),
    },
  });
}

/**
 * PATCH /api/admin/users/:id/approval   { status }
 * Backs Approve / Reject / Block / Unblock. One endpoint rather than four,
 * because the only thing that differs between them is the target status.
 */
async function setUserApproval(req, res) {
  const { id } = req.params;
  const { status } = req.body;

  if (!USER_STATUSES.includes(status)) {
    return res.status(400).json({ message: `status must be one of: ${USER_STATUSES.join(', ')}` });
  }

  const [[target]] = await db.query('SELECT id, role, status FROM users WHERE id = :id', { id });
  if (!target) return res.status(404).json({ message: 'User not found' });

  // Guard rails: an admin must not be able to lock the platform's own admins
  // out, or lock themselves out mid-session.
  if (String(target.id) === String(req.user.id) && status !== 'approved') {
    return res.status(400).json({ message: 'You cannot change your own account status.' });
  }
  if (target.role === 'admin' && status !== 'approved') {
    return res.status(400).json({ message: 'Admin accounts cannot be blocked or rejected.' });
  }

  await db.query('UPDATE users SET status = :status WHERE id = :id', { status, id });

  await auditLogService.record({
    adminUserId: req.user.id,
    action: `user.${status}`,
    targetType: 'user',
    targetId: id,
    details: { from: target.status, to: status },
    ip: req.ip,
  });

  res.json({ message: `User ${status}`, id: Number(id), status });
}

/** DELETE /api/admin/users/:id — permanent. */
async function deleteUser(req, res) {
  const { id } = req.params;

  const [[target]] = await db.query('SELECT id, role, email FROM users WHERE id = :id', { id });
  if (!target) return res.status(404).json({ message: 'User not found' });

  if (String(target.id) === String(req.user.id)) {
    return res.status(400).json({ message: 'You cannot delete your own account.' });
  }
  if (target.role === 'admin') {
    return res.status(400).json({ message: 'Admin accounts cannot be deleted from the panel.' });
  }

  // Audit BEFORE the delete: admin_audit_log has no FK to the deleted user
  // (target_id is a plain VARCHAR), but recording first means the entry exists
  // even if the delete then fails.
  await auditLogService.record({
    adminUserId: req.user.id,
    action: 'user.delete',
    targetType: 'user',
    targetId: id,
    details: { email: target.email },
    ip: req.ip,
  });

  // subscriptions / login_history / watchlists / alerts / strategies all
  // declare ON DELETE CASCADE, so this cleans up after itself.
  await db.query('DELETE FROM users WHERE id = :id', { id });

  res.json({ message: 'User deleted', id: Number(id) });
}

// PATCH /api/admin/users/:id/status  { is_active: 0|1 }
async function toggleUserStatus(req, res) {
  const { id } = req.params;
  const { is_active } = req.body;
  await db.query('UPDATE users SET is_active = :is_active WHERE id = :id', {
    is_active: is_active ? 1 : 0,
    id,
  });
  await auditLogService.record({
    adminUserId: req.user.id,
    action: is_active ? 'user.activate' : 'user.deactivate',
    targetType: 'user',
    targetId: id,
    ip: req.ip,
  });
  res.json({ message: `User ${is_active ? 'activated' : 'deactivated'} successfully` });
}

// PATCH /api/admin/users/:id/role  { role: 'free'|'premium'|'admin' }
async function updateUserRole(req, res) {
  const { id } = req.params;
  const { role } = req.body;
  if (!['free', 'premium', 'admin'].includes(role)) {
    return res.status(400).json({ message: 'Invalid role' });
  }
  await db.query('UPDATE users SET role = :role WHERE id = :id', { role, id });
  await auditLogService.record({
    adminUserId: req.user.id,
    action: 'user.role_change',
    targetType: 'user',
    targetId: id,
    details: { role },
    ip: req.ip,
  });
  res.json({ message: 'Role updated successfully' });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/admin/login-history?userId=&dateFrom=&dateTo=&page=&pageSize=
// Doubles as the "User Activity Log" view in the admin dashboard.
async function loginHistory(req, res) {
  const { userId, dateFrom, dateTo, page, pageSize } = req.query;

  const where = [];
  const params = {};
  if (userId) { where.push('lh.user_id = :userId'); params.userId = userId; }
  if (dateFrom && DATE_RE.test(dateFrom)) { where.push('lh.login_at >= :dateFrom'); params.dateFrom = dateFrom; }
  if (dateTo && DATE_RE.test(dateTo)) { where.push('lh.login_at < DATE_ADD(:dateTo, INTERVAL 1 DAY)'); params.dateTo = dateTo; }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM login_history lh ${whereSql}`, params
  );

  const limit = Math.min(Math.max(Number(pageSize) || 200, 1), 500);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const [rows] = await db.query(
    `SELECT lh.*, u.name, u.email FROM login_history lh
     JOIN users u ON u.id = lh.user_id
     ${whereSql}
     ORDER BY lh.login_at DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );
  res.json({ history: rows, total: Number(total), page: Number(page) || 1, pageSize: limit });
}

// GET /api/admin/live-activity  (users active in the last 5 minutes)
async function liveActivity(req, res) {
  const [rows] = await db.query(
    `SELECT u.id, u.name, u.email, u.role, lh.login_at, lh.ip_address
     FROM users u
     JOIN login_history lh ON lh.user_id = u.id
     WHERE lh.login_at >= (NOW() - INTERVAL 5 MINUTE) AND lh.logout_at IS NULL
     ORDER BY lh.login_at DESC`
  );
  res.json({ activeUsers: rows });
}

// GET /api/admin/plans
async function listPlans(req, res) {
  const [rows] = await db.query('SELECT * FROM plans ORDER BY price_inr ASC');
  res.json({ plans: rows });
}

// POST /api/admin/plans
async function createPlan(req, res) {
  const { name, tier, price_inr, duration_days, features } = req.body;
  const [result] = await db.query(
    `INSERT INTO plans (name, tier, price_inr, duration_days, features)
     VALUES (:name, :tier, :price, :duration, :features)`,
    {
      name, tier, price: price_inr, duration: duration_days,
      features: JSON.stringify(features || []),
    }
  );
  await auditLogService.record({
    adminUserId: req.user.id,
    action: 'plan.create',
    targetType: 'plan',
    targetId: result.insertId,
    details: { name, tier, price_inr, duration_days },
    ip: req.ip,
  });
  res.status(201).json({ id: result.insertId, message: 'Plan created' });
}

// GET /api/admin/subscriptions
async function listSubscriptions(req, res) {
  const [rows] = await db.query(
    `SELECT s.*, u.name AS user_name, u.email, p.name AS plan_name, p.tier
     FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     JOIN plans p ON p.id = s.plan_id
     ORDER BY s.created_at DESC`
  );
  res.json({ subscriptions: rows });
}

// POST /api/admin/subscriptions  { userId, planId, durationDays }
async function assignSubscription(req, res) {
  const { userId, planId, durationDays } = req.body;
  await db.query(
    `INSERT INTO subscriptions (user_id, plan_id, status, ends_at)
     VALUES (:userId, :planId, 'active', DATE_ADD(NOW(), INTERVAL :days DAY))`,
    { userId, planId, days: durationDays || 30 }
  );
  // Promote the user's role to premium if the plan tier is premium
  const [[plan]] = await db.query('SELECT tier FROM plans WHERE id = :planId', { planId });
  if (plan && plan.tier === 'premium') {
    await db.query("UPDATE users SET role = 'premium' WHERE id = :userId", { userId });
  }
  await auditLogService.record({
    adminUserId: req.user.id,
    action: 'subscription.assign',
    targetType: 'user',
    targetId: userId,
    details: { planId, durationDays: durationDays || 30 },
    ip: req.ip,
  });
  res.status(201).json({ message: 'Subscription assigned' });
}

module.exports = {
  listUsers,
  setUserApproval,
  deleteUser,
  toggleUserStatus,
  updateUserRole,
  loginHistory,
  liveActivity,
  listPlans,
  createPlan,
  listSubscriptions,
  assignSubscription,
};
