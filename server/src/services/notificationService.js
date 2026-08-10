'use strict';

const db = require('../config/db');

/**
 * Admin notifications.
 *
 * Deliberately fire-and-forget on the WRITE side: `create()` swallows its own
 * errors and returns null. A notification is a convenience for the operator, and
 * failing a user's onboarding selection because a nice-to-have INSERT hit a lock
 * would be the wrong trade — the underlying state is already committed to
 * user_onboarding, which is the record that actually matters. The failure is
 * logged so it is not invisible.
 *
 * Reads do NOT swallow errors: an admin looking at an empty notification list
 * must be able to tell "nothing happened" from "the query broke".
 */

/**
 * @param {object}  n
 * @param {string}  n.type     stable machine key, e.g. 'onboarding.selected'
 * @param {string}  n.title    one line, shown in the list
 * @param {string} [n.body]    supporting detail
 * @param {number} [n.userId]  the account this concerns
 * @param {object} [n.payload] structured detail for the UI
 * @returns {Promise<number|null>} the new id, or null if it could not be stored
 */
async function create({ type, title, body = null, userId = null, payload = null }) {
  try {
    const [result] = await db.query(
      `INSERT INTO admin_notifications (type, title, body, user_id, payload)
       VALUES (:type, :title, :body, :userId, :payload)`,
      {
        type,
        title: String(title).slice(0, 160),
        body: body ? String(body).slice(0, 600) : null,
        userId,
        payload: payload ? JSON.stringify(payload) : null,
      }
    );
    return result.insertId;
  } catch (err) {
    console.error('[notifications] Could not store notification:', err.message);
    return null;
  }
}

/** Newest first. `unreadOnly` backs the badge count and the default view. */
async function list({ unreadOnly = false, limit = 50 } = {}) {
  const capped = Math.max(1, Math.min(Number(limit) || 50, 200));
  const [rows] = await db.query(
    `SELECT n.*, u.name AS user_name, u.email AS user_email
       FROM admin_notifications n
       LEFT JOIN users u ON u.id = n.user_id
      ${unreadOnly ? 'WHERE n.is_read = 0' : ''}
      ORDER BY n.created_at DESC
      LIMIT :limit`,
    { limit: capped }
  );

  const [[counts]] = await db.query(
    `SELECT COUNT(*) AS total, SUM(is_read = 0) AS unread FROM admin_notifications`
  );

  return {
    notifications: rows,
    total: Number(counts.total || 0),
    unread: Number(counts.unread || 0),
  };
}

async function markRead(id) {
  const [res] = await db.query(
    'UPDATE admin_notifications SET is_read = 1, read_at = NOW() WHERE id = :id AND is_read = 0',
    { id }
  );
  return res.affectedRows > 0;
}

async function markAllRead() {
  const [res] = await db.query(
    'UPDATE admin_notifications SET is_read = 1, read_at = NOW() WHERE is_read = 0'
  );
  return res.affectedRows;
}

module.exports = { create, list, markRead, markAllRead };
