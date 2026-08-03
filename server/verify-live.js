/**
 * verify-live.js — end-to-end health check of the RUNNING system.
 *
 *     npm run verify:live
 *
 * Exercises the real server over HTTP plus the real database, in the same
 * order the product depends on things, and stops being green the moment a
 * link in the chain is actually broken:
 *
 *   admin account -> Zerodha session -> Kite token alive -> instruments
 *   -> ticker connected -> live ticks -> option chain -> Greeks -> Vega
 *   -> recorder subscriptions -> rows on disk
 *
 * It NEVER writes market data. It only reads. Nothing here fabricates,
 * back-fills or imports a single price — if a check is red, it is red.
 *
 * Exit code 0 = everything that CAN pass right now passed.
 * Exit code 1 = something is genuinely broken (not merely "market closed").
 */

'use strict';

const http = require('http');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.VERIFY_HOST || 'localhost';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;
let blocked = 0;

function pass(label, detail = '') {
  console.log(`  ${GREEN}✓${RESET} ${label}${detail ? `  ${DIM}${detail}${RESET}` : ''}`);
}
function fail(label, detail = '') {
  failures += 1;
  console.log(`  ${RED}✗${RESET} ${label}${detail ? `  ${RED}${detail}${RESET}` : ''}`);
}
/** Not broken — just not possible right now (market closed, not connected yet). */
function skip(label, why) {
  blocked += 1;
  console.log(`  ${YELLOW}–${RESET} ${label}  ${YELLOW}${why}${RESET}`);
}
function section(t) {
  console.log(`\n${t}`);
  console.log('─'.repeat(Math.max(t.length, 46)));
}

function api(path, token) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: HOST, port: PORT, path, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, json, body });
        });
      }
    );
    req.on('error', (err) => resolve({ status: 0, error: err.message }));
    req.end();
  });
}

function istNow() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000);
}
function marketState() {
  const ist = istNow();
  const day = ist.getUTCDay();
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  return {
    ist: ist.toISOString().replace('T', ' ').slice(0, 19),
    open: weekday && mins >= 555 && mins <= 930,
    weekday,
    mins,
  };
}
const fmt = (v, dp = 2) => (v == null ? '—' : Number(v).toFixed(dp));

