'use strict';

/**
 * A MID-SESSION REDEPLOY MUST NOT RE-ANCHOR THE DAY.
 *
 * This is the deployment-safety question for 60f36d4, and it is not obvious
 * from reading the diff. Restarting the process during market hours runs
 * loadToday(), which rebuilds the live state from MySQL. If that restore failed
 * to bring the day-open baseline back, the sampler would find no baseline,
 * capture a fresh one from the board in front of it, and put a SECOND
 * discontinuity into a session that already has one — turning a deploy that was
 * meant to fix the anchor into another instance of the bug.
 *
 * It does not, and this pins why: vega_day_open is written once per
 * {date, symbol, expiry} and is immutable (ON DUPLICATE KEY UPDATE
 * snapshot_date = snapshot_date), loadToday() restores it, and
 * needsDayOpenCapture() therefore answers false.
 *
 * Modelled on the REAL 2026-08-20 production state: a baseline row captured at
 * 04:00 UTC (09:30 IST) after that morning's restart, plus a session's worth of
 * timeseries rows. That day is the reason this test exists, so it is the state
 * the test is written against.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const TODAY = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const LATE_CAPTURE_UTC = `${TODAY} 04:00:00`;          // 09:30 IST
const EXPIRY = '2026-08-25';

/** The archived open chain, as vega_day_open stores it. */
const OPEN_CHAIN = JSON.stringify([
  { strike: 24250, call: { vega: 11.5, delta: 0.51 }, put: { vega: 11.5, delta: -0.48 } },
  { strike: 24300, call: { vega: 11.4, delta: 0.45 }, put: { vega: 11.4, delta: -0.54 } },
]);

const dbPath = require.resolve('../src/config/db');
const stub = new Module(dbPath, null);
stub.filename = dbPath;
stub.loaded = true;
stub.exports = {
  async query(sql, params = {}) {
    if (/FROM vega_day_open/.test(sql)) {
      if (params.today !== TODAY && params.date !== TODAY) return [[]];
      return [[{
        snapshot_date: TODAY, symbol: 'NIFTY', expiry: EXPIRY,
        captured_at: LATE_CAPTURE_UTC,
        open_chain: OPEN_CHAIN, call_strikes: '[24250,24300]', put_strikes: '[24250,24300]',
      }]];
    }
    if (/FROM vega_timeseries/.test(sql)) {
      if (params.today !== TODAY && params.date !== TODAY) return [[]];
      const rows = [];
      // 09:15 IST (03:45 UTC) onward — including the pre-restart rows that
      // carry the stale-baseline values.
      for (let i = 0; i < 40; i += 1) {
        const t = Date.parse(`${TODAY}T03:45:00Z`) + i * 60000;
        rows.push({
          snapshot_date: TODAY, symbol: 'NIFTY', expiry: EXPIRY, resolution: '1m',
          sampled_at: new Date(t).toISOString().slice(0, 19).replace('T', ' '),
          call_vega_diff: 1, put_vega_diff: 2, vega_diff: 1,
          current_call_vega: 10, current_put_vega: 20,
          open_call_vega: 88.89, open_put_vega: 94.36,
          price: 24261, atm_strike: 24250, call_strike_count: 12, put_strike_count: 13,
        });
      }
      return [rows];
    }
    return [[]];
  },
};
require.cache[dbPath] = stub;

const vega = require('../src/services/vegaTimeseriesService');
const { state, stateKey } = vega.__test;

test('restoring mid-session brings the baseline back instead of taking a new one', async () => {
  state.clear();
  await vega.loadToday();

  const entry = state.get(stateKey('NIFTY', EXPIRY));
  assert.ok(entry, 'the slot is restored');
  assert.equal(entry.date, TODAY, 'stamped with the session it belongs to');
  assert.ok(entry.open, 'THE BASELINE IS RESTORED FROM vega_day_open, not re-captured');
  assert.ok(entry.series.length > 0, 'and the session so far is buffered');

  /**
   * THE DEPLOYMENT-SAFETY ASSERTION.
   *
   * False here means the sampler leaves the existing anchor alone. A deploy at
   * 10:00 therefore continues the series from the same origin it had at 09:59 —
   * no second step, no third anchor. True would mean every redeploy re-origins
   * the chart, which is the bug wearing a different hat.
   */
  assert.equal(vega.needsDayOpenCapture(entry), false,
    'a restored, current-session baseline is kept — a redeploy does not re-anchor the day');
});

test('the restored buffer holds exactly one trading date', async () => {
  state.clear();
  await vega.loadToday();
  const entry = state.get(stateKey('NIFTY', EXPIRY));
  const dates = [...new Set(entry.series.map((p) => vega.tradingDateOf(p)))];
  assert.deepEqual(dates, [TODAY], 'restore cannot reintroduce a foreign session');
});

test('the restored anchor is reported as late rather than passed off as the open', async () => {
  state.clear();
  await vega.loadToday();

  // The row says 09:30. Nothing rewrites it — the value is preserved exactly as
  // recorded — but every reader can now see what it is.
  const verdict = vega.baselineLateness(LATE_CAPTURE_UTC);
  assert.equal(verdict.late, true);
  assert.equal(verdict.capturedAtIst, '09:30');
  assert.equal(verdict.minutesAfterOpen, 15);

  // And the same derivation on a normal 09:16 capture stays silent, so the
  // warning means something when it does appear.
  assert.equal(vega.baselineLateness(`${TODAY} 03:46:00`).late, false);
});
