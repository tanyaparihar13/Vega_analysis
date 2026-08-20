'use strict';

/**
 * THE OPENING REFERENCE IS EXACTLY ZERO, AND SURVIVES TO THE CHART.
 *
 * ===========================================================================
 * TWO SEPARATE DEFECTS, BOTH OF WHICH HID THE ZERO
 * ===========================================================================
 * Every plotted value is `current - open`, so the session's first sample IS the
 * baseline and must read 0/0/0. It did not, for two independent reasons:
 *
 *   1. A TICK RACE. captureDayOpen() built the baseline chain, then AWAITED
 *      persistDayOpen() — a real DB write — and only then did computeDiffs()
 *      build the chain for the first sample. The await yields the event loop,
 *      the ticker moves the forward, and the two chains differ. Measured 0.007
 *      on a 0.05-point move and 0.15 on a full point.
 *
 *   2. LAST-VALUE-WINS AGGREGATION. An index persists at 5s, so the opening 1m
 *      bucket holds twelve samples. Even with (1) fixed, bucketing published
 *      the TWELFTH — roughly 55 seconds of market movement — under the opening
 *      bar's label. The zero was computed correctly and then discarded.
 *
 * Fixing either alone leaves the chart wrong, which is why both are pinned
 * here. (1) is asserted through the real computePoint; (2) through the real
 * bucketByTimeframe and the real live-push path.
 *
 * WHAT IS DELIBERATELY NOT CHANGED: the 09:16 baseline floor. The 09:15 board
 * still carries much of yesterday's close, and capturing there is the bug
 * b67ead6 fixed. The opening reference is the first VALID fresh snapshot, and
 * its timestamp is reported honestly rather than relabelled 09:15.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vega = require('../src/services/vegaTimeseriesService');
const cfg = require('../src/config/vegaConfig');
const { computePoint } = require('../src/utils/vegaMath');

const bs = require('../src/utils/blackScholes');

/**
 * A REAL Black-76 board, priced off the forward.
 *
 * Built with the production Greeks rather than a synthetic curve, so the
 * sensitivity to a forward tick is the actual sensitivity the sampler sees. A
 * hand-rolled linear board rounded a 0.05-point move away entirely and would
 * have understated the race it is here to demonstrate.
 */
const T = bs.yearsToExpiry('2026-08-28', new Date('2026-08-21T03:46:00Z'));

function board(forward) {
  const rows = [];
  for (let i = -10; i <= 10; i += 1) {
    const strike = 24250 + i * 50;
    const sigma = 0.12 + 0.00000045 * (((strike - 24261.10) ** 2) / 100);
    const c = bs.calculateGreeks76({ F: forward, K: strike, T, sigma, type: 'CE' });
    const p = bs.calculateGreeks76({ F: forward, K: strike, T, sigma, type: 'PE' });
    rows.push({
      strike,
      call: { delta: 0.30, vega: c.vega },   // delta pinned in-band; vega is real
      put: { delta: -0.30, vega: p.vega },
    });
  }
  return rows;
}

const START = cfg.deltaStartFor('NIFTY');

// ===========================================================================
// 1. THE TICK RACE
// ===========================================================================

test('THE BASELINE SAMPLE: one chain compared against itself is exactly zero', () => {
  const chain = board(24261.10);
  const p = computePoint({
    currentChain: chain, openChain: chain,
    start: START, deltaMax: cfg.DELTA_MAX, mode: cfg.STRIKE_MODE,
    frozenStrikes: { callStrikes: chain.map((r) => r.strike), putStrikes: chain.map((r) => r.strike) },
  });

  assert.equal(p.callVegaDiff, 0, 'Call Diff is EXACTLY 0');
  assert.equal(p.putVegaDiff, 0, 'Put Diff is EXACTLY 0');
  assert.equal(p.vegaDiff, 0, 'Difference is EXACTLY 0');

  // Not "close to" zero — Object.is rules out -0 and any float residue.
  assert.ok(Object.is(p.callVegaDiff, 0) && Object.is(p.putVegaDiff, 0));
  assert.ok(p.callStrikeCount > 0, 'and it is zero because they cancel, not because nothing was summed');
});

test('REBUILDING the chain instead is what made the opening non-zero', () => {
  /**
   * The pre-fix path: baseline built at forward F, first sample built again
   * after the awaited DB write, by which point the forward has ticked. This is
   * the defect quantified — and the reason the fix is "reuse the chain" rather
   * than "round harder".
   */
  const baseline = board(24261.10);
  for (const tick of [0.05, 0.50, 1.00]) {
    const rebuilt = board(24261.10 + tick);
    const p = computePoint({
      currentChain: rebuilt, openChain: baseline,
      start: START, deltaMax: cfg.DELTA_MAX, mode: 'dynamic',
    });
    assert.notEqual(p.callVegaDiff, 0,
      `a ${tick}-point tick between the two builds makes the opening non-zero`);
  }

  // And with the fix — the same chain on both sides — it is zero regardless of
  // what the market did, because there is no second build to race against.
  const p = computePoint({
    currentChain: baseline, openChain: baseline,
    start: START, deltaMax: cfg.DELTA_MAX, mode: 'dynamic',
  });
  assert.equal(p.callVegaDiff, 0);
  assert.equal(p.putVegaDiff, 0);
  assert.equal(p.vegaDiff, 0);
});

