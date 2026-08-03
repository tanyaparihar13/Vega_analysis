const jwt = require('jsonwebtoken');
require('dotenv').config();

/**
 * Verifies the JWT from the Authorization header and attaches the
 * decoded payload (id, role, email) to req.user.
 */
function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ message: 'Authentication token missing' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // { id, email, role }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

/**
 * Restricts a route to one or more roles.
 * Usage: authorize('admin') or authorize('admin', 'premium')
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Insufficient permissions for this resource' });
    }
    next();
  };
}

/**
 * Does this token grant access to the product's market data?
 *
 * ------------------------------------------------------------------------
 * ACCESS IS GRANTED BY ADMIN APPROVAL, NOT BY TIER.
 * ------------------------------------------------------------------------
 * Registration creates users with status='pending' and role='free'. An admin
 * then approves them. Previously this check only accepted role
 * 'premium'/'admin', so an approved user logged in successfully and was then
 * refused by every endpoint that matters — option chain, Greeks, Vega — plus
 * the WebSocket upgrade. Approval granted a login and nothing else.
 *
 * The rule is therefore: approved (or admin) gets in.
 *
 * BACKWARD COMPATIBILITY: tokens minted before `status` was added to the JWT
 * payload have no status field. Rather than hard-invalidating every live
 * session, those fall back to the old role test. New logins carry status and
 * take the new path.
 *
 * Shared with services/websocketService.js so the HTTP and WebSocket gates can
 * never drift apart.
 */
function hasMarketAccess(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;

  // New-style token: approval decides.
  if (user.status) return user.status === 'approved';

  // Legacy token (pre-status): fall back to the previous tier check.
  return user.role === 'premium';
}

/**
 * Gates premium-only data (full option chain, Greeks, Vega Analysis, the
 * real-time feed). Name kept for compatibility with existing route wiring.
 */
function requirePremium(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Not authenticated' });
  if (hasMarketAccess(req.user)) return next();

  // A pending/blocked user should be told what is actually wrong rather than
  // being told to upgrade a plan that has nothing to do with it.
  const message = req.user.status === 'pending'
    ? 'Your account is awaiting administrator approval.'
    : req.user.status === 'blocked'
      ? 'This account has been blocked. Please contact the administrator.'
      : req.user.status === 'rejected'
        ? 'Your registration was not approved. Please contact the administrator.'
        : 'Your account does not have access to live market data. Please contact the administrator.';

  return res.status(403).json({ message, status: req.user.status ?? null });
}

module.exports = { authenticate, authorize, requirePremium, hasMarketAccess };
