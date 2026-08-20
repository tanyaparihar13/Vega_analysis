'use strict';

/**
 * TRADING-DATE ISOLATION AT THE TWO BOUNDARIES THE BUFFER FIX CANNOT REACH.
 *
 * tradingDateIsolation.test.js covers the in-memory buffer: the rollover reset,
 * the stale baseline, the stale read. This file covers what sits either side of
 * it, because the guarantee is only as good as its weakest layer:
 *
 *   · loadByDate()          — the API boundary. Proves a request for one date
 *                             cannot return a point from another, INCLUDING
 *                             from a mis-stamped database row, which no SQL
 *                             WHERE clause can catch.
 *   · handleSamplerTick()   — the live push. A socket left open across midnight
 *                             is a client watching yesterday while the sampler
 *                             produces today, and the buffer is correct in both
 *                             directions the whole time.
 *   · runSample()'s ordering — the first tick of a new session used to be
 *                             computed against the PREVIOUS session's baseline
 *                             and then kept, because the guard in front of
 *                             captureDayOpen() asked whether a baseline existed
 *                             rather than whether it was THIS day's.
 *
 * It also pins the arithmetic of the original report. Reproducing 376 exactly
 * is what identifies the mechanism rather than merely a plausible-sounding one.
 *
 * DATES. Live-path tests are written against `vega.todayIst()` and offsets from
 * it, so they keep testing the rollover on every future day. Stored-path tests
 * pin literal dates, deliberately in the past so they can never be "today".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// A fake MySQL, installed BEFORE the service is required. node:test runs each
// test FILE in its own child process, so this cannot leak into another suite.
// ---------------------------------------------------------------------------
const dbPath = require.resolve('../src/config/db');
const rowsByDate = new Map();   // 'YYYY-MM-DD' -> [row]

const fakeDb = {
  async query(sql, params = {}) {
    if (/FROM vega_timeseries/.test(sql) && /DISTINCT resolution/.test(sql)) {
      const rows = rowsByDate.get(params.date) || [];
      return [[...new Set(rows.map((r) => r.resolution))].map((resolution) => ({ resolution }))];
    }
    if (/FROM vega_timeseries/.test(sql)) {
      const rows = (rowsByDate.get(params.date) || [])
        .filter((r) => (params.expiry ? r.expiry === params.expiry : true))
        .filter((r) => (params.resolution ? r.resolution === params.resolution : true));
      return [rows];
    }
    return [[]];   // vega_day_open and anything else
  },
};

function stub(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  const m = new Module(resolved, null);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
  return resolved;
}

stub('../src/config/db', fakeDb);

const sentMessages = [];
stub('../src/services/websocketService', {
  sendToClient: (client, msg) => sentMessages.push(msg),
  onDisconnect: () => {},
});

const vega = require('../src/services/vegaTimeseriesService');
const cfg = require('../src/config/vegaConfig');
const stream = require('../src/services/vegaStreamService');

const { state, stateKey } = vega.__test;
const { handleSamplerTick, sessions } = stream.__test;

const SYMBOL = 'NIFTY';
const EXPIRY = '2026-08-25';

/** UNIX seconds for HH:MM:SS IST on a given YYYY-MM-DD. */
function istTime(date, hh, mm, ss = 0) {
  return Math.floor(Date.parse(`${date}T${String(hh).padStart(2, '0')}:`
    + `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}+05:30`) / 1000);
}

/** `n` days before `date`, as YYYY-MM-DD. */
function daysBefore(date, n) {
  return new Date(Date.parse(`${date}T00:00:00Z`) - n * 86400e3).toISOString().slice(0, 10);
}

