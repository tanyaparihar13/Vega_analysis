'use strict';

/**
 * A DARK INSTRUMENT MUST NAME ITSELF.
 *
 * ===========================================================================
 * THE 2026-08-20 SENSEX STOPPAGE
 * ===========================================================================
 * SENSEX recorded 16 samples (09:15-09:30), stopped at the restart minute, and
 * produced nothing for the following six hours. Throughout, /api/health/deep
 * reported:
 *
 *     sampler: { ok: true, sampling: true, skippedTicks: 0, series: 41 }
 *
 * Every one of those numbers was true and none of them was health:
 *
 *   · `ok` was `stats.sampling` — "is the cron scheduled". It was. The cron ran
 *     perfectly and produced nothing for one instrument.
 *   · `series` counted state ENTRIES, and SENSEX still had one: loadToday()
 *     restored its morning rows from MySQL. A buffer that will never grow again
 *     is indistinguishable from a healthy one by count alone.
 *   · `skippedTicks` counts re-entrancy skips of the WHOLE sampler, not a
 *     single target failing inside a run that otherwise succeeded.
 *
 * The only trace was vlog(), throttled to once per minute per reason, in PM2's
 * log file. So the stoppage was invisible while it happened AND undiagnosable
 * afterwards, because by the time anyone looked the logs had rolled and the
 * process state was gone.
 *
 * THAT is the defect this file pins. The trigger that stopped SENSEX still
 * needs production logs to name; what must never recur is being unable to SEE
 * it. These tests assert the observable, not a guess about the cause.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vega = require('../src/services/vegaTimeseriesService');
const cfg = require('../src/config/vegaConfig');

const { state, stateKey } = vega.__test;

/** A weekday inside the sampling window, so staleTargets() is meaningful. */
function marketHours() {
  const today = vega.todayIst();
  // 11:00 IST — comfortably inside 09:15-15:30 on the current trading date.
  const at = new Date(`${today}T11:00:00+05:30`);
  return { today, at, nowSec: Math.floor(at.getTime() / 1000) };
}

/** Seed a live entry directly, as loadToday() would after a restart. */
function seed(symbol, { lastSampleAt, open = {}, points = 16 }) {
  const { today } = marketHours();
  const entry = {
    symbol, expiry: '2026-08-27', date: today, open,
    series: Array.from({ length: points }, (_, i) => ({ time: 1000 + i })),
    lastSampleAt,
  };
  state.set(stateKey(symbol, '2026-08-27'), entry);
  return entry;
}

test.beforeEach(() => { state.clear(); });
test.after(() => { state.clear(); });

// ===========================================================================
// 1. THE REGRESSION: a symbol that stops after a restart is detected
// ===========================================================================

test('THE SENSEX CASE: a symbol that stopped producing is reported stale', () => {
  const { at, nowSec } = marketHours();

  // Exactly the post-restart state: a restored buffer with a morning of points
  // and a baseline, whose last sample is hours old.
  seed('SENSEX', { lastSampleAt: nowSec - 6 * 3600, points: 16 });
  // And a healthy neighbour sampling normally, so the check discriminates.
  seed('NIFTY', { lastSampleAt: nowSec - 5, points: 4500 });

  const stale = vega.staleTargets(at);
  const names = stale.map((s) => s.symbol);

  assert.deepEqual(names, ['SENSEX'], 'the dark instrument, and only it, is named');
  assert.ok(stale[0].ageSeconds > cfg.STALE_SAMPLE_SECONDS,
    'and how long it has been dark is reported');
  assert.equal(stale[0].expiry, '2026-08-27', 'with the contract it was tracking');

  // A full buffer is NOT evidence of health — this is the specific trap that
  // made SENSEX look fine. 16 restored points and a baseline, still stale.
  assert.equal(stale[0].hasBaseline, true,
    'having a baseline does not make a silent instrument healthy');
});

test('a symbol that has NEVER sampled this session is stale too', () => {
  const { at } = marketHours();
  // captureDayOpen never succeeded, so no sample was ever appended and
  // lastSampleAt was never stamped. Left unhandled this reads as age=null and
  // would slip past a naive `age > threshold` comparison.
  seed('SENSEX', { lastSampleAt: undefined, open: null, points: 0 });

  const stale = vega.staleTargets(at);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].ageSeconds, null, 'never sampled — reported as such, not as 0');
  assert.equal(stale[0].hasBaseline, false, 'and the missing baseline is visible');
});