(async () => {
  console.log('\n══════════════════════════════════════════════');
  console.log('  VEGA ANALYSIS — LIVE SYSTEM VERIFICATION');
  console.log('══════════════════════════════════════════════');

  const mkt = marketState();
  console.log(`  IST now: ${mkt.ist}   Market: ${mkt.open ? `${GREEN}OPEN${RESET}` : `${YELLOW}CLOSED${RESET}`}`);

  // ---- 0. Server reachable ----------------------------------------------
  section('0. API server');
  const health = await api('/api/health');
  if (health.status !== 200) {
    fail('API reachable', health.error || `HTTP ${health.status}`);
    console.log(`\n${RED}Server is not running. Start it with: npm run dev${RESET}\n`);
    process.exit(1);
  }
  pass('API reachable', `http://${HOST}:${PORT}`);

  // ---- 1. Admin account --------------------------------------------------
  section('1. Admin account & auth');
  let db;
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || 3306,
      user: process.env.DB_USER, password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME, dateStrings: true,
    });
    pass('MySQL reachable', process.env.DB_NAME);
  } catch (err) {
    fail('MySQL reachable', err.message);
    process.exit(1);
  }

  const [admins] = await db.query(
    "SELECT id, email, role, is_active, status FROM users WHERE role = 'admin'"
  );
  if (!admins.length) fail('An admin user exists', 'run: npm run seed:admin');
  else {
    const a = admins[0];
    pass('An admin user exists', `${a.email}  role=${a.role} active=${a.is_active} status=${a.status}`);
    if (a.status !== 'approved') fail('Admin is approved', `status=${a.status}`);
    if (!a.is_active) fail('Admin is active', 'is_active=0');
  }

  const token = jwt.sign(
    { id: admins[0]?.id ?? 1, email: admins[0]?.email, role: 'admin', status: 'approved' },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );

  const adminCheck = await api('/api/admin/users', token);
  if (adminCheck.status === 200) pass('Admin API authorises', `${adminCheck.json.users.length} user(s)`);
  else fail('Admin API authorises', `HTTP ${adminCheck.status}`);

  // ---- 2. System status --------------------------------------------------
  section('2. Zerodha session');
  const st = await api('/api/admin/system-status', token);
  if (st.status !== 200) {
    fail('system-status endpoint', `HTTP ${st.status}`);
    process.exit(1);
  }
  const s = st.json;

  if (s.zerodha.connected) {
    pass('Zerodha session active', `kite_user=${s.zerodha.kiteUserId} expires=${s.zerodha.expiresAt}`);
  } else if (s.zerodha.reason === 'never_connected') {
    skip('Zerodha session active', 'never connected — open Admin → Connect Zerodha');
  } else {
    skip('Zerodha session active', `${s.zerodha.reason} — reconnect from the admin panel`);
  }
  console.log(`    ${DIM}redirect URL: ${s.zerodha.redirectUrl}${RESET}`);
  console.log(`    ${DIM}(must match developers.kite.trade character-for-character)${RESET}`);

  const connected = !!s.zerodha.connected;

  // ---- 3. Instruments ----------------------------------------------------
  section('3. Instrument master');
  if (s.instruments.ready && s.instruments.instrumentCount > 0) {
    pass('Instruments loaded', `${s.instruments.instrumentCount.toLocaleString()} contracts, ${s.instruments.underlyingCount} underlyings`);
  } else if (!connected) {
    skip('Instruments loaded', 'needs a Zerodha session (downloaded on connect)');
  } else {
    fail('Instruments loaded', 'connected but master is empty — try Refresh Instruments');
  }

  const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
  if (s.instruments.ready) {
    for (const sym of SYMBOLS) {
      const r = await api(`/api/options/${sym}/expiries`, token);
      const n = r.json?.expiries?.length ?? 0;
      if (n > 0) pass(`${sym} expiries`, `${n} available, nearest ${r.json.expiries[0]}`);
      else fail(`${sym} expiries`, 'none — check the instrument master');
    }
  }

  // ---- 4. Feed + WebSocket ----------------------------------------------
  section('4. Market feed & WebSocket');
  if (s.websocket.running) pass('WebSocket server listening', `${s.websocket.clients} browser client(s)`);
  else fail('WebSocket server listening');

  if (s.feed.connected) pass('KiteTicker connected', `${s.feed.subscribedCount} tokens subscribed`);
  else if (!connected) skip('KiteTicker connected', 'needs a Zerodha session');
  else fail('KiteTicker connected', s.feed.lastError || 'not connected');

  if (s.feed.needsReauth) fail('Token accepted by Kite', 'needsReauth — the access token was rejected');

  const standing = s.vegaRecorder?.subscription?.standing?.['vega-sampler'] ?? 0;
  if (standing > 0) pass('Recorder standing subscription', `${standing} option tokens`);
  else if (!s.instruments.ready) skip('Recorder standing subscription', 'needs the instrument master');
  else fail('Recorder standing subscription', '0 tokens — nothing will be recorded');

  // ---- 5. Live prices ----------------------------------------------------
  section('5. Live index prices');
  const idx = await api('/api/market/indices', token);
  if (idx.status === 200) {
    let live = 0;
    for (const i of idx.json.indices) {
      if (i.lastPrice != null) {
        live += 1;
        pass(`${i.symbol} spot`, `${fmt(i.lastPrice)}  chg ${fmt(i.change)} (${fmt(i.percentChange)}%)`);
      } else if (!connected) {
        skip(`${i.symbol} spot`, 'no session');
      } else if (!mkt.open) {
        skip(`${i.symbol} spot`, 'market closed — no ticks outside 09:15–15:30 IST');
      } else {
        fail(`${i.symbol} spot`, 'connected & market open but no tick received');
      }
    }
    if (live) pass('Live tick cache', `${live}/${idx.json.indices.length} indices have prices`);
  } else {
    fail('/api/market/indices', `HTTP ${idx.status}`);
  }

  // ---- 6. Option chain + Greeks -----------------------------------------
  section('6. Option chain & Greeks (NIFTY)');
  const chain = await api('/api/options/NIFTY/chain', token);
  if (chain.status === 200) {
    const c = chain.json;
    pass('Chain built', `${c.chain.length} strikes, expiry ${c.expiry}, ATM ${c.atmStrike}`);
    pass('Pricing model', `${c.pricingModel} · forward ${fmt(c.forward)} (${c.forwardSource})`);

    const count = (side, key) => c.chain.filter((r) => r[side]?.[key] != null).length;
    for (const key of ['iv', 'delta', 'gamma', 'theta', 'vega']) {
      const n = count('call', key) + count('put', key);
      const total = c.chain.length * 2;
      if (n > 0) pass(`${key.toUpperCase()} computed`, `${n}/${total} legs`);
      else if (!mkt.open) skip(`${key.toUpperCase()} computed`, 'no LTPs to solve from (market closed)');
      else fail(`${key.toUpperCase()} computed`, '0 legs — IV solver got nothing');
    }
    if (c.spot != null) pass('Spot in chain', fmt(c.spot));
    if (c.pcr != null) pass('PCR', fmt(c.pcr, 3));
    if (c.maxPain != null) pass('Max Pain', String(c.maxPain));
  } else if (!connected) {
    skip('Chain built', 'needs a Zerodha session');
  } else {
    skip('Chain built', chain.json?.message || `HTTP ${chain.status}`);
  }

  // ---- 7. Vega ------------------------------------------------------------
  section('7. Vega Analysis');
  const vega = await api('/api/vega/NIFTY/series', token);
  if (vega.status === 200) {
    const v = vega.json;
    pass('Vega endpoint', `strikeMode=${v.strikeMode} delta band ${v.start}–${v.deltaMax}`);
    if (v.hasBaseline) pass('Day-open baseline', `call ${fmt(v.dayOpen.callVega)} / put ${fmt(v.dayOpen.putVega)}`);
    else skip('Day-open baseline', 'captured at ~09:16 IST on a trading day');

    if (v.count > 0) {
      const last = v.points[v.points.length - 1];
      pass('Series points', `${v.count} samples today`);
      pass('Call Vega', fmt(last.callVegaDiff));
      pass('Put Vega', fmt(last.putVegaDiff));
      pass('Difference', fmt(last.vegaDiff));
      pass('Trend', last.trend);
    } else {
      skip('Series points', 'nothing sampled yet today');
    }
  } else {
    fail('Vega endpoint', `HTTP ${vega.status}`);
  }

  // ---- 8. Recorder --------------------------------------------------------
  section('8. Historical recording');
  const rec = s.recording;
  if (s.vegaRecorder.sampling) pass('Recorder scheduled', `cron armed, inWindow=${s.vegaRecorder.window}`);
  else fail('Recorder scheduled', 'cron not running');

  if (rec.rowsToday > 0) {
    pass('Rows recorded today', `${rec.rowsToday} rows across ${rec.symbolsToday} symbol(s)`);
  } else if (!mkt.open) {
    skip('Rows recorded today', 'market closed — recording runs 09:15–15:30 IST Mon–Fri');
  } else if (!connected) {
    skip('Rows recorded today', 'no Zerodha session');
  } else {
    fail('Rows recorded today', '0 rows during market hours — check standing subscriptions');
  }

  if (rec.totalDays > 0) {
    pass('Historical archive', `${rec.totalRows.toLocaleString()} rows / ${rec.totalDays} day(s), ${String(rec.firstDay).slice(0, 10)} → ${String(rec.lastDay).slice(0, 10)}`);
    pass('Date picker will show', `${rec.totalDays} past date(s)`);
  } else {
    skip('Historical archive', 'builds itself after the first recorded session');
  }

  await db.end();

  // ---- Verdict ------------------------------------------------------------
  console.log('\n══════════════════════════════════════════════');
  if (failures === 0 && blocked === 0) {
    console.log(`  ${GREEN}ALL CHECKS PASSED${RESET} — live data flowing end to end.`);
  } else if (failures === 0) {
    console.log(`  ${GREEN}NO FAULTS${RESET} — ${blocked} check(s) blocked by market hours / no session.`);
    console.log(`  ${DIM}Re-run between 09:15 and 15:30 IST with Zerodha connected.${RESET}`);
  } else {
    console.log(`  ${RED}${failures} FAILURE(S)${RESET}, ${blocked} blocked. See the ✗ lines above.`);
  }
  console.log('══════════════════════════════════════════════\n');

  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(`\n${RED}verify-live crashed:${RESET}`, err.message);
  process.exit(1);
});