/** A stored vega_timeseries row, as mysql2 returns it with dateStrings:true. */
function storedRow(sampledAtUnix, over = {}) {
  return {
    sampled_at: new Date(sampledAtUnix * 1000).toISOString().slice(0, 19).replace('T', ' '),
    call_vega_diff: 1, put_vega_diff: 2, vega_diff: 1,
    current_call_vega: 10, current_put_vega: 20,
    open_call_vega: 9, open_put_vega: 18,
    price: 24000, atm_strike: 24000,
    call_strike_count: 12, put_strike_count: 12,
    expiry: EXPIRY, resolution: '1m',
    ...over,
  };
}

const datesIn = (points) => [...new Set(points.map((p) => vega.tradingDateOf(p)))].sort();

test.beforeEach(() => { rowsByDate.clear(); sentMessages.length = 0; sessions.clear(); });

// ===========================================================================
// 1. THE ORIGINAL REPORT, REPRODUCED EXACTLY
// ===========================================================================

test('THE SCREENSHOT: 376 records, 372 from yesterday and 4 from today', () => {
  const today = vega.todayIst();
  const yesterday = daysBefore(today, 1);

  // Rebuild the pre-fix array: a full previous session, then this morning's
  // samples appended onto it because nothing reset the entry at midnight.
  const series = [];
  for (let t = istTime(yesterday, 9, 15); t <= istTime(yesterday, 15, 30); t += 5) {
    series.push({ time: t, callVegaDiff: -1, putVegaDiff: 1, vegaDiff: 2 });
  }
  assert.equal(series.length, 4501, 'a full 5s index session is 4501 samples');

  for (let t = istTime(today, 9, 15); t <= istTime(today, 9, 18, 50); t += 5) {
    series.push({ time: t, callVegaDiff: -1, putVegaDiff: 1, vegaDiff: 2 });
    const overflow = series.length - cfg.LIVE_BUFFER_POINTS;
    if (overflow > 0) series.splice(0, overflow);       // appendLive's bound
  }
  assert.equal(series.length, cfg.LIVE_BUFFER_POINTS, 'the buffer is full to its cap');

  const buckets = vega.bucketByTimeframe(series, '1m');
  assert.equal(buckets.length, 376, 'reproduces the 376 records the UI reported');
  assert.equal(buckets.filter((p) => vega.tradingDateOf(p) === yesterday).length, 372);
  assert.equal(buckets.filter((p) => vega.tradingDateOf(p) === today).length, 4);

  // The table renders newest-first, which is the screenshot verbatim.
  const clock = (p) => new Date((p.time + 5.5 * 3600) * 1000).toISOString().slice(11, 16);
  assert.deepEqual([...buckets].reverse().slice(0, 7).map(clock),
    ['09:18', '09:17', '09:16', '09:15', '15:30', '15:29', '15:28'],
    'PRE-FIX: exactly the mixed table in the bug report');
});

// ===========================================================================
// 2. THE API BOUNDARY
// ===========================================================================

test('requesting one date returns ZERO points from the other, both directions', async () => {
  const d1 = '2026-06-18';
  const d2 = '2026-06-19';

  rowsByDate.set(d1, [
    storedRow(istTime(d1, 15, 28)), storedRow(istTime(d1, 15, 29)), storedRow(istTime(d1, 15, 30)),
  ]);
  rowsByDate.set(d2, [
    storedRow(istTime(d2, 9, 15)), storedRow(istTime(d2, 9, 16)),
    storedRow(istTime(d2, 9, 17)), storedRow(istTime(d2, 9, 18)),
  ]);

  const a = await vega.loadByDate(SYMBOL, d2, '1m', EXPIRY);
  assert.equal(a.points.length, 4);
  assert.deepEqual(datesIn(a.points), [d2], `requesting ${d2} must return zero ${d1} points`);
  assert.equal(a.tradingDate, d2, 'the payload states the session it describes');

  const b = await vega.loadByDate(SYMBOL, d1, '1m', EXPIRY);
  assert.equal(b.points.length, 3);
  assert.deepEqual(datesIn(b.points), [d1], `requesting ${d1} must return zero ${d2} points`);

  // Switching back must not resurrect anything — the read is stateless per call.
  const again = await vega.loadByDate(SYMBOL, d2, '1m', EXPIRY);
  assert.deepEqual(datesIn(again.points), [d2], 'switching back stays clean');
});

