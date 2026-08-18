const http = require('http');
const cron = require('node-cron');
require('dotenv').config();

const app = require('./app');
const migrate = require('./config/migrate');
const seedAdmin = require('./config/seedAdmin');
const { startMarketFeed, latestTicks } = require('./services/marketDataService');
const { restoreSession, verifySession, kc } = require('./controllers/zerodhaController');
const instrumentService = require('./services/instrumentService');
const optionStreamService = require('./services/optionStreamService');
const oiBaselineService = require('./services/oiBaselineService');
const vegaTimeseriesService = require('./services/vegaTimeseriesService');

const { UNDERLYINGS } = require('./constants/instruments');

const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

const IST = { timezone: 'Asia/Kolkata' };

/**
 * Kite rejects an OAuth callback unless the redirect URL matches the one
 * registered on developers.kite.trade CHARACTER FOR CHARACTER. When it does
 * not match, Kite silently redirects without a `request_token`, and the
 * callback fails with a message that looks like a token problem but is not.
 *
 * This project is reached through an ephemeral Cloudflare quick-tunnel, whose
 * hostname changes every time the tunnel restarts. That makes the mismatch the
 * single most likely reason a connect attempt fails, so print the value loudly
 * at boot rather than making you dig through .env to find it.
 */
function reportKiteConfig() {
  const url = process.env.KITE_REDIRECT_URL || '';
  const apiKey = process.env.KITE_API_KEY || '';

  console.log('──────────────────────────────────────────────────────────────');
  console.log('[Zerodha] Kite app configuration');
  console.log(`  API key        : ${apiKey ? `${apiKey.slice(0, 6)}…` : '(NOT SET)'}`);
  console.log(`  Redirect URL   : ${url || '(NOT SET)'}`);

  if (!url || !apiKey) {
    console.warn('  ⚠  KITE_API_KEY / KITE_REDIRECT_URL missing from server/.env — connecting Zerodha will fail.');
  } else {
    console.log('  ↳ This EXACT string must be the "Redirect URL" on developers.kite.trade.');
    if (/trycloudflare\.com/i.test(url)) {
      console.log('  ↳ Cloudflare quick-tunnel detected. Its hostname changes on every restart,');
      console.log('     so after starting a new tunnel update BOTH places:');
      console.log('       1. KITE_REDIRECT_URL in server/.env');
      console.log('       2. the Redirect URL field in your Kite app');
    }
  }
  console.log('──────────────────────────────────────────────────────────────');
}


/**
 * ===========================================================================
 * BOOT ORDER — THE PORT BINDS FIRST (A-01)
 * ===========================================================================
 * This used to run migrations and the admin seed BEFORE server.listen(), then
 * perform six more awaited steps with no individual error handling, under a
 * single terminal `.catch` that called process.exit(1). Two consequences, both
 * of which present identically to a user: `502 Bad Gateway` from Nginx, because
 * nothing is listening on 127.0.0.1:5000.
 *
 *   1. Anything that threw before listen() meant the port never bound at all.
 *   2. Anything that threw AFTER listen() killed a server that was already
 *      up and serving — restoreSession(), verifySession(),
 *      optionStreamService.init() and vegaTimeseriesService.start() were all
 *      unguarded.
 *
 * The order is now: bind the port, then bring subsystems up one at a time, each
 * inside its own guard. A failure degrades that subsystem and nothing else.
 * /api/health answers from the moment the port is bound, and /api/health/deep
 * reports exactly which subsystem is unhappy — so "the backend is down" and
 * "MySQL is down" stop looking like the same event.
 *
 * Degradation is honest, not silent: chain and vega endpoints return 503 with a
 * reason until instruments are available, and the admin panel can read
 * /api/health/deep.
 */

