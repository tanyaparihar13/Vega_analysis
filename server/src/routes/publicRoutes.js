'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const vegaTimeseriesService = require('../services/vegaTimeseriesService');
const { getUnderlying, listUnderlyings } = require('../constants/instruments');

/**
 * PUBLIC API — the only routes in this app served without a JWT.
 *
 * They exist so the marketing site can show a real, delayed Vega chart to a
 * visitor who has not registered yet. Everything here is deliberately kept in
 * its own file rather than added to vegaRoutes.js with the auth middleware
 * omitted: a reviewer can see at a glance exactly which endpoints are open,
 * and an accidental edit to the premium routes cannot make them public.
 *
 * WHAT IS AND IS NOT EXPOSED
 *   exposed  — the three vega DIFFERENCES and the derived trend, delayed by
 *              PUBLIC_VEGA_DELAY_MINUTES (default 30).
 *   withheld — live data, absolute call/put vega totals, the day-open
 *              baseline, spot price, strike counts, expiry, the option chain,
 *              Greeks, and every historical date beyond the one day shown.
 *
 * The withheld fields are dropped in `toPublicPoint` below rather than left in
 * "because the chart ignores them". A public JSON endpoint is read by more than
 * the chart.
 *
 * No fake data: if the recorder has never run, this returns an empty series and
 * the site says so. It never synthesises points.
 */

const DELAY_MINUTES = Math.max(
  0,
  Number(process.env.PUBLIC_VEGA_DELAY_MINUTES) || vegaTimeseriesService.PUBLIC_DELAY_MINUTES
);

/**
 * Tighter than the authenticated routes because there is no account behind a
 * caller here. Generous enough for a page that polls once a minute with a
 * handful of visitors per IP behind a NAT.
 */
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests. Please try again shortly.' },
});

router.use(publicLimiter);

/** Strip a stored point down to what a public visitor is allowed to see. */
function toPublicPoint(p) {
  return {
    time: p.time,
    callVegaDiff: p.callVegaDiff,
    putVegaDiff: p.putVegaDiff,
    vegaDiff: p.vegaDiff,
    trend: p.trend,
    trendKey: p.trendKey,
    trendColor: p.trendColor,
  };
}

/**
 * GET /api/public/vega/:symbol/delayed-series?timeframe=1m|3m|5m|15m
 *
 * The delayed teaser chart on the public site.
 *
 * `isFallbackDay` is true when today has no publishable points yet (before
 * ~09:45 IST, or a weekend/holiday) and the response is the previous session
 * instead. The client MUST surface that — showing last Friday's curve labelled
 * as today would be a lie, which is worse than showing nothing.
 */
router.get('/vega/:symbol/delayed-series', async (req, res) => {
  try {
    const cfg = getUnderlying(req.params.symbol);
    if (!cfg) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const timeframe = String(req.query.timeframe || '1m');
    if (!(timeframe in vegaTimeseriesService.TIMEFRAME_MINUTES)) {
      return res.status(400).json({
        message: `Unsupported timeframe: ${timeframe}`,
        supported: Object.keys(vegaTimeseriesService.TIMEFRAME_MINUTES),
      });
    }

    const result = await vegaTimeseriesService.loadDelayed(cfg.key, {
      delayMinutes: DELAY_MINUTES,
      timeframe,
    });

    res.json({
      symbol: cfg.key,
      label: cfg.label,
      timeframe,
      date: result.date,
      today: vegaTimeseriesService.todayIst(),
      delayMinutes: result.delayMinutes,
      isFallbackDay: result.isFallbackDay,
      asOf: result.asOf,
      count: result.points.length,
      points: result.points.map(toPublicPoint),
      // Stated in the payload so the disclaimer on the page and the actual
      // delay applied by the server can never drift apart.
      notice: `Delayed by ${result.delayMinutes} minutes. Live data requires an approved account.`,
    });
  } catch (err) {
    console.error('[public/delayed-series] error:', err.message);
    res.status(500).json({ message: 'Failed to read the delayed vega series' });
  }
});

/**
 * GET /api/public/site-config — contact details for the public Contact page.
 *
 * Everything is read from the environment and anything unset comes back null,
 * so the page renders only channels that actually exist. That is deliberate:
 * the page this replaced hard-coded a third party's email address and phone
 * number, and an address field reading "Add your office address here".
 *
 * Only the WhatsApp number is required (it already drives the signup handoff).
 * PUBLIC_CONTACT_EMAIL and PUBLIC_CONTACT_PHONE are optional.
 */
router.get('/site-config', (req, res) => {
  const whatsapp = String(process.env.ADMIN_WHATSAPP_NUMBER || '').replace(/\D/g, '');
  res.json({
    adminWhatsappNumber: whatsapp || null,
    contactEmail: process.env.PUBLIC_CONTACT_EMAIL || null,
    contactPhone: process.env.PUBLIC_CONTACT_PHONE || null,
  });
});

/** GET /api/public/vega/symbols — which underlyings the public chart can show. */
router.get('/vega/symbols', (req, res) => {
  res.json({
    delayMinutes: DELAY_MINUTES,
    symbols: listUnderlyings().map(({ key, label }) => ({ key, label })),
  });
});

module.exports = router;
