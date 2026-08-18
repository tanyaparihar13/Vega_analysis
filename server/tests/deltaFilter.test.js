'use strict';

/**
 * DELTA FILTERING — which contracts enter the Vega totals.
 *
 * The rule is stated once, in vegaMath.passes():
 *
 *     abs(delta) >= start  AND  abs(delta) <= deltaMax
 *
 * INCLUSIVE at both ends (>= and <=, never > or <), on the ABSOLUTE value so a
 * single band applies symmetrically to a positive call delta and a negative put
 * delta. These tests pin every one of those properties, because each is a
 * one-character change away from silently altering which contracts are summed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { passes, pickStrikes, computePoint } = require('../src/utils/vegaMath');
const cfg = require('../src/config/vegaConfig');
const vega = require('../src/services/vegaTimeseriesService');

const START = 0.05;
const MAX = 0.60;

test('boundary table: inclusive at both ends, for CE and PE', () => {
  const cases = [
    // delta,  expected
    [0.0400, false], [0.0499, false],
    [0.0500, true],  // the floor itself is IN
    [0.0501, true], [0.0600, true], [0.1000, true], [0.2000, true],
    [0.3000, true], [0.4000, true], [0.5000, true], [0.5900, true],
    [0.6000, true],  // the ceiling itself is IN
    [0.6001, false], [0.6100, false], [0.7000, false], [0.9000, false],
  ];

  const rows = [];
  for (const [d, expected] of cases) {
    const call = passes(d, START, MAX);        // call delta is positive
    const put = passes(-d, START, MAX);        // put delta is negative
    rows.push(`  ${String(d.toFixed(4)).padStart(7)} | CE | ${String(call).padEnd(5)} | ${String(expected).padEnd(5)} | ${call === expected ? 'PASS' : 'FAIL'}`);
    rows.push(`  ${String((-d).toFixed(4)).padStart(7)} | PE | ${String(put).padEnd(5)} | ${String(expected).padEnd(5)} | ${put === expected ? 'PASS' : 'FAIL'}`);
    assert.equal(call, expected, `CE delta ${d}`);
    assert.equal(put, expected, `PE delta ${-d} (abs must be used)`);
  }
  console.log('\n    DELTA  | TYPE | ACTUAL | EXPECT | RESULT');
  console.log('  ---------|------|--------|--------|-------');
  console.log(rows.join('\n'));
});

test('a strike outside the band is NEVER summed', () => {
  const chain = [
    { strike: 23000, call: { delta: 0.90, vega: 100 }, put: { delta: -0.10, vega: 100 } },
    { strike: 23500, call: { delta: 0.60, vega: 200 }, put: { delta: -0.40, vega: 200 } },
    { strike: 24000, call: { delta: 0.50, vega: 300 }, put: { delta: -0.50, vega: 300 } },
    { strike: 24500, call: { delta: 0.05, vega: 400 }, put: { delta: -0.95, vega: 400 } },
    { strike: 25000, call: { delta: 0.01, vega: 500 }, put: { delta: -0.99, vega: 500 } },
  ];
  const { callStrikes, putStrikes } = pickStrikes(chain, START, MAX);

  assert.deepEqual(callStrikes, [23500, 24000, 24500], 'call side: 0.90 and 0.01 excluded');
  assert.deepEqual(putStrikes, [23000, 23500, 24000], 'put side: -0.95 and -0.99 excluded');

  const point = computePoint({ currentChain: chain, openChain: chain, start: START, deltaMax: MAX, mode: 'dynamic' });
  assert.equal(point.callStrikeCount, 3);
  assert.equal(point.putStrikeCount, 3);
  // 200 + 300 + 400 = 900 — the 0.90 and 0.01 deltas contribute nothing.
  assert.equal(point.currentCallVega, 900, 'only in-band call vega is summed');
  assert.equal(point.currentPutVega, 600, '100 + 200 + 300');
});

test('a null or non-finite delta is excluded, not treated as zero', () => {
  assert.equal(passes(null, START, MAX), false);
  assert.equal(passes(undefined, START, MAX), false);
  assert.equal(passes(NaN, START, MAX), false);
  assert.equal(passes(Infinity, START, MAX), false);
  assert.equal(passes('not a number', START, MAX), false);
});

test('a null vega SKIPS the strike rather than zero-filling it', () => {
  const open = [{ strike: 24000, call: { delta: 0.5, vega: null }, put: { delta: -0.5, vega: 300 } }];
  const now = [{ strike: 24000, call: { delta: 0.5, vega: 250 }, put: { delta: -0.5, vega: 280 } }];

  const point = computePoint({ currentChain: now, openChain: open, start: START, deltaMax: MAX, mode: 'dynamic' });
  // Call side: open vega is unknown, so the strike contributes to NEITHER sum.
  // Zero-filling would have produced 250 - 0 = +250, a fabricated positive.
  assert.equal(point.callStrikeCount, 0, 'call strike skipped entirely');
  assert.equal(point.currentCallVega, 0);
  assert.equal(point.callVegaDiff, 0);
  // Put side is fully solvable and is summed normally.
  assert.equal(point.putStrikeCount, 1);
  assert.equal(point.putVegaDiff, -20, '280 - 300');
});

test('a strike must exist in BOTH the current and the day-open chain', () => {
  const open = [{ strike: 24000, call: { delta: 0.5, vega: 100 }, put: { delta: -0.5, vega: 100 } }];
  const now = [
    { strike: 24000, call: { delta: 0.5, vega: 120 }, put: { delta: -0.5, vega: 90 } },
    { strike: 24500, call: { delta: 0.3, vega: 500 }, put: { delta: -0.7, vega: 500 } },
  ];
  const point = computePoint({ currentChain: now, openChain: open, start: START, deltaMax: MAX, mode: 'dynamic' });
  assert.equal(point.callStrikeCount, 1, '24500 has no baseline and must not spike the diff');
  assert.equal(point.callVegaDiff, 20, '120 - 100');
});

test('string and numeric strike keys match (loose-vs-strict regression)', () => {
  const open = [{ strike: '24000', call: { delta: 0.5, vega: 100 }, put: { delta: -0.5, vega: 100 } }];
  const now = [{ strike: 24000, call: { delta: 0.5, vega: 130 }, put: { delta: -0.5, vega: 80 } }];
  const point = computePoint({ currentChain: now, openChain: open, start: START, deltaMax: MAX, mode: 'dynamic' });
  assert.equal(point.callVegaDiff, 30, 'a type mismatch must not silently produce 0.00');
  assert.equal(point.putVegaDiff, -20);
});

test('diff3 = diff2 - diff1 exactly', () => {
  const open = [
    { strike: 24000, call: { delta: 0.5, vega: 100 }, put: { delta: -0.5, vega: 200 } },
    { strike: 24500, call: { delta: 0.3, vega: 50 }, put: { delta: -0.7, vega: 60 } },
  ];
  const now = [
    { strike: 24000, call: { delta: 0.5, vega: 137.25 }, put: { delta: -0.5, vega: 181.5 } },
    { strike: 24500, call: { delta: 0.3, vega: 44.75 }, put: { delta: -0.55, vega: 71.25 } },
  ];
  const p = computePoint({ currentChain: now, openChain: open, start: START, deltaMax: MAX, mode: 'dynamic' });
  assert.equal(p.vegaDiff, Number((p.putVegaDiff - p.callVegaDiff).toFixed(4)));
});

test('the delta floor is one definition, shared by the engine and the chain payload', () => {
  // vegaTimeseriesService.startFor delegates to vegaConfig.deltaStartFor, and
  // optionChainService emits deltaStartFor() as `deltaBand.start`. If these ever
  // diverge again, the chain table and the Vega sums show different baskets.
  for (const symbol of ['NIFTY', 'SENSEX', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'RELIANCE', 'TATASTEEL']) {
    assert.equal(vega.startFor(symbol), cfg.deltaStartFor(symbol), `${symbol}: one floor`);
  }
  assert.equal(cfg.deltaStartFor('NIFTY'), 0.05);
  assert.equal(cfg.deltaStartFor('BANKNIFTY'), 0.20);
  assert.equal(cfg.deltaStartFor('RELIANCE'), cfg.STOCK_START);
  assert.equal(cfg.deltaStartFor('RELIANCE'), 0.20, 'stocks run the 0.20-0.60 band, not 0.05');
});

test('the client filter reproduces the server rule byte for byte', () => {
  // client/src/features/optionChain/OptionChainTable.jsx :: passes()
  const clientPasses = (delta, band) => {
    if (delta == null) return false;
    const d = Math.abs(Number(delta));
    return Number.isFinite(d) && d >= band.start && d <= band.max;
  };
  const band = { start: START, max: MAX };
  for (const d of [-0.9, -0.61, -0.6, -0.05, -0.049, 0, 0.049, 0.05, 0.6, 0.601, 0.9, null, NaN]) {
    assert.equal(clientPasses(d, band), passes(d, START, MAX), `delta ${d}: client and server must agree`);
  }
});
