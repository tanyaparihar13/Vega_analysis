'use strict';

const db = require('../config/db');
const auditLogService = require('../services/auditLogService');
const notificationService = require('../services/notificationService');

/**
 * Admin view of the registration funnel.
 *
 * Every state change goes through ONE endpoint with an `action`, rather than
 * seven endpoints that differ only in which column they set. That keeps the
 * audit-log call, the guard rails and the response shape in a single place —
 * seven near-identical handlers is how one of them quietly stops writing an
 * audit entry.
 */

/**
 * The transitions an admin can drive, and what each one writes.
 *
 * `activate` is the only one that touches `users`, because it is the only one
 * that grants access. Everything else is funnel bookkeeping and must NOT change
 * what the user can do — an admin marking a payment received has not yet decided
 * to let them in, and conflating the two would approve accounts by accident.
 */
const ACTIONS = {
  contacted: {
    label: 'marked as contacted',
    sql: 'contacted_at = NOW()',
  },
  payment_received: {
    label: 'payment marked received',
    sql: "payment_status = 'received', payment_received_at = NOW()",
  },
  reset_payment: {
    label: 'payment reset to pending',
    sql: "payment_status = 'pending', payment_received_at = NULL",
  },
  dhan_completed: {
    label: 'Dhan account marked complete',
    sql: "broker_status = 'completed', broker_completed_at = NOW()",
  },
  angel_completed: {
    label: 'Angel One account marked complete',
    sql: "broker_status = 'completed', broker_completed_at = NOW()",
  },
  reset_broker: {
    label: 'broker reset to pending',
    sql: "broker_status = 'pending', broker_completed_at = NULL",
  },
  whatsapp_confirmed: {
    label: 'WhatsApp message confirmed received',
    sql: "whatsapp_status = 'confirmed'",
  },
  activate: {
    label: 'account activated',
    sql: 'activated_at = NOW()',
    activatesUser: true,
  },
};

const SELECT_ROW = `
  SELECT o.*,
         u.name, u.email, u.phone, u.role, u.status AS user_status,
         u.is_active, u.broker, u.created_at AS registered_at, u.last_login_at,
         h.name AS handled_by_name
    FROM user_onboarding o
    JOIN users u  ON u.id = o.user_id
    LEFT JOIN users h ON h.id = o.handled_by`;

/**
 * GET /api/admin/onboarding
 *   ?option=lifetime|dhan|angel_one
 *   &payment=none|pending|received
 *   &broker=none|pending|completed
 *   &status=pending|approved|rejected|blocked      (the USER's approval status)
 *   &pending=1                                     (needs action: not activated)
 *   &page=&pageSize=
 *
 * Every filter is whitelisted and bound — none of them is interpolated.
 */
