'use strict';

/**
 * ONE SELECTED TRADING DATE = ONE DATASET.
 *
 * `state` is keyed by SYMBOL|EXPIRY because an expiry outlives a session. The
 * buffer inside it does not. The only thing that cleared it was loadToday(),
 * which runs once at boot, so a process left running across midnight kept
 * yesterday's tail and appended today's points to the same array — and the
 * terminal rendered 15:30 rows from the previous session above 09:15 rows from
 * this one, under a date picker that said today.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vega = require('../src/services/vegaTimeseriesService');

const { state, stateKey, appendLive } = vega.__test;

/** UNIX seconds for a wall-clock IST moment. */
function ist(y, m, d, hh, mm) {
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm) / 1000) - (5 * 3600 + 1800);
}

test('a point maps to the IST session it was traded in', () => {
  assert.equal(vega.tradingDateOf({ time: ist(2026, 8, 20, 9, 15) }), '2026-08-20', 'the open');
  assert.equal(vega.tradingDateOf({ time: ist(2026, 8, 20, 15, 30) }), '2026-08-20', 'the close');
  assert.equal(vega.tradingDateOf({ time: ist(2026, 8, 19, 15, 30) }), '2026-08-19', 'previous close');
});

test('THE BUG: yesterday 15:30 and today 09:15 are different sessions', () => {
  const prevClose = vega.tradingDateOf({ time: ist(2026, 8, 19, 15, 30) });
  const openToday = vega.tradingDateOf({ time: ist(2026, 8, 20, 9, 15) });
  assert.notEqual(prevClose, openToday,
    'these are the exact rows the screenshot showed side by side');
  assert.equal(prevClose, '2026-08-19');
  assert.equal(openToday, '2026-08-20');
});

test('the IST date does not shift across the UTC midnight boundary', () => {
  // 04:00 IST on the 20th is 22:30 UTC on the 19th. Naive UTC slicing calls
  // that the 19th; the trading session does not.
  assert.equal(vega.tradingDateOf({ time: ist(2026, 8, 20, 4, 0) }), '2026-08-20');
  // 23:00 IST on the 19th is 17:30 UTC the same day — must stay the 19th.
  assert.equal(vega.tradingDateOf({ time: ist(2026, 8, 19, 23, 0) }), '2026-08-19');
});

test('a null or timeless point never claims a session', () => {
  assert.equal(vega.tradingDateOf(null), null);
  assert.equal(vega.tradingDateOf({}), null);
});

test('THE FIX (write path): a new session starts a new buffer', () => {
  const key = stateKey('TESTSYM', '2026-08-25');
  const entry = {
    symbol: 'TESTSYM',
    expiry: '2026-08-25',
    date: '2026-08-19',
    open: { date: '2026-08-19' },
    series: [
      { time: ist(2026, 8, 19, 15, 28), callVegaDiff: -1 },
      { time: ist(2026, 8, 19, 15, 29), callVegaDiff: -2 },
      { time: ist(2026, 8, 19, 15, 30), callVegaDiff: -3 },
    ],
  };
  state.set(key, entry);
  try {
    // The first point of the NEXT session arrives.
    appendLive(key, entry, { time: ist(2026, 8, 20, 9, 15), callVegaDiff: 0 });

    const after = state.get(key);
    assert.equal(after.series.length, 1, "yesterday's tail must not survive");
    assert.equal(vega.tradingDateOf(after.series[0]), '2026-08-20');
    assert.equal(after.date, '2026-08-20', 'the buffer now belongs to the new session');
    assert.equal(after.open, null, "yesterday's baseline must not carry over");

    const dates = new Set(after.series.map((p) => vega.tradingDateOf(p)));
    assert.equal(dates.size, 1, 'one buffer, one session');
  } finally {
    state.delete(key);
  }
});

test('same-session points still append normally', () => {
  const key = stateKey('TESTSYM2', '2026-08-25');
  const entry = {
    symbol: 'TESTSYM2', expiry: '2026-08-25', date: '2026-08-20', open: null,
    series: [{ time: ist(2026, 8, 20, 9, 15), callVegaDiff: 0 }],
  };
  state.set(key, entry);
  try {
    appendLive(key, entry, { time: ist(2026, 8, 20, 9, 16), callVegaDiff: -1 });
    assert.equal(state.get(key).series.length, 2, 'a normal append is untouched');
  } finally {
    state.delete(key);
  }
});

test('THE FIX (read path): a stale-session buffer is never served', () => {
  const key = stateKey('TESTSYM3', '2026-08-25');
  state.set(key, {
    symbol: 'TESTSYM3', expiry: '2026-08-25',
    date: '1999-01-01', // unmistakably not today
    open: null,
    series: [{ time: ist(2026, 8, 19, 15, 30), callVegaDiff: -3, putVegaDiff: 1, vegaDiff: 4 }],
  });
  try {
    assert.deepEqual(vega.getSeries('TESTSYM3', '1m', '2026-08-25'), [],
      'a buffer from another session must read as empty, not as data');
  } finally {
    state.delete(key);
  }
});

test('THE TRAPDOOR: a stale baseline must not survive into a new session', async () => {
  /**
   * ensureDayOpen() short-circuits on `if (entry.open) return entry.open` so the
   * baseline is immutable WITHIN a session. Across sessions that shortcut hid
   * everything: yesterday's entry.open was returned, today's capture never ran,
   * and the whole session measured current-minus-open against the PREVIOUS
   * day's chain. Observed live on 2026-08-20: zero baseline rows written, the
   * first sample of the session not zero, and openCallVega drifting 146 -> 115
   * -> 122 as dynamic selection pulled different strikes from a foreign chain.
   *
   * The staleness check therefore has to run BEFORE the shortcut. A real
   * underlying is needed (captureDayOpen bails on an unknown one), with an
   * expiry far enough out that no live slot can collide.
   */
  const FAR = '2099-12-31';
  const key = stateKey('NIFTY', FAR);
  state.set(key, {
    symbol: 'NIFTY',
    expiry: FAR,
    date: '1999-01-01',
    open: { date: '1999-01-01', chain: [{ strike: 1, call: {}, put: {} }] },
    series: [{ time: ist(1999, 1, 1, 15, 30), callVegaDiff: -3 }],
  });
  try {
    // The capture cannot complete without a live chain for a 2099 expiry, but
    // the stale-session reset runs before any chain work — that is the point.
    await vega.captureDayOpen('NIFTY', FAR).catch(() => {});
    const after = state.get(key);
    assert.ok(after, 'the slot still exists');
    assert.equal(after.open, null, "yesterday's baseline must be cleared, not returned");
    assert.equal(after.series.length, 0, "yesterday's buffer must be dropped too");
    assert.notEqual(after.date, '1999-01-01', 'the slot now belongs to the current session');
  } finally {
    state.delete(key);
  }
});
