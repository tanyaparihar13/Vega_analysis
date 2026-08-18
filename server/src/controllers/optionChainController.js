const instrumentService = require('../services/instrumentService');
const optionChainService = require('../services/optionChainService');
const { listUnderlyings, getUnderlying } = require('../constants/instruments');
const { latestTicks } = require('../services/marketDataService');
const oiBaselineService = require('../services/oiBaselineService');

function fail(res, err, fallbackMessage) {
  const status = err.statusCode || 500;
  if (status >= 500) console.error(`[OptionChain] ${fallbackMessage}:`, err.message);
  res.status(status).json({ message: err.message || fallbackMessage });
}

// GET /api/options  — the five index buttons
function listSymbols(req, res) {
  res.json({ symbols: listUnderlyings(), instrumentsReady: instrumentService.isReady() });
}

// GET /api/options/:symbol  — metadata + expiries + current spot
function getSymbolMeta(req, res) {
  try {
    // B-05: resolve F&O stocks too. instrumentService checks the curated five
    // first, so index behaviour is bit-for-bit what it was.
    const cfg = instrumentService.resolveUnderlying(req.params.symbol)
      || getUnderlying(req.params.symbol);
    if (!cfg) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const expiries = instrumentService.getExpiries(cfg.key);
    const spotTick = latestTicks.get(cfg.spotToken);

    res.json({
      symbol: cfg.key,
      label: cfg.label,
      spotSymbol: cfg.spotSymbol,
      strikeStep: cfg.strikeStep,
      lotSize: cfg.lotSize,
      expiries,
      nearestExpiry: expiries[0] || null,
      spot: spotTick?.lastPrice ?? null,
      spotChange: spotTick?.change ?? null,
      spotPercentChange: spotTick?.percentChange ?? null,
    });
  } catch (err) {
    fail(res, err, 'Failed to load symbol metadata');
  }
}

// GET /api/options/:symbol/expiries
function getExpiries(req, res) {
  try {
    res.json({ symbol: req.params.symbol.toUpperCase(), expiries: instrumentService.getExpiries(req.params.symbol) });
  } catch (err) {
    fail(res, err, 'Failed to load expiries');
  }
}

// GET /api/options/:symbol/chain?expiry=YYYY-MM-DD&window=20
function getChain(req, res) {
  try {
    const { symbol } = req.params;
    let { expiry, window } = req.query;

    if (!expiry) {
      const expiries = instrumentService.getExpiries(symbol);
      expiry = expiries[0];
      if (!expiry) return res.status(404).json({ message: `No live expiries for ${symbol}` });
    }

    const strikeWindow = Math.min(Math.max(Number(window) || 20, 1), 60);

    const snapshot = optionChainService.buildChain({
      symbol,
      expiry,
      latestTicks,
      oiBaseline: oiBaselineService.getBaselineMap(),
      strikeWindow,
    });

    // IV percentile needs a stored series; null until enough days are banked.
    snapshot.ivPercentile = optionChainService.calculateIvPercentile(
      snapshot.atmIv,
      oiBaselineService.getIvHistorySync(snapshot.symbol)
    );

    res.json(snapshot);
  } catch (err) {
    fail(res, err, 'Failed to build option chain');
  }
}

module.exports = { listSymbols, getSymbolMeta, getExpiries, getChain };