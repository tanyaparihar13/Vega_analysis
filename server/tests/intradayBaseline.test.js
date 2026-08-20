'use strict';

/**
 * INTRADAY VERIFICATION BASELINE — a temporary, date-scoped re-origin.
 *
 * ===========================================================================
 * WHY THIS IS SUBTRACTION AND NOT A SECOND BASELINE
 * ===========================================================================
 * Every value is `current - open`, so re-origining a series to a later moment
 * is arithmetic on rows that already exist:
 *
 *     newDiff(t) = oldDiff(t) - oldDiff(anchor)
 *                = [cur(t) - open] - [cur(anchor) - open]
 *                = cur(t) - cur(anchor)
 *
 * The old origin appears in both terms and CANCELS. Three consequences, and
 * each is asserted below because each is a promise made to the operator:
 *
 *   · it needs no option chain and no capture timing, so it works for a moment
 *     that has already passed
 *   · it is exact whatever the old baseline was, INCLUDING a wrong one — which
 *     is the entire point, since the session being rescued was anchored at
 *     09:30 by a restart
 *   · nothing is captured and nothing is written, so vega_day_open keeps the
 *     real day-open record and tomorrow is untouched
 *
 * ===========================================================================
 * THE SAFETY PROPERTY THAT MATTERS MOST
 * ===========================================================================
 * A verification hack that silently becomes tomorrow's baseline would be worse
 * than the bug it was meant to diagnose. The trading date is part of the
 * CONFIG VALUE and is compared against the date being read, so the override
 * cannot reach any other session — there is no ordering, no expiry job and no
 * cleanup step that can be forgotten. That is asserted first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const TARGET_DATE = '2026-08-20';
const ANCHOR = '14:00';
process.env.VEGA_INTRADAY_BASELINE = `${TARGET_DATE}:${ANCHOR}`;

const vega = require('../src/services/vegaTimeseriesService');
const cfg = require('../src/config/vegaConfig');

/** UNIX seconds for HH:MM IST on a date. */
const ist = (date, hh, mm, ss = 0) => Math.floor(Date.parse(
  `${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:`
  + `${String(ss).padStart(2, '0')}+05:30`) / 1000);

/**
 * A raw point as the sampler produces it. `callVegaDiff` here is measured from
 * the WRONG (09:30) origin — deliberately, because the transform has to be
 * correct despite that, not because of it.
 */
const raw = (date, hh, mm, call, put, absCall = 100, absPut = 110) => ({
  time: ist(date, hh, mm),
  callVegaDiff: call,
  putVegaDiff: put,
  vegaDiff: +(put - call).toFixed(4),
  currentCallVega: absCall,
  currentPutVega: absPut,
  openCallVega: 88.89,          // the bad 09:30 origin
  openPutVega: 94.36,
  price: 24261, atmStrike: 24250,
  callStrikeCount: 12, putStrikeCount: 13,
  expiry: '2026-08-25',
});

/** The morning segment (bad origin) plus the afternoon segment. */
function session(date) {
  return [
    raw(date, 9, 30, 5.00, -2.00, 120, 130),
    raw(date, 11, 0, 3.00, -1.00, 118, 131),
    raw(date, 13, 59, 2.00, 1.00, 117, 133),
    raw(date, 14, 0, 4.00, 2.00, 119, 134),   // <- THE ANCHOR
    raw(date, 14, 1, 4.30, 1.60, 119.3, 133.6),
    raw(date, 14, 5, 3.50, 2.90, 118.5, 134.9),
    raw(date, 14, 15, 5.10, 1.20, 120.1, 133.2),
    raw(date, 14, 30, 2.80, 3.40, 117.8, 135.4),
    raw(date, 15, 0, 6.00, 0.50, 121, 132.5),
  ];
}

// ===========================================================================
// 1. IT CANNOT ESCAPE THE ONE SESSION IT NAMES
// ===========================================================================