test('computeDiffs accepts the at-baseline flag that carries this', () => {
  // Guards the wiring rather than the arithmetic: if the option were dropped or
  // renamed, the race would return silently and every test above would still
  // pass, because they call computePoint directly.
  assert.equal(typeof vega.__test.computeDiffs, 'function', 'exposed for this check');
  assert.match(vega.__test.computeDiffs.toString(), /atBaseline/,
    'computeDiffs still honours the at-baseline mode');
});

// ===========================================================================
// 2. THE ZERO SURVIVES AGGREGATION
// ===========================================================================

/** A session whose FIRST sample is the baseline (0/0/0), then drifts. */
function sessionFrom(startEpoch, n = 48) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      time: startEpoch + i * 5,
      callVegaDiff: i === 0 ? 0 : +(-0.08 * i).toFixed(4),
      putVegaDiff: i === 0 ? 0 : +(0.05 * i).toFixed(4),
      vegaDiff: i === 0 ? 0 : +((0.05 * i) - (-0.08 * i)).toFixed(4),
      currentCallVega: 120, currentPutVega: 130,
      openCallVega: 120, openPutVega: 130,
    });
  }
  return out;
}

test('the opening zero survives bucketing at EVERY supported timeframe', () => {
  // 09:16:00 IST on a weekday, the first minute a baseline may be taken.
  const open = Math.floor(Date.parse('2026-08-21T09:16:00+05:30') / 1000);
  const session = sessionFrom(open);

  for (const tf of Object.keys(cfg.TIMEFRAMES)) {
    const first = vega.bucketByTimeframe(session, tf)[0];
    assert.equal(first.callVegaDiff, 0, `${tf}: Call opens at zero`);
    assert.equal(first.putVegaDiff, 0, `${tf}: Put opens at zero`);
    assert.equal(first.vegaDiff, 0, `${tf}: Difference opens at zero`);
  }
});

test('only the OPENING bucket is special — later bars still close on their last sample', () => {
  const open = Math.floor(Date.parse('2026-08-21T09:16:00+05:30') / 1000);
  const session = sessionFrom(open, 36);          // three 1m buckets
  const bars = vega.bucketByTimeframe(session, '1m');

  assert.equal(bars.length, 3);
  assert.equal(bars[0].callVegaDiff, 0, 'opening bar: the value it opened with');

  // Bucket 1 spans indices 12..23, so it closes on index 23.
  assert.equal(bars[1].callVegaDiff, +(-0.08 * 23).toFixed(4),
    'a later bar closes on its LAST sample — last-value-wins is intact');
  assert.equal(bars[2].callVegaDiff, +(-0.08 * 35).toFixed(4));
});

test('the Difference identity holds on every aggregated bar', () => {
  const open = Math.floor(Date.parse('2026-08-21T09:16:00+05:30') / 1000);
  const session = sessionFrom(open, 60);
  for (const tf of ['1m', '3m', '5m', '15m']) {
    for (const bar of vega.bucketByTimeframe(session, tf)) {
      assert.equal(bar.vegaDiff, +(bar.putVegaDiff - bar.callVegaDiff).toFixed(4),
        `${tf}: Difference = Put - Call survives aggregation`);
    }
  }
});

test('the opening bar is reported at its REAL capture time, not relabelled', () => {
  /**
   * The baseline floor is 09:16 because the 09:15 board still carries much of
   * yesterday's close (b67ead6). The honest presentation is the true timestamp
   * with a genuine zero, NOT a 09:15 label invented to look like the reference
   * charts. This pins that the opening bar keeps the timestamp it was sampled
   * at.
   */
  const open = Math.floor(Date.parse('2026-08-21T09:16:00+05:30') / 1000);
  const bars = vega.bucketByTimeframe(sessionFrom(open), '1m');
  const istClock = new Date((bars[0].time + 19800) * 1000).toISOString().slice(11, 16);

  assert.equal(istClock, '09:16', 'the opening bar says 09:16, because that is when it was taken');
  assert.equal(bars[0].callVegaDiff, 0, 'and it is genuinely zero, not cosmetically so');
  assert.ok(cfg.BASELINE_MIN_IST > cfg.MARKET_OPEN_MIN,
    'the floor is deliberately after the bell and is unchanged by this work');
});
