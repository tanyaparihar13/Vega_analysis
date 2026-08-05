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
 * Boot order:
 *   0. Migrations — every table this process touches must exist first.
 *      (oauth_states in particular; without it, connecting Zerodha 500s.)
 *   0b. Admin bootstrap — without an admin, NOTHING works: the Zerodha
 *      connect flow is admin-only, so no admin means no access token, which
 *      means no ticks, no instruments, no chain and no vega. See seedAdmin.js.
 *   1. HTTP listen
 *   2. WebSocket server + market feed
 *   3. Restore + VERIFY the stored Kite token
 *   4. Instrument master — from Kite if authenticated, else from the MySQL
 *      cache so the chain still works before an admin reconnects
 *   5. Option chain stream, OI baseline, IV history
 *
 * Steps 3-5 degrade gracefully. The API keeps serving auth and admin routes
 * regardless, and chain endpoints report 503 until instruments are available.
 */
(async function boot() {
  // ---- 0. Migrations ----------------------------------------------------
  try {
    await migrate.run({ verbose: true });
  } catch (err) {
    // Do not exit. A DB that is briefly unreachable should not stop the
    // process from coming up — config/db.js retries per query, and an admin
    // can re-run `npm run db:migrate`.
    console.error('[Boot] Migrations failed — continuing, but tables may be missing:', err.message);
  }

  // ---- 0b. Admin bootstrap ----------------------------------------------
  // Idempotent and non-fatal — logs and continues if the DB is unreachable.
  await seedAdmin.run({ verbose: true });

  // ---- 1. Listen --------------------------------------------------------
  await new Promise((resolve) => {
    server.listen(PORT, () => {
      console.log(`[Vega Analysis] API + WebSocket server running on port ${PORT}`);
      resolve();
    });
  });

  // ---- 2. Market feed ---------------------------------------------------
  await startMarketFeed(server).catch((err) => {
    console.warn('[Market Feed] Not started yet:', err.message);
  });

  optionStreamService.init(latestTicks);

  // ---- 3. Restore + verify the Kite session -----------------------------
  reportKiteConfig();

  let authenticated = false;
  if (await restoreSession()) {
    // restoreSession only proves a row exists and has not passed its stored
    // expiry. It does NOT prove Kite still honours the token — logging into
    // Kite from a phone kills the server's token immediately, and expires_at
    // knows nothing about that. One getProfile() call settles it before we
    // subscribe a ticker that would 403 thirty seconds later.
    const verified = await verifySession();
    authenticated = verified.valid;
  }

  // ---- 4. Instrument master --------------------------------------------
  if (authenticated) {
    try {
      await instrumentService.refresh(kc);
      instrumentService.scheduleDailyRefresh(kc);
    } catch (err) {
      console.error('[Instruments] Kite refresh failed, falling back to MySQL cache:', err.message);
      await instrumentService.loadFromDatabase();
    }
  } else {
    // No live session. Contracts do not change intraday, so yesterday's master
    // is still correct — load it so the chain renders (with stale prices and a
    // clear "feed down" banner) instead of showing an empty page.
    const restored = await instrumentService.loadFromDatabase();
    console.log(
      restored
        ? '[Instruments] Serving from MySQL cache — admin must connect Zerodha for live prices.'
        : '[Instruments] No cache available. Waiting for an admin to connect Zerodha.'
    );
  }

  // ---- 5. Derived-data caches ------------------------------------------
  await oiBaselineService.loadBaseline();
  await oiBaselineService.loadAllIvHistory(Object.keys(UNDERLYINGS));

await vegaTimeseriesService.loadToday();
vegaTimeseriesService.start(latestTicks);



  console.log('[Boot] Startup complete.');
})().catch((err) => {
  console.error('[Boot] Fatal startup error:', err);
  process.exit(1);
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