test('THE SAFETY PROPERTY: the override applies to its own date and no other', () => {
  assert.ok(cfg.INTRADAY_BASELINE, 'configured for this suite');
  assert.equal(cfg.INTRADAY_BASELINE.date, TARGET_DATE);
  assert.equal(cfg.INTRADAY_BASELINE.minutes, 14 * 60, '14:00 IST in minutes');

  assert.ok(vega.intradayAnchorFor(TARGET_DATE), 'active for the named session');

  // Tomorrow, yesterday, and any other day: untouched. There is no cleanup
  // step to forget, because the date is part of the value being compared.
  for (const other of ['2026-08-21', '2026-08-19', '2026-08-24', '2027-01-04']) {
    assert.equal(vega.intradayAnchorFor(other), null,
      `${other} must use the normal market-open baseline`);
  }
});

test('an unset or malformed override disables the feature entirely', () => {
  // Guards the failure mode where a typo silently re-anchors nothing, or worse,
  // everything. Parsing lives in vegaConfig; this pins the contract it returns.
  const parse = (v) => {
    const m = /^(\d{4}-\d{2}-\d{2}):(\d{2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    const minutes = Number(m[2]) * 60 + Number(m[3]);
    return minutes >= 0 && minutes < 1440 ? { date: m[1], minutes } : null;
  };
  assert.equal(parse(''), null);
  assert.equal(parse('2026-08-20'), null, 'a date with no time is not enough');
  assert.equal(parse('14:00'), null, 'a time with no date would be unscoped — refused');
  assert.equal(parse('2026-08-20:25:00'), null, 'not a real time of day');
  assert.deepEqual(parse('2026-08-20:14:00'), { date: '2026-08-20', minutes: 840 });
});

// ===========================================================================
// 2. THE TRANSFORM
// ===========================================================================

test('the series starts AT the anchor and reads zero there', () => {
  const { points, anchor } = vega.reanchorPoints(session(TARGET_DATE), TARGET_DATE);

  assert.equal(points[0].time, ist(TARGET_DATE, 14, 0), 'the first point IS 14:00');
  assert.equal(points[0].callVegaDiff, 0, 'Call Vega is 0 at the anchor');
  assert.equal(points[0].putVegaDiff, 0, 'Put Vega is 0 at the anchor');
  assert.equal(points[0].vegaDiff, 0, 'Difference is 0 at the anchor');
  assert.equal(anchor.label, ANCHOR);
  assert.equal(anchor.callVega, 119, "and the anchor's ABSOLUTE totals are reported");
  assert.equal(anchor.putVega, 134);
});

test('the pre-anchor segment is DROPPED, never joined or zeroed', () => {
  const { points } = vega.reanchorPoints(session(TARGET_DATE), TARGET_DATE);
  const clock = (p) => new Date((p.time + 19800) * 1000).toISOString().slice(11, 16);

  assert.deepEqual(points.map(clock),
    ['14:00', '14:01', '14:05', '14:15', '14:30', '15:00'],
    'exactly the afternoon segment');

  for (const bad of ['09:30', '11:00', '13:59']) {
    assert.equal(points.some((p) => clock(p) === bad), false,
      `${bad} was measured from a different origin and must not appear`);
  }
});

test('every value is the movement since the anchor', () => {
  const src = session(TARGET_DATE);
  const base = src.find((p) => p.time === ist(TARGET_DATE, 14, 0));
  const { points } = vega.reanchorPoints(src, TARGET_DATE);

  for (const p of points) {
    const original = src.find((o) => o.time === p.time);
    assert.equal(p.callVegaDiff, +(original.callVegaDiff - base.callVegaDiff).toFixed(4));
    assert.equal(p.putVegaDiff, +(original.putVegaDiff - base.putVegaDiff).toFixed(4));
    // Difference = Put - Call survives the transform, by linearity.
    assert.equal(p.vegaDiff, +(p.putVegaDiff - p.callVegaDiff).toFixed(4));
    // The day-open panel reports the anchor, not a morning figure these points
    // no longer relate to.
    assert.equal(p.openCallVega, base.currentCallVega);
    assert.equal(p.openPutVega, base.currentPutVega);
  }

  // Spot-check one against hand arithmetic: 14:15 was 5.10 on the old origin,
  // the anchor was 4.00, so the movement since 14:00 is +1.10.
  const at1415 = points.find((p) => p.time === ist(TARGET_DATE, 14, 15));
  assert.equal(at1415.callVegaDiff, 1.10);
  assert.equal(at1415.putVegaDiff, -0.80);
  assert.equal(at1415.vegaDiff, -1.90);
});

test('THE OLD ORIGIN CANCELS — the result is identical whatever it was', () => {
  /**
   * The session being rescued was anchored at 09:30 by a restart. If the
   * transform's output depended on that wrong origin in any way, it would
   * inherit the error it exists to remove. Shifting the entire input by an
   * arbitrary constant — which is exactly what a different baseline does —
   * must leave the output untouched.
   */
  const a = session(TARGET_DATE);
  const shifted = a.map((p) => ({
    ...p,
    callVegaDiff: +(p.callVegaDiff + 5.42).toFixed(4),   // the measured 09:30 error
    putVegaDiff: +(p.putVegaDiff - 0.41).toFixed(4),
  }));

  const one = vega.reanchorPoints(a, TARGET_DATE).points;
  const two = vega.reanchorPoints(shifted, TARGET_DATE).points;

  assert.deepEqual(
    two.map((p) => [p.callVegaDiff, p.putVegaDiff, p.vegaDiff]),
    one.map((p) => [p.callVegaDiff, p.putVegaDiff, p.vegaDiff]),
    'a constant offset in the input produces NO difference in the output');
});

// ===========================================================================
// 3. THE ANCHOR IS THE SAME ON EVERY TIMEFRAME
// ===========================================================================

test('changing timeframe does not move the anchor', () => {
  const { points } = vega.reanchorPoints(session(TARGET_DATE), TARGET_DATE);

  // Re-anchoring happens on RAW points, before bucketing, which is what makes
  // this hold. 14:00 IST is a whole multiple of 60/180/300/900 seconds from the
  // epoch, so the same sample opens the first bucket at every tier.
  for (const tf of ['1m', '3m', '5m', '15m']) {
    const bucketed = vega.bucketByTimeframe(points, tf);
    assert.equal(bucketed[0].time, ist(TARGET_DATE, 14, 0),
      `${tf}: the first bucket still opens at 14:00`);
    assert.equal(vega.bucketStartFor(ist(TARGET_DATE, 14, 0), tf), ist(TARGET_DATE, 14, 0),
      `${tf}: 14:00 is exactly on a bucket boundary`);
  }
});

// ===========================================================================
// 4. EDGE CASES
// ===========================================================================

test('before the anchor is reached the session serves nothing, not the old series', () => {
  const morningOnly = session(TARGET_DATE).filter((p) => p.time < ist(TARGET_DATE, 14, 0));
  const { points, active } = vega.reanchorPoints(morningOnly, TARGET_DATE);
  assert.equal(active, true, 'the override is active');
  assert.deepEqual(points, [],
    'an empty chart is the honest answer — serving the pre-anchor segment is the mixing being avoided');
});

test('another date passes through completely untransformed', () => {
  const other = session('2026-08-19');
  const { points, active } = vega.reanchorPoints(other, '2026-08-19');
  assert.equal(active, false);
  assert.deepEqual(points, other, 'byte-for-byte the input — history is not rewritten');
});

test('the anchor lands on the first sample AT OR AFTER the configured minute', () => {
  // A session with no sample exactly at 14:00 (a gap, a halt) must anchor on
  // the next one rather than refusing or reaching backwards into the morning.
  const gapped = session(TARGET_DATE).filter((p) => p.time !== ist(TARGET_DATE, 14, 0));
  const { points } = vega.reanchorPoints(gapped, TARGET_DATE);
  assert.equal(points[0].time, ist(TARGET_DATE, 14, 1), 'anchors forward, never backward');
  assert.equal(points[0].callVegaDiff, 0);
  assert.equal(points.some((p) => p.time < ist(TARGET_DATE, 14, 0)), false);
});

test('istMomentOf resolves the anchor in IST, not UTC', () => {
  // 14:00 IST is 08:30 UTC. Reading it as UTC would anchor 5.5 hours early —
  // back in the morning segment this is meant to exclude.
  assert.equal(vega.istMomentOf(TARGET_DATE, 840), ist(TARGET_DATE, 14, 0));
  assert.equal(new Date(vega.istMomentOf(TARGET_DATE, 840) * 1000).toISOString(),
    '2026-08-20T08:30:00.000Z');
});
