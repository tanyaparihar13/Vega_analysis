'use strict';

/**
 * THE DAY-OPEN BASELINE IS THE ORIGIN OF THE CHART.
 *
 * ===========================================================================
 * WHAT THIS FILE IS ABOUT
 * ===========================================================================
 * Every plotted value is `current - open`. That makes the baseline the origin
 * of the whole series, and gives the failure a signature nothing else has:
 *
 *   a wrong ORIGIN  -> a CONSTANT additive offset; the shape is untouched
 *   a wrong IV/vega -> an error that SCALES with the value
 *   swapped CE/PE   -> the two series exchange places
 *   a unit error    -> a MULTIPLICATIVE error
 *
 * Measured against StockMojo on 2026-08-20 at 09:43-09:47, after the recorder
 * restarted at 09:30 and anchored the day there instead of at 09:16:
 *
 *   Call offset  +5.42  (sd 0.28)
 *   Put  offset  -0.41  (sd 0.27)
 *
 * Constant to within a third of a vega across five minutes. The arithmetic was
 * never wrong; the origin was. `BASELINE_MIN_IST` was a floor with no ceiling,
 * so a capture at ANY hour was silently accepted as "the open".
 *
 * ===========================================================================
 * WHAT IS ASSERTED
 * ===========================================================================
 *   1. the offset signature itself — that a late anchor is additive, so the
 *      diagnosis above is a property of the arithmetic and not a coincidence
 *   2. the window: 09:16 floor (b67ead6, unchanged) and the new ceiling
 *   3. lateness is DERIVED from the stored captured_at, so every historical
 *      row can be judged without a schema change or a data rewrite
 *   4. a late baseline is still USABLE — refusing would leave the day blank,
 *      and a correct shape is worth more than nothing
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vega = require('../src/services/vegaTimeseriesService');
const cfg = require('../src/config/vegaConfig');
const { computePoint } = require('../src/utils/vegaMath');

/** A synthetic board whose vega is a known function of strike, so a shift in
 *  the baseline produces an offset we can predict exactly. */
function board(atm, vegaAt) {
  const rows = [];
  for (let i = -10; i <= 10; i += 1) {
    const strike = atm + i * 50;
    rows.push({
      strike,
      // Deltas placed inside the 0.05-0.60 band on both sides so every strike
      // is selected and the sums are over an identical basket at both times.
      call: { delta: 0.30, vega: vegaAt(strike) },
      put: { delta: -0.30, vega: vegaAt(strike) * 0.9 },
    });
  }
  return rows;
}

// ===========================================================================
// 1. THE SIGNATURE: a wrong origin is a CONSTANT offset, never a scaling error
// ===========================================================================

test('THE DIAGNOSIS: re-anchoring the baseline shifts the series by a constant', () => {
  const ATM = 24000;
  const trueOpen = board(ATM, (k) => 10 + (k - ATM) / 1000);          // the 09:16 board
  const lateOpen = board(ATM, (k) => 10 + (k - ATM) / 1000 + 0.25);   // the 09:30 board

  // Three later samples, each a different market state.
  const samples = [0.4, -0.2, 0.9].map((drift) =>
    board(ATM, (k) => 10 + (k - ATM) / 1000 + drift));

  const run = (openChain, currentChain) => computePoint({
    currentChain, openChain, start: 0.05, deltaMax: 0.60, mode: 'dynamic',
  });

  const offsets = samples.map((cur) => {
    const correct = run(trueOpen, cur);
    const late = run(lateOpen, cur);
    return {
      call: +(late.callVegaDiff - correct.callVegaDiff).toFixed(4),
      put: +(late.putVegaDiff - correct.putVegaDiff).toFixed(4),
    };
  });

  // Every sample is displaced by exactly the same amount, whatever the market
  // did in between. THAT is why the production offset had sd 0.28.
  const callOffsets = [...new Set(offsets.map((o) => o.call))];
  const putOffsets = [...new Set(offsets.map((o) => o.put))];
  assert.equal(callOffsets.length, 1, 'the call displacement is CONSTANT across samples');
  assert.equal(putOffsets.length, 1, 'the put displacement is CONSTANT across samples');

  // 21 strikes x 0.25 of vega = 5.25 on the call side; the put side carries the
  // 0.9 factor. Both are additive and neither depends on the current board.
  assert.equal(callOffsets[0], -5.25);
  assert.equal(putOffsets[0], -4.725);

  // And the arithmetic that is NOT affected: Difference is still put - call.
  for (const cur of samples) {
    const p = run(trueOpen, cur);
    assert.equal(p.vegaDiff, +(p.putVegaDiff - p.callVegaDiff).toFixed(4),
      'Difference = Put - Call, unchanged by any of this');
  }
});

test('a correct baseline makes the first sample of the session read zero', () => {
  const ATM = 24000;
  const open = board(ATM, (k) => 10 + (k - ATM) / 1000);
  // The first sample IS the baseline board — nothing has moved yet.
  const p = computePoint({
    currentChain: open, openChain: open, start: 0.05, deltaMax: 0.60, mode: 'dynamic',
  });
  assert.equal(p.callVegaDiff, 0, 'call opens at 0');
  assert.equal(p.putVegaDiff, 0, 'put opens at 0');
  assert.equal(p.vegaDiff, 0, 'difference opens at 0');

  // This is the observable that catches a bad anchor in production: on
  // 2026-08-20 the session's first sample read -4.83 / -29.48 instead.
});

