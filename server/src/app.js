const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const zerodhaRoutes = require('./routes/zerodhaRoutes');
const marketRoutes = require('./routes/marketRoutes');
const greeksRoutes = require('./routes/greeksRoutes');
const optionRoutes = require('./routes/optionRoutes'); // NEW — option chain
const vegaRoutes = require('./routes/vegaRoutes');
const publicRoutes = require('./routes/publicRoutes'); // NEW — unauthenticated marketing-site data

const app = express();

/**
 * TRUST EXACTLY ONE PROXY HOP (A-03).
 *
 * This app is only ever reachable through Nginx (there is no express.static
 * here — Nginx serves the SPA and proxies /api and /ws). Without this setting
 * every request's `req.ip` is 127.0.0.1, so express-rate-limit puts the ENTIRE
 * INTERNET in a single bucket: 50 auth requests per 15 minutes shared across
 * all users, and the public limiter's 120/min becomes a global cap. The symptom
 * is intermittent 429s that look like an outage and are impossible to reproduce
 * from one machine.
 *
 * `1`, not `true`: trusting the whole chain would let any client forge
 * X-Forwarded-For and evade the limiter entirely. One hop is exactly the number
 * of proxies we control.
 */
app.set('trust proxy', 1);

app.use(helmet());
/**
 * CORS allowlist.
 *
 * CLIENT_URL stays SINGLE-valued on purpose: it also builds the password-reset
 * link (authController.resetLinkBase) and the post-OAuth redirect back to the
 * SPA (zerodhaController), so a comma-separated value would corrupt both.
 * Additional browser origins that must reach this API — www., a staging host —
 * go in CORS_EXTRA_ORIGINS instead. With that unset the behaviour is identical
 * to the previous single-origin form.
 */
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const CORS_ORIGINS = [
  CLIENT_URL,
  ...String(process.env.CORS_EXTRA_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];
app.use(cors({ origin: CORS_ORIGINS, credentials: true }));
app.use(express.json());

/**
 * A-04: `morgan('dev')` is colour-coded, one line per request, and was running
 * in production — where it is both unreadable in a log file and unbounded.
 * 'combined' is the standard production format; dev keeps the concise one.
 */
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Basic rate limiting on auth endpoints to slow brute-force attempts
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 50 });
app.use('/api/auth', authLimiter, authRoutes);

/**
 * The ONLY unauthenticated data routes in the app — the delayed Vega series the
 * public site shows to visitors who have not registered. Mounted before the
 * authenticated routers purely so it reads as the exception it is; the paths do
 * not overlap. It brings its own rate limiter (see the router).
 */
app.use('/api/public', publicRoutes);

app.use('/api/admin', adminRoutes);
app.use('/api/zerodha', zerodhaRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/greeks', greeksRoutes);
app.use('/api/options', optionRoutes); // NEW — option chain
app.use('/api/vega', vegaRoutes);

/**
 * LIVENESS — answers as long as the process is up.
 *
 * Deliberately touches nothing: no DB, no broker, no instrument master. This is
 * what an uptime check and an Nginx health probe should hit, and it is the
 * single fastest way to tell "Node is down" (502 at the proxy) apart from "Node
 * is up but degraded" (200 here, detail at /api/health/deep).
 */
app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  service: 'Vega Analysis API',
  uptimeSeconds: Math.round(process.uptime()),
  time: new Date().toISOString(),
}));

/**
 * READINESS — which subsystems are actually working (A-01).
 *
 * Every dependency is optional to the process staying alive, so a 502 can no
 * longer be the way you discover that MySQL or the Kite session is down. This
 * reports each one separately and never throws.
 */
app.get('/api/health/deep', async (req, res) => {
  const out = {
    status: 'ok',
    time: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    checks: {},
  };

  try {
    const db = require('./config/db');
    const started = Date.now();
    await db.query('SELECT 1');
    out.checks.database = { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    out.checks.database = { ok: false, error: err.code || err.message };
    out.status = 'degraded';
  }

  try {
    const instrumentService = require('./services/instrumentService');
    const stats = instrumentService.getStats();
    out.checks.instruments = { ok: stats.ready, ...stats };
    if (!stats.ready) out.status = 'degraded';
  } catch (err) {
    out.checks.instruments = { ok: false, error: err.message };
    out.status = 'degraded';
  }

  try {
    const { getTickerHealth } = require('./services/kiteTickerService');
    const health = getTickerHealth();
    out.checks.broker = { ok: health.connected, ...health };
    if (!health.connected) out.status = 'degraded';
  } catch (err) {
    out.checks.broker = { ok: false, error: err.message };
    out.status = 'degraded';
  }

  try {
    const vega = require('./services/vegaTimeseriesService');
    const stats = vega.getStats();
    /**
     * `ok` USED TO MEAN "IS THE CRON RUNNING", WHICH IS NOT HEALTH.
     *
     * On 2026-08-20 SENSEX produced 16 samples and then nothing for six hours,
     * and this block reported ok:true throughout — because the cron WAS
     * running. It ran perfectly and produced nothing for one instrument. The
     * count in `series` did not move either: the entry still existed, holding
     * a restored morning of points that would never grow.
     *
     * Health now means "every tracked target is actually producing", and a
     * dark instrument names itself and says why. Unauthenticated, so it can be
     * answered without an SSH session — which is what made the original
     * stoppage undiagnosable after the logs rolled.
     */
    const stale = stats.stale || [];
    out.checks.sampler = {
      ok: stats.sampling && stale.length === 0,
      sampling: stats.sampling,
      window: stats.window,
      skippedTicks: stats.skippedTicks,
      series: stats.underlyings.length,
      staleCount: stale.length,
      stale,
      skipped: stats.skipped || [],
    };
    if (stale.length) out.status = 'degraded';
  } catch (err) {
    out.checks.sampler = { ok: false, error: err.message };
  }

  // Always 200 — this endpoint reports status in the BODY. A non-200 here
  // would make a load balancer pull a node that is serving perfectly well
  // except that the market is closed.
  res.json(out);
});

// Central error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(500).json({ message: 'Internal server error' });
});

module.exports = app;