test('a healthy session reports nothing stale', () => {
  const { at, nowSec } = marketHours();
  for (const s of ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']) {
    seed(s, { lastSampleAt: nowSec - 5 });
  }
  assert.deepEqual(vega.staleTargets(at), [],
    'no false alarms — or the signal gets ignored when it matters');
});

test('the threshold is generous enough not to fire on one missed tick', () => {
  const { at, nowSec } = marketHours();
  // Indices persist at 5s, so 3 minutes is many missed samples — well clear of
  // a single skipped tick or a brief feed hiccup.
  assert.ok(cfg.STALE_SAMPLE_SECONDS >= 60, 'not hair-triggered');
  assert.ok(cfg.STALE_SAMPLE_SECONDS <= 600, 'and not so slack it hides a real outage');

  seed('NIFTY', { lastSampleAt: nowSec - (cfg.STALE_SAMPLE_SECONDS - 10) });
  assert.deepEqual(vega.staleTargets(at), [], 'just inside the window is not stale');

  seed('NIFTY', { lastSampleAt: nowSec - (cfg.STALE_SAMPLE_SECONDS + 10) });
  assert.equal(vega.staleTargets(at).length, 1, 'just outside it is');
});

// ===========================================================================
// 2. NO FALSE ALARMS OUTSIDE MARKET HOURS
// ===========================================================================

test('outside the sampling window nothing is stale', () => {
  const { today, nowSec } = marketHours();
  seed('SENSEX', { lastSampleAt: nowSec - 6 * 3600 });

  // 20:00 IST — every target is legitimately quiet. Reporting them all as
  // stale overnight would train whoever reads this to ignore it, which costs
  // exactly the signal this exists to provide.
  const evening = new Date(`${today}T20:00:00+05:30`);
  assert.deepEqual(vega.staleTargets(evening), [], 'quiet after the close is not a fault');

  const weekend = new Date('2026-08-22T11:00:00+05:30');   // Saturday
  assert.deepEqual(vega.staleTargets(weekend), [], 'nor is a weekend');
});

test('an entry from a previous session is not counted as today going stale', () => {
  const { at, nowSec } = marketHours();
  const stale = { symbol: 'SENSEX', expiry: '2026-08-27', date: '1999-01-01',
    open: {}, series: [], lastSampleAt: nowSec - 6 * 3600 };
  state.set(stateKey('SENSEX', '2026-08-27'), stale);

  assert.deepEqual(vega.staleTargets(at), [],
    "a leftover entry is a date-isolation concern, not a sampling alarm");
});

// ===========================================================================
// 3. THE REASON IS CAPTURED, NOT JUST THE SYMPTOM
// ===========================================================================

test('getStats reports WHY a target is silent', () => {
  const { nowSec } = marketHours();
  seed('SENSEX', { lastSampleAt: nowSec - 6 * 3600 });

  const stats = vega.getStats();
  assert.ok(Array.isArray(stats.skipped), 'skip reasons are exposed');
  assert.ok(Array.isArray(stats.stale), 'and so is the stale list');

  // Freshness is reported per target, so a silent one is visible in the
  // instrument list itself and not only in the summary.
  const sensex = stats.underlyings.find((u) => u.symbol === 'SENSEX');
  assert.ok(sensex, 'the target is listed');
  assert.equal(typeof sensex.ageSeconds, 'number', 'with how long since its last sample');
  assert.ok(sensex.ageSeconds > cfg.STALE_SAMPLE_SECONDS);
});

test('freshness is tracked on the ENTRY, not inferred from the buffer', () => {
  /**
   * The trap that hid this. appendLive() bounds the buffer, so a symbol that
   * stopped producing keeps its old tail indefinitely — deriving "last sample"
   * from series[last].time would have read SENSEX's 09:30 point and called it
   * current. lastSampleAt is stamped at append time and is the only honest
   * source.
   */
  const { at, nowSec } = marketHours();
  const entry = seed('SENSEX', { lastSampleAt: nowSec - 6 * 3600, points: 16 });

  assert.equal(entry.series.length, 16, 'the buffer still looks populated');
  assert.equal(vega.staleTargets(at).length, 1, 'and the target is still correctly stale');

  // A fresh append clears it — the signal tracks reality in both directions.
  const { appendLive } = vega.__test;
  appendLive(stateKey('SENSEX', '2026-08-27'), entry,
    { time: Math.floor(Date.parse(`${vega.todayIst()}T11:00:00+05:30`) / 1000) });
  assert.ok(entry.lastSampleAt >= nowSec - 5, 'appending stamps freshness');
});
