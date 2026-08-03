const express = require('express');
const router = express.Router();
const { authenticate, requirePremium } = require('../middleware/auth');
const optionChainService = require('../services/optionChainService');
const instrumentService = require('../services/instrumentService');
const oiBaselineService = require('../services/oiBaselineService');
const vegaTimeseriesService = require('../services/vegaTimeseriesService');
const { latestTicks } = require('../services/marketDataService');
const { listUnderlyings, getUnderlying } = require('../constants/instruments');

/**
 * The previous version of this file returned `fetchRawStrikesStub()` — a
 * hardcoded spot of 22000 and an empty strike array. Both endpoints below now
 * read the live tick cache through optionChainService instead. No fake data
 * remains in this file.
 */

function resolveExpiry(symbol, requested) {
  const expiries = instrumentService.getExpiries(symbol);
  if (requested) {
    if (!expiries.includes(requested)) {
      const err = new Error(`No contracts for ${symbol} expiring ${requested}`);
      err.statusCode = 404;
      throw err;
    }
    return requested;
  }
  if (!expiries.length) {
    const err = new Error(`No live expiries for ${symbol}`);
    err.statusCode = 404;
    throw err;
  }
  return expiries[0];
}

function buildLiveChain(symbol, expiry, strikeWindow = 20) {
  return optionChainService.buildChain({
    symbol,
    expiry: resolveExpiry(symbol, expiry),
    latestTicks,
    oiBaseline: oiBaselineService.getBaselineMap(),
    strikeWindow,
  });
}

// GET /api/market/option-chain/:underlying?expiry=YYYY-MM-DD
// Kept for backward compatibility. /api/options/:symbol/chain is canonical.
router.get('/option-chain/:underlying', authenticate, requirePremium, (req, res) => {
  try {
    const snapshot = buildLiveChain(req.params.underlying, req.query.expiry);
    res.json({
      underlying: snapshot.symbol,
      expiry: snapshot.expiry,
      spot: snapshot.spot,
      atmStrike: snapshot.atmStrike,
      pcr: snapshot.pcr,
      maxPain: snapshot.maxPain,
      atmIv: snapshot.atmIv,
      chain: snapshot.chain,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// GET /api/market/vega-analysis/:underlying
//
// UNIFIED: this used to call the now-removed utils/vegaAnalysisEngine.js (an
// OI-weighted, slope-based duplicate). It now serves the SAME data as
// /api/vega/:symbol/series — the single addvega.php-parity engine — so there is
// exactly one source of truth for Vega. Response shape is preserved
// (underlying/spot/snapshot/history) for backward compatibility; `snapshot` is
// the latest decorated point (with trend) and `history` is today's series.
router.get('/vega-analysis/:underlying', authenticate, requirePremium, (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.underlying);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.underlying}` });

    const tick = latestTicks.get(cfgU.spotToken);
    const history = vegaTimeseriesService.getSeries(cfgU.key, '1m');

    res.json({
      underlying: cfgU.key,
      spot: tick?.lastPrice ?? null,
      snapshot: vegaTimeseriesService.getLatest(cfgU.key), // latest point + trend
      dayOpen: vegaTimeseriesService.getDayOpen(cfgU.key),
      history,
    });
  } catch (err) {
    res.status(err.statusCode || 500).json({ message: err.message });
  }
});

// GET /api/market/indices — live index snapshot from the tick cache
router.get('/indices', authenticate, (req, res) => {
  const indices = listUnderlyings().map((u) => {
    const cfg = getUnderlying(u.key);
    const tick = latestTicks.get(cfg.spotToken);
    return {
      symbol: u.key,
      label: u.label,
      spotSymbol: u.spotSymbol,
      lastPrice: tick?.lastPrice ?? null,
      change: tick?.change ?? null,
      percentChange: tick?.percentChange ?? null,
      timestamp: tick?.timestamp ?? null,
    };
  });

  res.json({
    instrumentsReady: instrumentService.isReady(),
    indices,
    note: 'Continuous updates stream over the /ws/market WebSocket.',
  });
});

module.exports = router;