test('a MIS-STAMPED database row is refused, not served', async () => {
  const d1 = '2026-06-18';
  const d2 = '2026-06-19';

  // Deliberately corrupt: an 18-Jun sample filed under snapshot_date 19-Jun.
  // No SQL WHERE clause can catch this — only comparing the row's TIMESTAMP
  // against the requested session can, which is what makes the guarantee a
  // property of the API rather than of the recorder having always been right.
  rowsByDate.set(d2, [
    storedRow(istTime(d1, 15, 30)),
    storedRow(istTime(d2, 9, 15)),
    storedRow(istTime(d2, 9, 16)),
  ]);

  const res = await vega.loadByDate(SYMBOL, d2, '1m', EXPIRY);
  assert.equal(res.points.length, 2, 'the foreign row is dropped');
  assert.deepEqual(datesIn(res.points), [d2]);
});

test('expiry does not determine the trading date', async () => {
  const d = '2026-06-19';
  // Every row expires 2026-08-25 but was SAMPLED on 2026-06-19. The dataset
  // must be filed under the sample date, and the expiry must survive on the
  // points untouched — two separate axes, neither deriving the other.
  rowsByDate.set(d, [storedRow(istTime(d, 9, 15)), storedRow(istTime(d, 9, 16))]);

  const res = await vega.loadByDate(SYMBOL, d, '1m', EXPIRY);
  assert.notEqual(d, EXPIRY, 'the two concepts are genuinely different here');
  assert.deepEqual(datesIn(res.points), [d], 'filed under the SAMPLE date');
  assert.deepEqual([...new Set(res.points.map((p) => p.expiry))], [EXPIRY],
    'and the expiry rides along, unaffected by the date filter');
  assert.equal(res.tradingDate, d);
});

// ===========================================================================
// 3. IST BOUNDARIES
// ===========================================================================

test('the 09:15 open and 15:30 close land on the correct trading date', () => {
  // The session (09:15-15:30 IST = 03:45-10:00 UTC) sits inside one UTC day,
  // which is what makes the date of a sample unambiguous.
  assert.equal(vega.tradingDateOf({ time: istTime('2026-08-20', 9, 15) }), '2026-08-20');
  assert.equal(vega.tradingDateOf({ time: istTime('2026-08-20', 15, 30) }), '2026-08-20');
  assert.equal(vega.tradingDateOf({ time: istTime('2026-08-19', 15, 30) }), '2026-08-19');

  // One second before the 20th begins in IST is still the 19th.
  assert.equal(vega.tradingDateOf({ time: istTime('2026-08-20', 0, 0) - 1 }), '2026-08-19');
  assert.equal(vega.tradingDateOf({ time: istTime('2026-08-20', 0, 0) }), '2026-08-20');
});

test('a bucket never spans two trading dates, at any timeframe', () => {
  const today = vega.todayIst();
  const yesterday = daysBefore(today, 1);

  // Boundaries are absolute against the epoch and 60/300/900/3600 all divide a
  // day, so no bucket can straddle midnight and blend two sessions into one bar.
  for (const tf of ['1m', '5m', '15m', '1h']) {
    const close = vega.bucketStartFor(istTime(yesterday, 15, 30), tf);
    const open = vega.bucketStartFor(istTime(today, 9, 15), tf);
    assert.notEqual(close, open, `${tf}: the close and the next open are different buckets`);
    assert.equal(vega.tradingDateOf({ time: close }), yesterday);
    assert.equal(vega.tradingDateOf({ time: open }), today);
  }
});

// ===========================================================================
// 4. THE LIVE PUSH
// ===========================================================================

