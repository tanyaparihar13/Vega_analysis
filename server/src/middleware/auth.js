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

    /**
     * SCOPED TOKENS ARE NOT SESSIONS.
     *
     * The onboarding step issues a JWT signed with the SAME secret (see
     * authController.signOnboardingToken) so that a brand-new account — which is
     * status='pending' and therefore cannot log in — can still identify itself
     * for exactly one purpose. That token carries `scope: 'onboarding'`.
     *
     * Without this check that token would be a valid session everywhere, because
     * jwt.verify() only proves the signature. It would let anyone who registers
     * skip the approval gate entirely. Rejecting ANY token that carries a scope
     * claim — not just 'onboarding' — means a future scoped token is safe by
     * default rather than safe only if someone remembers to add it here.
     */
    if (decoded.scope) {
      return res.status(401).json({ message: 'This token cannot be used to access the API' });
    }

    req.user = decoded; // { id, email, role, status }
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
}

/**
 * Authenticates the short-lived token handed out by POST /api/auth/register.
 *
 * The problem this solves: a freshly registered account is 'pending' and cannot
 * authenticate, so the onboarding page has no session — but it still has to
 * write a choice against exactly one user. Taking a `userId` from the request
 * body instead would let anyone set any user's selection and spam admin
 * notifications on their behalf.
 *
 * The token proves "the bearer just completed registration as user N" and
 * nothing else: it carries no role, expires in 30 minutes, and is rejected by
 * `authenticate` above.
 */
function authenticateOnboarding(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      message: 'Your onboarding session has expired. Please sign in once your account is approved.',
      code: 'ONBOARDING_TOKEN_MISSING',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.scope !== 'onboarding' || !decoded.id) {
      return res.status(401).json({ message: 'Invalid onboarding token', code: 'ONBOARDING_TOKEN_INVALID' });
    }
    req.onboarding = { userId: decoded.id };
    next();
  } catch (err) {
    return res.status(401).json({
      message: 'Your onboarding session has expired. Please contact the administrator on WhatsApp.',
      code: 'ONBOARDING_TOKEN_EXPIRED',
    });
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

module.exports = {
  authenticate, authorize, requirePremium, hasMarketAccess, authenticateOnboarding,
};
