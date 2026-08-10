const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const {
  register, login, adminLogin, me, publicConfig,
  forgotPassword, validateResetToken, resetPassword,
  onboardingOptions, selectOnboardingOption, markWhatsappOpened,
} = require('../controllers/authController');
const { authenticate, authenticateOnboarding } = require('../middleware/auth');

/**
 * Password-reset endpoints get their own limiter, tighter than the 50/15min
 * app.js already applies across /api/auth.
 *
 * Two different abuses to slow down, so two different limits:
 *
 *   requestLimiter  someone hammering /forgot-password is either mailbombing a
 *                   real user or enumerating addresses. Five attempts an hour
 *                   is far more than a person who forgot their password needs.
 *   attemptLimiter  someone hitting /reset-password repeatedly is guessing at
 *                   tokens. The token is 256 bits so guessing is hopeless
 *                   anyway, but there is no reason to serve the attempts.
 *
 * Keyed by IP, which is what express-rate-limit does by default — good enough
 * for slowing a script, and deliberately not keyed on the submitted email,
 * which an attacker controls and could vary to escape the bucket.
 */
const requestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many password reset requests. Please try again in an hour.',
  },
});

const attemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    message: 'Too many attempts. Please try again shortly.',
  },
});

router.get('/config', publicConfig); // public: admin WhatsApp number for the signup handoff
router.post('/register', register);
router.post('/login', login);
router.post('/admin-login', adminLogin);
router.get('/me', authenticate, me);

/**
 * ---- onboarding (step 2 of registration) ----
 *
 * `/options` is public — it is a price list, and the page has to render it
 * before the user has done anything.
 *
 * The two writes take the SCOPED token from /register, not a session: the
 * account they belong to is status='pending' and cannot log in yet. See
 * middleware/auth.js `authenticateOnboarding`, and note that `authenticate`
 * refuses that token everywhere else.
 */
router.get('/onboarding/options', onboardingOptions);
router.post('/onboarding/select', authenticateOnboarding, selectOnboardingOption);
router.post('/onboarding/whatsapp-opened', authenticateOnboarding, markWhatsappOpened);

// ---- password reset (all public; the emailed token is the credential) ----
router.post('/forgot-password', requestLimiter, forgotPassword);
router.get('/reset-password/:token/validate', attemptLimiter, validateResetToken);
router.post('/reset-password', attemptLimiter, resetPassword);

module.exports = router;