async function listOnboarding(req, res) {
  try {
    const { option, payment, broker, status, pending, page, pageSize } = req.query;

    const where = [];
    const params = {};

    if (option && ['lifetime', 'dhan', 'angel_one'].includes(option)) {
      where.push('o.selected_option = :option'); params.option = option;
    }
    if (payment && ['none', 'pending', 'received'].includes(payment)) {
      where.push('o.payment_status = :payment'); params.payment = payment;
    }
    if (broker && ['none', 'pending', 'completed'].includes(broker)) {
      where.push('o.broker_status = :broker'); params.broker = broker;
    }
    if (status && ['pending', 'approved', 'rejected', 'blocked'].includes(status)) {
      where.push('u.status = :status'); params.status = status;
    }
    // "Needs action": chose something, not yet activated. This is the queue the
    // admin actually works from, so it is a first-class filter rather than
    // something they have to reconstruct from three dropdowns.
    if (pending === '1' || pending === 'true') {
      where.push('o.activated_at IS NULL AND o.selected_option IS NOT NULL');
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const [[{ total }]] = await db.query(
      `SELECT COUNT(*) AS total FROM user_onboarding o JOIN users u ON u.id = o.user_id ${whereSql}`,
      params
    );

    const [rows] = await db.query(
      `${SELECT_ROW} ${whereSql} ORDER BY o.created_at DESC LIMIT :limit OFFSET :offset`,
      { ...params, limit, offset }
    );

    // Tab badges, in the same round trip.
    const [[counts]] = await db.query(
      `SELECT
         COUNT(*)                                                   AS total,
         SUM(o.selected_option = 'lifetime')                        AS lifetime,
         SUM(o.selected_option = 'dhan')                            AS dhan,
         SUM(o.selected_option = 'angel_one')                       AS angel_one,
         SUM(o.selected_option IS NULL)                             AS undecided,
         SUM(o.payment_status = 'pending')                          AS payment_pending,
         SUM(o.payment_status = 'received')                         AS payment_received,
         SUM(o.broker_status  = 'pending')                          AS broker_pending,
         SUM(o.broker_status  = 'completed')                        AS broker_completed,
         SUM(o.activated_at IS NULL AND o.selected_option IS NOT NULL) AS needs_action
       FROM user_onboarding o`
    );

    const n = (v) => Number(v || 0);
    res.json({
      onboarding: rows,
      total: Number(total),
      page: Math.max(Number(page) || 1, 1),
      pageSize: limit,
      counts: {
        total: n(counts.total),
        lifetime: n(counts.lifetime),
        dhan: n(counts.dhan),
        angel_one: n(counts.angel_one),
        undecided: n(counts.undecided),
        paymentPending: n(counts.payment_pending),
        paymentReceived: n(counts.payment_received),
        brokerPending: n(counts.broker_pending),
        brokerCompleted: n(counts.broker_completed),
        needsAction: n(counts.needs_action),
      },
    });
  } catch (err) {
    console.error('[admin/onboarding] error:', err.message);
    res.status(500).json({ message: 'Failed to load the onboarding queue' });
  }
}

/**
 * PATCH /api/admin/onboarding/:userId   { action, note? }
 */
async function updateOnboarding(req, res) {
  try {
    const { userId } = req.params;
    const { action, note } = req.body;

    const spec = ACTIONS[action];
    if (!spec) {
      return res.status(400).json({ message: `action must be one of: ${Object.keys(ACTIONS).join(', ')}` });
    }

    const [[target]] = await db.query(
      'SELECT u.id, u.role, u.status, u.email FROM users u WHERE u.id = :userId',
      { userId }
    );
    if (!target) return res.status(404).json({ message: 'User not found' });

    // Same guard rail as adminController.setUserApproval — an admin account's
    // status is not something the funnel gets to touch.
    if (spec.activatesUser && target.role === 'admin') {
      return res.status(400).json({ message: 'Admin accounts are not part of the onboarding funnel.' });
    }

    // `spec.sql` is a constant from the ACTIONS table above — never user input.
    // `note` and `userId` are bound.
    await db.query(
      `UPDATE user_onboarding
          SET ${spec.sql},
              handled_by = :adminId
              ${note != null ? ', admin_note = :note' : ''}
        WHERE user_id = :userId`,
      { userId, adminId: req.user.id, ...(note != null ? { note: String(note).slice(0, 500) } : {}) }
    );

    if (spec.activatesUser) {
      await db.query("UPDATE users SET status = 'approved' WHERE id = :userId", { userId });
    }

    await auditLogService.record({
      adminUserId: req.user.id,
      action: `onboarding.${action}`,
      targetType: 'user',
      targetId: userId,
      details: { from: target.status, email: target.email, note: note || null },
      ip: req.ip,
    });

    const [rows] = await db.query(`${SELECT_ROW} WHERE o.user_id = :userId`, { userId });

    res.json({
      message: `User ${spec.label}`,
      userId: Number(userId),
      action,
      row: rows[0] || null,
    });
  } catch (err) {
    console.error('[admin/onboarding/update] error:', err.message);
    res.status(500).json({ message: 'Failed to update the onboarding record' });
  }
}

/** GET /api/admin/notifications?unread=1 */
async function listNotifications(req, res) {
  try {
    const unreadOnly = req.query.unread === '1' || req.query.unread === 'true';
    res.json(await notificationService.list({ unreadOnly, limit: req.query.limit }));
  } catch (err) {
    console.error('[admin/notifications] error:', err.message);
    res.status(500).json({ message: 'Failed to load notifications' });
  }
}

/** PATCH /api/admin/notifications/:id/read */
async function readNotification(req, res) {
  try {
    const ok = await notificationService.markRead(req.params.id);
    res.json({ ok, id: Number(req.params.id) });
  } catch (err) {
    console.error('[admin/notifications/read] error:', err.message);
    res.status(500).json({ message: 'Failed to update the notification' });
  }
}

/** POST /api/admin/notifications/read-all */
async function readAllNotifications(req, res) {
  try {
    res.json({ ok: true, updated: await notificationService.markAllRead() });
  } catch (err) {
    console.error('[admin/notifications/read-all] error:', err.message);
    res.status(500).json({ message: 'Failed to update notifications' });
  }
}

module.exports = {
  listOnboarding,
  updateOnboarding,
  listNotifications,
  readNotification,
  readAllNotifications,
  ACTIONS,
};