// ===========================================================================
// 2. THE CAPTURE WINDOW
// ===========================================================================

test('the baseline window has BOTH a floor and a ceiling', () => {
  // b67ead6: not before 09:16. Unchanged.
  assert.equal(cfg.BASELINE_MIN_IST, 556, '09:16 IST floor (b67ead6) is intact');
  assert.ok(cfg.BASELINE_MAX_IST > cfg.BASELINE_MIN_IST,
    'the ceiling must be after the floor or nothing can ever be captured');
  assert.ok(cfg.BASELINE_MAX_IST < cfg.MARKET_CLOSE_MIN,
    'a ceiling at or past the close would accept any capture at all — the bug');

  // The floor is after the bell, the ceiling is a few minutes later: a window,
  // not a half-line.
  assert.ok(cfg.BASELINE_MIN_IST > cfg.MARKET_OPEN_MIN,
    'the baseline waits for the board to start trading');
});

test('lateness is derived from captured_at, for stored rows as well as live ones', () => {
  // captured_at is written in UTC. 09:16 IST is 03:46 UTC.
  const onTime = vega.baselineLateness('2026-08-20 03:46:00');
  assert.equal(onTime.late, false, '09:16 IST is on time');
  assert.equal(onTime.capturedAtIst, '09:16');
  assert.equal(onTime.minutesAfterOpen, 1, 'one minute after the 09:15 bell');

  // 09:30 IST is 04:00 UTC — the 2026-08-20 restart.
  const late = vega.baselineLateness('2026-08-20 04:00:00');
  assert.equal(late.late, true, '09:30 IST is NOT the open');
  assert.equal(late.capturedAtIst, '09:30');
  assert.equal(late.minutesAfterOpen, 15);

  // A Date is accepted as readily as the DATETIME string mysql2 returns.
  assert.equal(vega.baselineLateness(new Date('2026-08-20T04:00:00Z')).late, true);

  // Absent or unparseable must not claim lateness it cannot know about.
  assert.equal(vega.baselineLateness(null).late, false);
  assert.equal(vega.baselineLateness('not-a-date').late, false);
  assert.equal(vega.baselineLateness(null).minutesAfterOpen, null);
});

test('the boundary minute itself is not late', () => {
  // BASELINE_MAX_IST is inclusive: `late` is `minutes > MAX`, so a capture ON
  // the ceiling still counts as the open. An exclusive test here would make the
  // window one minute narrower than it reads.
  const atCeiling = cfg.BASELINE_MAX_IST;                    // minutes from midnight
  const utcHH = String(Math.floor((atCeiling - 330) / 60)).padStart(2, '0');
  const utcMM = String((atCeiling - 330) % 60).padStart(2, '0');
  assert.equal(vega.baselineLateness(`2026-08-20 ${utcHH}:${utcMM}:00`).late, false,
    'a capture exactly on the ceiling is still the open');
  const past = atCeiling + 1;
  const pHH = String(Math.floor((past - 330) / 60)).padStart(2, '0');
  const pMM = String((past - 330) % 60).padStart(2, '0');
  assert.equal(vega.baselineLateness(`2026-08-20 ${pHH}:${pMM}:00`).late, true,
    'one minute past it is');
});

// ===========================================================================
// 3. A LATE BASELINE IS MARKED, NOT DISCARDED
// ===========================================================================

test('a late baseline still produces a usable series', () => {
  const ATM = 24000;
  const lateOpen = board(ATM, (k) => 10 + (k - ATM) / 1000 + 0.25);
  const cur = board(ATM, (k) => 10 + (k - ATM) / 1000 + 0.65);

  const p = computePoint({
    currentChain: cur, openChain: lateOpen, start: 0.05, deltaMax: 0.60, mode: 'dynamic',
  });

  // Refusing to capture would leave the day with no chart at all. The shape is
  // still correct and still tradeable; only the level is displaced, and the API
  // now says so rather than implying 09:15.
  assert.ok(Number.isFinite(p.callVegaDiff) && p.callStrikeCount > 0,
    'the series is computed, not withheld');
  assert.equal(p.callStrikeCount, 21, 'the full basket still contributes');
});

test('needsDayOpenCapture never re-captures a good baseline mid-session', () => {
  const today = vega.todayIst();
  // The immutability that makes the chart stable within a session must survive
  // every change above: re-taking a valid baseline at 11:00 would move the
  // origin under a chart the user has been watching all morning.
  assert.equal(
    vega.needsDayOpenCapture({ date: today, open: { date: today } }), false,
    "today's baseline is taken once and held");
  assert.equal(vega.needsDayOpenCapture({ date: today, open: null }), true,
    'a session without one still captures');
  assert.equal(vega.needsDayOpenCapture({ date: '1999-01-01', open: { date: '1999-01-01' } }), true,
    "and a previous session's baseline is never reused");
});
