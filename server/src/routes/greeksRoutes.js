const express = require('express');
const router = express.Router();
const { authenticate, requirePremium } = require('../middleware/auth');
const { calculateGreeks, calculateGreeksBatch } = require('../controllers/greeksController');

// Both routes are manually invoked by the client (button click / explicit
// request) — there is no cron job, interval, or websocket handler calling
// into this service anywhere in the codebase.
router.post('/calculate', authenticate, requirePremium, calculateGreeks);
router.post('/calculate-batch', authenticate, requirePremium, calculateGreeksBatch);

module.exports = router;
