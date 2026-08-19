'use strict';

/**
 * The day-open baseline.
 *
 * Every plotted value is `current - open`, so a baseline built from a board
 * that has not started trading is not a small error: it is a constant offset
 * carried by the whole session. On 2026-08-19 exactly that happened - see the
 * fixture - and it was invisible in every downstream check because the API,
 * the table and the chart all agreed with each other on the wrong number.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const vega = require('../src/services/vegaTimeseriesService');
const cfg = require('../src/config/vegaConfig');

const REAL = require(path.join(__dirname, 'fixtures', 'openChain-2026-08-19-NIFTY-0915.json'));

/** A synthetic board where a given fraction of each side is priced. */
function board(n, callFrac, putFrac) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      strike: 24000 + i * 50,
      call: { vega: i < Math.round(n * callFrac) ? 12.5 : null },
      put: { vega: i < Math.round(n * putFrac) ? 12.5 : null },
    });
  }
  return out;
}

test('THE REGRESSION: the real 09:15:00 board and what each guard does with it', () => {
  assert.equal(REAL.strikes, 61, 'fixture shape');
  assert.equal(REAL.callsPriced, 60, 'calls were almost fully priced');
  assert.equal(REAL.putsPriced, 39, 'puts had mostly not traded');

  // The old rule ORed the sides: (60 or 39 priced) / 61 -> ~0.98, accepted.
  const oldRule = REAL.chain.filter((r) => r.call?.vega || r.put?.vega).length / REAL.strikes;
  assert.ok(oldRule >= 0.5, 'the OR rule really did score this as usable');

  // The new rule looks at each side, so a stricter floor now reaches the puts.
  assert.equal(vega.isUsableOpenChain(REAL.chain, 0.75), false,
    'at a 0.75 floor the 39/61 put side is what fails');

  /**
   * HONEST NOTE ABOUT THE PRODUCTION THRESHOLD.
   *
   * 39/61 = 0.639, so at the shipped floor of 0.5 this board still passes the
   * coverage check. Coverage is NOT what protects us from this board — the
   * 09:16 timing gate is. 0.75 was measured against 164 archived opening
   * chains and refused up to 20 of 41 targets in a session, mostly illiquid
   * single-stock boards that never reach it; see vegaConfig.js.
   */
  assert.equal(vega.isUsableOpenChain(REAL.chain, cfg.BASELINE_MIN_SIDE_FRACTION), true,
    'documents that the shipped floor alone does NOT reject it — the time gate does');
});

test('the catastrophic case the OR rule could never see: one side wholly unpriced', () => {
  const oneSided = board(60, 1.0, 0.0);
  // Old rule: every row had a call vega, so it scored 1.0 and was accepted.
  const oldScore = oneSided.filter((r) => r.call?.vega || r.put?.vega).length / oneSided.length;
  assert.equal(oldScore, 1, 'the OR rule scored a put-less board as perfect');
  assert.equal(vega.isUsableOpenChain(oneSided, cfg.BASELINE_MIN_SIDE_FRACTION), false,
    'per-side evaluation rejects it at the shipped floor');
});

test('both sides must clear the threshold, not just one', () => {
  assert.equal(vega.isUsableOpenChain(board(60, 1.0, 1.0), 0.9), true, 'both sides full');
  assert.equal(vega.isUsableOpenChain(board(60, 1.0, 0.2), 0.9), false, 'calls full, puts thin');
  assert.equal(vega.isUsableOpenChain(board(60, 0.2, 1.0), 0.9), false, 'puts full, calls thin');
  assert.equal(vega.isUsableOpenChain(board(60, 0.2, 0.2), 0.9), false, 'both thin');
});

test('the threshold boundary is inclusive on each side independently', () => {
  assert.equal(vega.isUsableOpenChain(board(100, 0.5, 0.5), 0.5), true, 'exactly at the floor');
  assert.equal(vega.isUsableOpenChain(board(100, 0.5, 0.49), 0.5), false, 'one side just under');
});

test('an empty board is never usable', () => {
  assert.equal(vega.isUsableOpenChain([], 0.5), false);
});

test('the baseline may not be taken before 09:16 IST', () => {
  // 09:15 = 555 minutes from midnight, 09:16 = 556.
  assert.equal(cfg.MARKET_OPEN_MIN, 555, 'recording still starts at the bell');
  assert.ok(cfg.BASELINE_MIN_IST > cfg.MARKET_OPEN_MIN,
    'the baseline must wait at least one minute past the open');
  assert.equal(cfg.BASELINE_MIN_IST, 556, 'matches AlphaEdge config.php $t2 = 9:16');
});
