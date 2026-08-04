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
 * EXPIRY-WISE: `?expiry=YYYY-MM-DD` selects which contract's series to read on
 * /series and /dates, and /expiries lists what is selectable. The parameter is
 * OPTIONAL everywhere — omitting it resolves to the nearest expiry available
 * for the requested day, which is exactly what these endpoints returned before
 * expiries existed, so every existing caller keeps working unchanged.
 *
 * Mounted in app.js as:  app.use('/api/vega', vegaRoutes);
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an optional YYYY-MM-DD query parameter.
 * @returns {{ ok: true, value: string|null } | { ok: false, message: string }}
 */
function readDateParam(raw, label) {
  if (raw == null || raw === '') return { ok: true, value: null };
  const value = String(raw);
  if (!DATE_RE.test(value)) return { ok: false, message: `${label} must be YYYY-MM-DD` };
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return { ok: false, message: `Not a real calendar date: ${value}` };
  }
  return { ok: true, value };
}

// GET /api/vega/:symbol/series?timeframe=1m|3m|5m|15m&date=YYYY-MM-DD&expiry=YYYY-MM-DD
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

    const dateParam = readDateParam(req.query.date, 'date');
    if (!dateParam.ok) return res.status(400).json({ message: dateParam.message });
    const date = dateParam.value;
    if (date && date > vegaTimeseriesService.todayIst()) {
      return res.status(400).json({ message: 'date cannot be in the future' });
    }

    const expiryParam = readDateParam(req.query.expiry, 'expiry');
    if (!expiryParam.ok) return res.status(400).json({ message: expiryParam.message });

    // Every request goes through loadByDate now, including the no-date case.
    // Previously the two branches produced subtly different payloads (no
    // baseline metadata on the live path), which is what made "today" and "a
    // stored day" render differently in the UI.
    const resolvedDate = date || vegaTimeseriesService.todayIst();

    // An unrecognised (or absent) expiry falls back to the nearest one that has
    // data for the day rather than 404-ing — a chart that quietly shows the
    // front month beats an error banner when an expiry rolls over mid-session.
    const { expiry, available } =
      await vegaTimeseriesService.resolveExpiry(cfgU.key, resolvedDate, expiryParam.value);

    const { points, dayOpen, live, hasBaseline, fromStore } =
      await vegaTimeseriesService.loadByDate(cfgU.key, resolvedDate, timeframe, expiry);

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
      // The expiry these points belong to, plus what else was selectable for
      // this day — so the dropdown can stay populated from the same response
      // that filled the chart and can never disagree with it.
      expiry: expiry || (latest?.expiry ?? dayOpen?.expiry ?? null),
      requestedExpiry: expiryParam.value,
      expiries: available,
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

/**
 * GET /api/vega/:symbol/expiries?date=YYYY-MM-DD
 *
 * What the expiry dropdown offers for one trading day. For TODAY this is the
 * contracts the recorder is actively sampling (flagged `recording: true`) plus
 * anything already written; for a past day it is strictly what was recorded,
 * because an expired contract is no longer in the instrument master.
 */
router.get('/:symbol/expiries', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const dateParam = readDateParam(req.query.date, 'date');
    if (!dateParam.ok) return res.status(400).json({ message: dateParam.message });

    const today = vegaTimeseriesService.todayIst();
    const date = dateParam.value || today;
    if (date > today) return res.status(400).json({ message: 'date cannot be in the future' });

    const expiries = await vegaTimeseriesService.listExpiries(cfgU.key, date);

    res.json({
      symbol: cfgU.key,
      label: cfgU.label,
      date,
      today,
      // Nearest first, so [0] is the current expiry — the client's default.
      default: expiries.length ? expiries[0].expiry : null,
      count: expiries.length,
      expiries,
    });
  } catch (err) {
    console.error('[vega/expiries] error:', err.message);
    res.status(500).json({ message: 'Failed to list expiries' });
  }
});

// GET /api/vega/:symbol/dates?expiry=YYYY-MM-DD — which past days have stored
// data, for the picker. `expiry` narrows it to days that recorded THAT contract.
router.get('/:symbol/dates', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const expiryParam = readDateParam(req.query.expiry, 'expiry');
    if (!expiryParam.ok) return res.status(400).json({ message: expiryParam.message });

    const dates = await vegaTimeseriesService.listAvailableDates(cfgU.key, 120, expiryParam.value);
    // `today` is the server's IST date. The client anchors its picker to this
    // rather than to the browser clock, so a user in another timezone still
    // sees the correct trading day.
    res.json({
      symbol: cfgU.key,
      today: vegaTimeseriesService.todayIst(),
      expiry: expiryParam.value,
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