/** Run one boot step; never let it take the process down. */
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[Boot] ${name} failed — continuing degraded:`, err.message);
    return null;
  }
}

let listening = false;

(async function boot() {
  // ---- 1. LISTEN FIRST --------------------------------------------------
  // Nothing above this line. The port is the one thing that must exist for the
  // reverse proxy to stop returning 502.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, () => {
      listening = true;
      console.log(`[Vega Analysis] API + WebSocket server listening on port ${PORT}`);
      resolve();
    });
  });

  // ---- 2. Migrations ----------------------------------------------------
  await step('Migrations', () => migrate.run({ verbose: true }));

  // ---- 3. Admin bootstrap ----------------------------------------------
  // Without an admin, NOTHING works: the Zerodha connect flow is admin-only,
  // so no admin means no access token, no ticks, no instruments, no vega.
  await step('Admin bootstrap', () => seedAdmin.run({ verbose: true }));

  // ---- 4. Market feed + streams ----------------------------------------
  await step('Market feed', () => startMarketFeed(server));
  await step('Option/Vega stream', () => optionStreamService.init(latestTicks));

  // ---- 5. Restore + verify the Kite session -----------------------------
  reportKiteConfig();

  const authenticated = await step('Kite session', async () => {
    // restoreSession only proves a row exists and has not passed its stored
    // expiry. It does NOT prove Kite still honours the token — logging into
    // Kite from a phone kills the server's token immediately, and expires_at
    // knows nothing about that. One getProfile() call settles it before we
    // subscribe a ticker that would 403 thirty seconds later.
    if (!(await restoreSession())) return false;
    return (await verifySession()).valid;
  });

  // ---- 6. Instrument master --------------------------------------------
  await step('Instrument master', async () => {
    if (authenticated) {
      try {
        await instrumentService.refresh(kc);
        instrumentService.scheduleDailyRefresh(kc);
        return;
      } catch (err) {
        console.error('[Instruments] Kite refresh failed, falling back to MySQL cache:', err.message);
      }
    }
    // No live session (or the refresh failed). Contracts do not change
    // intraday, so yesterday's master is still correct — load it so the chain
    // renders (with stale prices and a clear "feed down" banner) instead of an
    // empty page.
    const restored = await instrumentService.loadFromDatabase();
    console.log(
      restored
        ? '[Instruments] Serving from MySQL cache — admin must connect Zerodha for live prices.'
        : '[Instruments] No cache available. Waiting for an admin to connect Zerodha.'
    );
  });

  // ---- 7. Derived-data caches ------------------------------------------
  await step('OI baseline', () => oiBaselineService.loadBaseline());
  await step('IV history', () => oiBaselineService.loadAllIvHistory(Object.keys(UNDERLYINGS)));

  // ---- 8. Vega recorder -------------------------------------------------
  // loadToday() restores today's baselines and buffered samples from MySQL, so
  // a restart mid-session resumes rather than starting blank. It is the reason
  // history survives a PM2/Docker restart with at most one sample lost.
  await step('Vega history restore', () => vegaTimeseriesService.loadToday());
  await step('Vega sampler', () => vegaTimeseriesService.start(latestTicks));

  console.log('[Boot] Startup complete.');
})().catch((err) => {
  /**
   * Only a failure to BIND is fatal now. Everything after that point has its
   * own guard, so reaching here with the socket open would mean exiting a
   * server that is answering requests — which is precisely how a recoverable
   * subsystem fault turned into a 502.
   */
  if (!listening) {
    console.error('[Boot] Could not bind the port — exiting:', err.message);
    process.exit(1);
  }
  console.error('[Boot] Startup error after listen — continuing degraded:', err);
});

/**
 * ===========================================================================
 * KEEP THE PROCESS ALIVE (A-02)
 * ===========================================================================
 * Node >= 15 TERMINATES the process on an unhandled promise rejection. This app
 * holds a broker socket, five cron jobs, a 1 Hz push loop and a 5-second
 * sampler; a single floating promise anywhere in that machinery would kill a
 * healthy server, and the only externally visible symptom is a 502.
 *
 * Logging and continuing is the right trade for a read-only market-data
 * service: no request handler mutates shared state in a way that a mid-flight
 * abort could corrupt, and MySQL writes are individually transactional. An
 * uncaught exception is logged with its stack so the cause is recoverable from
 * the log rather than inferred from the absence of a process.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[Process] Unhandled promise rejection — continuing:',
    reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception — continuing:', err?.stack || err);
});

/**
 * Kite access tokens expire daily around 07:30 IST and require an interactive
 * login — there is no supported silent refresh, whatever any tutorial claims.
 * This does not bypass that; it restarts the feed if a session happens to be
 * valid, and logs loudly if not.
 */
cron.schedule('0 8 * * 1-5', async () => {
  console.log('[Cron] New trading day — checking Zerodha session…');
  try {
    const restored = await restoreSession();
    if (restored && (await verifySession()).valid) {
      await startMarketFeed(server);
      await instrumentService.refresh(kc, { force: true });
      console.log('[Cron] Market feed restarted.');
    } else {
      console.warn('[Cron] No valid session — an admin must reconnect Zerodha.');
    }
  } catch (err) {
    console.warn('[Cron] Session check failed — admin must reconnect:', err.message);
    // Wire an email/Slack alert here.
  }
}, IST);

/**
 * Capture closing OI just after the 15:30 close. Without this, the "OI Change"
 * column has nothing to diff against and stays blank.
 */
cron.schedule('35 15 * * 1-5', async () => {
  try {
    await oiBaselineService.captureBaseline(latestTicks);
    await oiBaselineService.loadBaseline();
  } catch (err) {
    console.error('[Cron] OI baseline capture failed:', err.message);
  }
}, IST);

/**
 * Record each index's ATM IV at the close, so IV Percentile has a series to
 * rank against. Expect blank percentiles for the first ~20 trading days.
 */
cron.schedule('40 15 * * 1-5', async () => {
  const optionChainService = require('./services/optionChainService');
  for (const cfg of Object.values(UNDERLYINGS)) {
    try {
      const expiries = instrumentService.getExpiries(cfg.key);
      if (!expiries.length) continue;
      const snapshot = optionChainService.buildChain({
        symbol: cfg.key,
        expiry: expiries[0],
        latestTicks,
        strikeWindow: 5,
      });
      await oiBaselineService.recordAtmIv(cfg.key, snapshot.atmIv);
    } catch (err) {
      console.warn(`[Cron] ATM IV capture failed for ${cfg.key}:`, err.message);
    }
  }
}, IST);

// Purge consumed / expired OAuth nonces so the table cannot grow unbounded.
//
// Compares against Node's UTC clock, not MySQL's NOW(): oauth_states.expires_at
// is written in UTC by zerodhaController (toMysqlUtc), while NOW() is MySQL's
// local time — IST here. See the reapStates() comment for the full explanation.
cron.schedule('0 3 * * *', async () => {
  try {
    const db = require('./config/db');
    const { toMysqlUtc } = require('./utils/kiteSessionTime');
    const cutoff = toMysqlUtc(new Date(Date.now() - 24 * 60 * 60 * 1000));
    await db.query('DELETE FROM oauth_states WHERE expires_at < :cutoff', { cutoff });
  } catch (err) {
    console.warn('[Cron] OAuth state cleanup failed:', err.message);
  }
}, IST);

/**
 * Vega retention — ONE MONTH (vegaConfig.RETENTION_DAYS, default 30).
 *
 * Was 90 days and covered only two of the three tables. It now delegates to
 * vegaTimeseriesService.purgeOldHistory(), which sweeps vega_timeseries,
 * vega_day_open AND vega_chain_snapshots against the same cutoff — pruning the
 * series without its baselines used to leave vega_day_open rows for days that
 * have no samples, which the date picker then offered as empty sessions.
 *
 * Shortening the window is also what makes 5s storage for stocks affordable:
 * a month of seconds-resolution rows is a smaller table than three months of
 * minute rows across a growing stock list.
 */
cron.schedule('30 3 * * *', async () => {
  try {
    const { deleted, retentionDays } = await vegaTimeseriesService.purgeOldHistory();
    const total = Object.values(deleted).reduce((a, n) => a + (n || 0), 0);
    if (total) {
      console.log(`[Cron] Vega retention (${retentionDays}d): pruned `
        + Object.entries(deleted).map(([t, n]) => `${t}=${n ?? 'skipped'}`).join(' '));
    }
  } catch (err) {
    console.warn('[Cron] Vega retention cleanup failed:', err.message);
  }
}, IST);

function shutdown(signal) {
  console.log(`[Shutdown] ${signal} received — closing cleanly.`);
  optionStreamService.stop();
  try {
    require('./services/kiteTickerService').disconnectTicker();
  } catch { /* ticker may never have started */ }
  server.close(() => process.exit(0));
  // Do not hang forever on a lingering keep-alive socket.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// nodemon restarts with SIGUSR2. Without this the previous process keeps its
// KiteTicker socket open, and Kite allows only 3 concurrent connections per
// API key — three saves in a row and you are locked out with a 403 that looks
// like a token problem but is not.
process.once('SIGUSR2', () => {
  optionStreamService.stop();
  try {
    require('./services/kiteTickerService').disconnectTicker();
  } catch { /* not started */ }
  server.close(() => process.kill(process.pid, 'SIGUSR2'));
});