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

test('the in-progress bucket updates as samples arrive (no frozen bar)', () => {
  // 1m timeframe fed 5s samples: the open bar must be revised 11 times, not once.
  const points = samples(12);
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
  assert.equal(emitted.length, 12, 'every sample must be emitted, not one per bucket');

  const firstBucket = emitted.filter((m) => m.point.time === T0);
  assert.equal(firstBucket.length, 12, 'all 12 samples fall in the first 1m bucket');

  // The value carried must advance — this is what "not frozen" means.
  // DISPLAY_SIGN is configurable (VEGA_DISPLAY_SIGN); assert against the sign in
  // force rather than the old hardcoded -1, so the suite is valid either way.
  const S = require('../src/config/vegaConfig').DISPLAY_SIGN;
  assert.equal(firstBucket[0].point.callVegaDiff, 100 * S, 'first sample (display-signed)');
  assert.equal(firstBucket[11].point.callVegaDiff, 111 * S, 'twelfth sample (display-signed)');
  assert.equal(firstBucket[0].bucketAdvanced, true, 'first sample opens the bucket');
  assert.equal(firstBucket[11].bucketAdvanced, false, 'later samples revise it');
});

test('the closed bucket holds the LAST sample, matching what is persisted', () => {
  const points = samples(24); // two full 1m buckets
  const live = runLive(points, '1m');
  const history = vega.bucketByTimeframe(points, '1m');

  assert.equal(live.length, 2);
  // Raw stored value of the closing sample of bucket 0 is index 11 -> 111.
  assert.equal(history[0].callVegaDiff, 111, 'history keeps the last sample of the bucket');
  // decorate() applies DISPLAY_SIGN, so the served value is the negation.
  assert.equal(live[0].callVegaDiff, 111 * require('../src/config/vegaConfig').DISPLAY_SIGN,
    'live converges on the same sample');
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
