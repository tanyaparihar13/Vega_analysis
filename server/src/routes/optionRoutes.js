const express = require('express');
const router = express.Router();
const { authenticate, requirePremium } = require('../middleware/auth');
const ctrl = require('../controllers/optionChainController');

// The symbol list is cheap and drives the index buttons — any logged-in user
// may read it. The chain itself stays premium-gated, matching the existing
// policy on /api/market.
router.get('/', authenticate, ctrl.listSymbols);
router.get('/:symbol', authenticate, requirePremium, ctrl.getSymbolMeta);
router.get('/:symbol/expiries', authenticate, requirePremium, ctrl.getExpiries);
router.get('/:symbol/chain', authenticate, requirePremium, ctrl.getChain);

module.exports = router;