test('the live push refuses a point from another trading date', () => {
  const today = vega.todayIst();
  const yesterday = daysBefore(today, 1);
  const client = { readyState: 1, send: () => {} };
  const point = { time: istTime(today, 9, 15), callVegaDiff: -1, putVegaDiff: 1, vegaDiff: 2 };

  // A terminal left open across midnight: the session still names yesterday
  // while the sampler has moved on to today.
  sessions.set(client, {
    symbol: SYMBOL, expiry: EXPIRY, timeframe: '1m', tradingDate: yesterday, lastBucket: null,
  });
  handleSamplerTick([{ symbol: SYMBOL, expiry: EXPIRY, point }]);
  assert.equal(sentMessages.length, 0,
    "today's point must not be pushed into a chart showing yesterday");

  // The same client resubscribed for today receives it — the guard rejects by
  // DATE, and must not be quietly breaking the live stream outright.
  sessions.set(client, {
    symbol: SYMBOL, expiry: EXPIRY, timeframe: '1m', tradingDate: today, lastBucket: null,
  });
  handleSamplerTick([{ symbol: SYMBOL, expiry: EXPIRY, point }]);
  assert.equal(sentMessages.length, 1, 'a matching date still streams normally');
  assert.equal(sentMessages[0].type, 'vega_point');
  assert.equal(sentMessages[0].tradingDate, today, 'every push names the day it belongs to');
});

// ===========================================================================
// 5. THE FIRST TICK OF A NEW SESSION
// ===========================================================================

test('the first tick of a new session does not reuse the previous baseline', async () => {
  /**
   * runSample() guarded captureDayOpen() with `if (!state.get(key)?.open)` —
   * which is false precisely when the held baseline is STALE, so the one
   * function containing the rollover reset was skipped exactly when it was
   * needed. computeDiffs() then measured the new day's first sample against the
   * previous day's chain, and appendLive() reset the buffer but KEPT that
   * point, which was persisted too: a today-dated row that no date filter can
   * catch, because its timestamp really is today's.
   *
   * The guard now asks about the DATE as well. A far-future expiry is used so
   * no live target can collide; captureDayOpen cannot complete without a chain
   * for it, but the reset runs before any chain work — that is the point.
   */
  const FAR = '2099-12-31';
  const key = stateKey(SYMBOL, FAR);
  const stale = daysBefore(vega.todayIst(), 1);

  state.set(key, {
    symbol: SYMBOL,
    expiry: FAR,
    date: stale,
    open: { date: stale, chain: [{ strike: 1, call: {}, put: {} }] },
    series: [{ time: istTime(stale, 15, 30), callVegaDiff: -3 }],
  });

  try {
    // THE REAL PREDICATE runSample evaluates, not a copy of it. Pre-fix the
    // condition was `!entry?.open` alone, which is FALSE here — a baseline
    // exists, it just belongs to another day — so the capture was skipped and
    // the stale chain was used.
    assert.equal(vega.needsDayOpenCapture(state.get(key)), true,
      'a stale baseline must still route into captureDayOpen');

    // The same predicate must NOT force a re-capture within a live session,
    // or the baseline stops being immutable and the whole curve shifts.
    assert.equal(
      vega.needsDayOpenCapture({ date: vega.todayIst(), open: { date: vega.todayIst() } }),
      false, "today's baseline is still taken once and held");
    assert.equal(vega.needsDayOpenCapture({ date: vega.todayIst(), open: null }), true,
      'and a session that has no baseline yet still captures one');

    await vega.captureDayOpen(SYMBOL, FAR).catch(() => {});

    const after = state.get(key);
    assert.equal(after.open, null, "the previous session's baseline is cleared");
    assert.equal(after.series.length, 0, "and its buffer with it");
    assert.notEqual(after.date, stale, 'the slot now belongs to the current session');
  } finally {
    state.delete(key);
  }
});
