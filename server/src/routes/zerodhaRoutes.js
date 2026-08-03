const express = require('express');
const router = express.Router();
const { authenticate, authorize } = require('../middleware/auth');
const zerodha = require('../controllers/zerodhaController');

// Only admin can initiate/manage the Zerodha connection.
router.get('/login-url', authenticate, authorize('admin'), zerodha.getLoginUrl);

// Kite redirects a browser here. It cannot carry an Authorization header, so
// this route stays unauthenticated by necessity — the single-use `state`
// nonce in oauth_states is what proves the flow was started by an admin.
router.get('/callback', zerodha.callback);

router.get('/status', authenticate, authorize('admin'), zerodha.status);

// NEW — backs the "Disconnect Zerodha" and "Refresh Instruments" buttons in
// the admin panel spec. Both were listed as requirements with no endpoint.
router.post('/disconnect', authenticate, authorize('admin'), zerodha.disconnect);
router.post('/refresh-instruments', authenticate, authorize('admin'), zerodha.refreshInstruments);

module.exports = router;