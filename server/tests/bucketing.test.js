'use strict';

/**
 * B-01 — LIVE AND HISTORY MUST CONVERGE.
 *
 * This is the regression test for the highest-severity finding in the audit.
 * It drives the REAL emit path (vegaStreamService.__test.handleSamplerTick with
 * fake sockets), feeds the emitted messages through a faithful copy of the
 * client reducer in useVegaStream, and asserts the result is identical to what
 * vegaTimeseriesService.bucketByTimeframe() produces for the same samples.
 *
 * If anyone reintroduces the bucket suppression (`if (session.lastBucket ===
 * bucket) continue;`) this fails on every timeframe coarser than the base clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vega = require('../src/services/vegaTimeseriesService');
const stream = require('../src/services/vegaStreamService');

const TIMEFRAMES = ['5s', '10s', '15s', '30s', '1m', '3m', '5m', '10m', '15m', '30m', '1h'];

/** A minute-aligned epoch so bucket boundaries are unambiguous in assertions. */
const T0 = 1755000000; // 1755000000 % 3600 === 0

/** Synthetic 5s samples with a strictly increasing, easily-identified value. */
function samples(count, startEpoch = T0) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      time: startEpoch + i * 5,
      callVegaDiff: 100 + i,
      putVegaDiff: -(100 + i),
      vegaDiff: -2 * (100 + i),
      currentCallVega: 1000 + i,
      currentPutVega: 2000 + i,
      openCallVega: 1000,
      openPutVega: 2000,
      price: 24000 + i,
      atmStrike: 24000,
      callStrikeCount: 20,
      putStrikeCount: 20,
      expiry: '2026-08-28',
    });
  }
  return out;
}

/**
 * client/src/features/vegaAnalysis/useVegaStream.js — the vega_point reducer,
 * reproduced exactly. Replace when the timestamp repeats, append when it
 * advances, ignore anything that goes backwards.
 */
function clientReduce(prev, incoming) {
  const last = prev[prev.length - 1];
  if (last && last.time === incoming.time) {
    const next = prev.slice(0, -1);
    next.push(incoming);
    return next;
  }
  if (last && incoming.time < last.time) return prev;
  return [...prev, incoming];
}

/** Drive the real emit path for one timeframe; return what the client ends up holding. */
function runLive(points, timeframe) {
  const client = { readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); } };
  stream.__test.sessions.set(client, {
    symbol: 'NIFTY', expiry: '2026-08-28', timeframe, lastBucket: null,
    // A live session is a subscription to ONE trading day, and the push path
    // now refuses a point belonging to any other. These synthetic samples all
    // sit on T0's IST day, so that is the day this session is watching.
    tradingDate: vega.tradingDateOf({ time: T0 }),
  });
  try {
    for (const p of points) {
      stream.__test.handleSamplerTick([{ symbol: 'NIFTY', expiry: '2026-08-28', point: p }]);
    }
    return client.messages
      .filter((m) => m.type === 'vega_point')
      .map((m) => m.point)
      .reduce(clientReduce, []);
  } finally {
    stream.__test.sessions.delete(client);
  }
}

test('live and history agree on every timeframe', () => {
  const points = samples(1500); // 125 minutes of 5s samples
  for (const tf of TIMEFRAMES) {
    const history = vega.bucketByTimeframe(points, tf).map(vega.decorate);
    const live = runLive(points, tf);

    assert.equal(live.length, history.length, `${tf}: point count`);
    for (let i = 0; i < history.length; i++) {
      assert.equal(live[i].time, history[i].time, `${tf}: time at index ${i}`);
      assert.equal(live[i].callVegaDiff, history[i].callVegaDiff, `${tf}: callVegaDiff at ${i}`);
      assert.equal(live[i].putVegaDiff, history[i].putVegaDiff, `${tf}: putVegaDiff at ${i}`);
      assert.equal(live[i].vegaDiff, history[i].vegaDiff, `${tf}: vegaDiff at ${i}`);
      assert.equal(live[i].trend, history[i].trend, `${tf}: trend at ${i}`);
    }
  }
});

test('a bucket AFTER the opening one updates as samples arrive (no frozen bar)', () => {
  /**
   * RE-POINTED AT BUCKET 1, DELIBERATELY.
   *
   * This asserted bucket 0 until the opening-bucket rule landed. The opening
   * bucket is now published ONCE and never revised, because its first sample is
   * the day-open baseline (exactly 0/0/0) and last-value-wins was throwing that
   * zero away — see bucketByTimeframe's header.
   *
   * Every OTHER bucket still revises on every sample, and that is what this
   * test is actually for: proving a bar in progress stays live. Moving it to
   * bucket 1 keeps that guarantee under test instead of deleting it. The
   * opening bucket's own rule is asserted separately below.
   */
  const points = samples(24);   // bucket 0 (opening) + bucket 1
  const client = { readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); } };
  stream.__test.sessions.set(client, {
    symbol: 'NIFTY', expiry: '2026-08-28', timeframe: '1m', lastBucket: null,
    tradingDate: vega.tradingDateOf({ time: T0 }),
  });
  try {
    for (const p of points) {
      stream.__test.handleSamplerTick([{ symbol: 'NIFTY', expiry: '2026-08-28', point: p }]);
    }
  } finally {
    stream.__test.sessions.delete(client);
  }

  const emitted = client.messages.filter((m) => m.type === 'vega_point');

  const opening = emitted.filter((m) => m.point.time === T0);
  assert.equal(opening.length, 1, 'the OPENING bucket is published once and never revised');

  const second = emitted.filter((m) => m.point.time === T0 + 60);
  assert.equal(second.length, 12, 'every sample of a later bucket is still emitted');

  // The value carried must advance — this is what "not frozen" means.
  // DISPLAY_SIGN is configurable (VEGA_DISPLAY_SIGN); assert against the sign in
  // force rather than the old hardcoded -1, so the suite is valid either way.
  const S = require('../src/config/vegaConfig').DISPLAY_SIGN;
  assert.equal(second[0].point.callVegaDiff, 112 * S, 'first sample of bucket 1 (display-signed)');
  assert.equal(second[11].point.callVegaDiff, 123 * S, 'twelfth sample of bucket 1 (display-signed)');
  assert.equal(second[0].bucketAdvanced, true, 'first sample opens the bucket');
  assert.equal(second[11].bucketAdvanced, false, 'later samples revise it');
});

