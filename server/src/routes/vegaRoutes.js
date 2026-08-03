'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, requirePremium } = require('../middleware/auth');
const vegaTimeseriesService = require('../services/vegaTimeseriesService');
const { getUnderlying } = require('../constants/instruments');
const cfg = require('../config/vegaConfig');

/**
 * Vega Analysis time series (PHP addvega.php port).
 *
 * Same paths and auth as before, so nothing on the client breaks. Each point
 * now also carries the derived trend (Bullish/Bearish/Sideways) — datav1.php
 * rules — and the response advertises the active strike mode + delta band.
 *
 * Mounted in app.js as:  app.use('/api/vega', vegaRoutes);
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/vega/:symbol/series?timeframe=1m|3m|5m|15m&date=YYYY-MM-DD
router.get('/:symbol/series', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const timeframe = String(req.query.timeframe || '1m');
    if (!(timeframe in vegaTimeseriesService.TIMEFRAME_MINUTES)) {
      return res.status(400).json({
        message: `Unsupported timeframe: ${timeframe}`,
        supported: Object.keys(vegaTimeseriesService.TIMEFRAME_MINUTES),
      });
    }

    const date = req.query.date ? String(req.query.date) : null;
    if (date && !DATE_RE.test(date)) {
      return res.status(400).json({ message: 'date must be YYYY-MM-DD' });
    }
    if (date && Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
      return res.status(400).json({ message: `Not a real calendar date: ${date}` });
    }
    if (date && date > vegaTimeseriesService.todayIst()) {
      return res.status(400).json({ message: 'date cannot be in the future' });
    }

    // Every request goes through loadByDate now, including the no-date case.
    // Previously the two branches produced subtly different payloads (no
    // baseline metadata on the live path), which is what made "today" and "a
    // stored day" render differently in the UI.
    const resolvedDate = date || vegaTimeseriesService.todayIst();
    const { points, dayOpen, live, hasBaseline, fromStore } =
      await vegaTimeseriesService.loadByDate(cfgU.key, resolvedDate, timeframe);

    const latest = points.length ? points[points.length - 1] : null;

    res.json({
      symbol: cfgU.key,
      label: cfgU.label,
      timeframe,
      date: resolvedDate,
      requestedDate: date,
      live,
      source: live && !fromStore ? 'memory' : 'database',
      strikeMode: cfg.STRIKE_MODE,                       // 'dynamic' | 'frozen'
      start: vegaTimeseriesService.startFor(cfgU.key),   // 0.05 or 0.20
      deltaMax: cfg.DELTA_MAX,
      hasBaseline,
      expiry: latest?.expiry ? String(latest.expiry).slice(0, 10) : (dayOpen?.expiry ? String(dayOpen.expiry).slice(0, 10) : null),
      dayOpen: dayOpen
        ? { callVega: dayOpen.callVega, putVega: dayOpen.putVega,
            callStrikes: dayOpen.callStrikes, putStrikes: dayOpen.putStrikes,
            capturedAt: dayOpen.capturedAt ? String(dayOpen.capturedAt) : null }
        : null,
      latestTrend: latest ? { label: latest.trend, key: latest.trendKey, color: latest.trendColor } : null,
      count: points.length,
      points,   // each point carries trend / trendKey / trendColor
    });
  } catch (err) {
    console.error('[vega/series] error:', err.message);
    res.status(500).json({ message: 'Failed to read the vega series' });
  }
});

// GET /api/vega/:symbol/dates — which past days have stored data, for the picker.
router.get('/:symbol/dates', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });
    const dates = await vegaTimeseriesService.listAvailableDates(cfgU.key);
    // `today` is the server's IST date. The client anchors its picker to this
    // rather than to the browser clock, so a user in another timezone still
    // sees the correct trading day.
    res.json({
      symbol: cfgU.key,
      today: vegaTimeseriesService.todayIst(),
      count: dates.length,
      dates,
    });
  } catch (err) {
    console.error('[vega/dates] error:', err.message);
    res.status(500).json({ message: 'Failed to list available dates' });
  }
});

// GET /api/vega/status — sampler health, for the admin panel
router.get('/status', authenticate, requirePremium, (req, res) => {
  res.json(vegaTimeseriesService.getStats());
});

module.exports = router;