test('THE OPENING BUCKET KEEPS THE VALUE IT OPENED WITH', () => {
  /**
   * The defect this rule exists to fix. An index persists at 5s, so the opening
   * 1m bucket holds twelve samples. The FIRST of them is the day-open baseline
   * and is exactly 0/0/0; last-value-wins published the twelfth instead, so the
   * chart's opening bar was ~55 seconds of market movement away from the zero
   * the whole series is measured from.
   */
  const points = samples(24);
  const history = vega.bucketByTimeframe(points, '1m');

  assert.equal(history[0].callVegaDiff, 100, 'opening bucket keeps its FIRST sample');
  assert.equal(history[1].callVegaDiff, 123, 'every later bucket keeps its LAST');

  // And it holds at every tier, without a per-timeframe special case: the
  // opening bucket is simply the one that closes first.
  for (const tf of ['1m', '3m', '5m', '15m']) {
    assert.equal(vega.bucketByTimeframe(points, tf)[0].callVegaDiff, 100,
      `${tf}: the opening bar is the sample that opened the session`);
  }
});

test('a zero opening sample SURVIVES aggregation at every timeframe', () => {
  // The acceptance criterion stated directly: a session whose first sample is
  // the baseline (0/0/0) must still read zero on the chart, at any tier.
  const zeroOpen = samples(48).map((p, i) => (i === 0
    ? { ...p, callVegaDiff: 0, putVegaDiff: 0, vegaDiff: 0 }
    : p));

  for (const tf of TIMEFRAMES) {
    const first = vega.bucketByTimeframe(zeroOpen, tf)[0];
    assert.equal(first.callVegaDiff, 0, `${tf}: call opens at zero`);
    assert.equal(first.putVegaDiff, 0, `${tf}: put opens at zero`);
    assert.equal(first.vegaDiff, 0, `${tf}: difference opens at zero`);
  }
});

test('the closed bucket holds the LAST sample, matching what is persisted', () => {
  const points = samples(24); // two full 1m buckets
  const live = runLive(points, '1m');
  const history = vega.bucketByTimeframe(points, '1m');

  const S = require('../src/config/vegaConfig').DISPLAY_SIGN;
  assert.equal(live.length, 2);

  // Bucket 0 is the OPENING bucket: it keeps the sample that opened it (index
  // 0 -> 100), because that sample is the day-open baseline.
  assert.equal(history[0].callVegaDiff, 100, 'opening bucket keeps its first sample');
  assert.equal(live[0].callVegaDiff, 100 * S, 'live agrees, display-signed');

  // Bucket 1 is an ordinary bucket: last-value-wins, index 23 -> 123. This is
  // the guarantee the test was originally written for and it is unchanged.
  assert.equal(history[1].callVegaDiff, 123, 'a later bucket keeps its LAST sample');
  assert.equal(live[1].callVegaDiff, 123 * S, 'live converges on the same sample');

  assert.equal(live[0].time, T0);
  assert.equal(live[1].time, T0 + 60);
});

test('bucket boundaries are absolute against the epoch and never drift', () => {
  for (const tf of TIMEFRAMES) {
    const seconds = vega.TIMEFRAMES[tf];
    for (const t of [T0, T0 + 1, T0 + seconds - 1, T0 + seconds, T0 + 5 * seconds + 3]) {
      const b = vega.bucketStartFor(t, tf);
      assert.equal(b % seconds, 0, `${tf}: bucket start must be a multiple of ${seconds}`);
      assert.ok(b <= t && t - b < seconds, `${tf}: ${t} must fall inside its bucket`);
    }
  }
});

test('a single point is bucket-aligned (B-10)', () => {
  const one = [{ time: T0 + 35, callVegaDiff: 9, putVegaDiff: 1, vegaDiff: -8 }];
  const out = vega.bucketByTimeframe(one, '1m');
  assert.equal(out.length, 1);
  assert.equal(out[0].time, T0, 'the lone point must sit on its bucket start, not at +35s');
  assert.equal(out[0].callVegaDiff, 9, 'and must keep its value');
});

test('bucketing never produces duplicate or out-of-order timestamps', () => {
  const points = samples(2000);
  for (const tf of TIMEFRAMES) {
    const out = vega.bucketByTimeframe(points, tf);
    const times = out.map((p) => p.time);
    assert.equal(new Set(times).size, times.length, `${tf}: duplicate timestamps`);
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] > times[i - 1], `${tf}: out-of-order at index ${i}`);
    }
  }
});

test('out-of-order and stale points are rejected by the client reducer', () => {
  const base = [{ time: T0 + 120, callVegaDiff: 5 }];
  const stale = clientReduce(base, { time: T0 + 60, callVegaDiff: 999 });
  assert.deepEqual(stale, base, 'an older timestamp must be ignored, not appended');
});

test('an empty series stays empty', () => {
  assert.deepEqual(vega.bucketByTimeframe([], '1m'), []);
  assert.deepEqual(vega.bucketByTimeframe([], '30m'), []);
});
