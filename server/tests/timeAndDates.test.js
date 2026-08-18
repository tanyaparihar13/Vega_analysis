'use strict';

/**
 * TIME-TO-EXPIRY, TIMEZONES AND TICK NORMALISATION.
 *
 * The invariant the whole system rests on: `sampled_at` is UTC, `snapshot_date`
 * is the IST trading day, `expiry` is an IST calendar date, and `point.time` is
 * absolute UNIX seconds. These tests pin each conversion and the boundaries
 * where they could disagree.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bs = require('../src/utils/blackScholes');
const { normalizeTick } = require('../src/utils/normalizeTick');
const vega = require('../src/services/vegaTimeseriesService');

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------- B-07
test('every expiry input form yields the same T', () => {
  const now = new Date('2026-08-18T06:00:00Z'); // 11:30 IST
  const expected = bs.yearsToExpiry('2026-08-25', now);

  assert.equal(bs.yearsToExpiry('2026-08-25 00:00:00', now), expected, 'MySQL DATETIME string');
  assert.equal(bs.yearsToExpiry('2026-08-25T00:00:00.000Z', now), expected, 'ISO string');
  assert.equal(bs.yearsToExpiry(new Date('2026-08-25T00:00:00Z'), now), expected, 'JS Date (B-07)');
  assert.ok(Number.isFinite(expected) && expected > 0);
});

test('a Date input no longer produces NaN', () => {
  const now = new Date('2026-08-18T06:00:00Z');
  const T = bs.yearsToExpiry(new Date('2026-08-25T00:00:00Z'), now);
  assert.ok(!Number.isNaN(T), 'NaN here silently zeroed every Greek for a whole session');
  assert.ok(T > 0);
});

test('an unparseable expiry throws instead of silently returning zeros', () => {
  for (const bad of ['not-a-date', '', null, undefined, {}, new Date('nope')]) {
    assert.throws(() => bs.yearsToExpiry(bad, new Date()), TypeError,
      `${JSON.stringify(String(bad))} must throw, not produce a chain of fabricated zeros`);
  }
});

test('expiry is 15:30 IST (10:00 UTC), not midnight', () => {
  // At exactly 11:30 IST on expiry day, 4 hours remain.
  const T = bs.yearsToExpiry('2026-08-18', new Date('2026-08-18T06:00:00Z'));
  const hours = T * 365 * 24;
  assert.ok(Math.abs(hours - 4) < 1e-6, `expected 4h, got ${hours}h`);
});

test('same-day, one-day, weekend and holiday spans are calendar-based', () => {
  const now = new Date('2026-08-18T06:00:00Z'); // Tue 11:30 IST
  const oneDay = bs.yearsToExpiry('2026-08-19', now) - bs.yearsToExpiry('2026-08-18', now);
  assert.ok(Math.abs(oneDay - 1 / 365) < 1e-9, 'one calendar day is exactly 1/365 of a year');

  /**
   * Fri -> Mon is THREE calendar days of decay, not one trading day.
   *
   * Measured as the DIFFERENCE between two expiry moments so the observer's
   * time-of-day cancels out. (Comparing `yearsToExpiry('Mon')` directly against
   * 3 would also include the hours from the observation instant to 15:30, which
   * is a property of when you looked, not of the calendar span.)
   */
  const fri = new Date('2026-08-21T06:00:00Z'); // Fri 11:30 IST
  const span = (bs.yearsToExpiry('2026-08-24', fri) - bs.yearsToExpiry('2026-08-21', fri)) * 365;
  assert.ok(Math.abs(span - 3) < 1e-9,
    `Fri->Mon must be 3 calendar days of decay (weekend included), got ${span}`);
});

test('an expired contract clamps to T = 0 and never goes negative', () => {
  const now = new Date('2026-08-18T11:00:00Z'); // after 15:30 IST
  assert.equal(bs.yearsToExpiry('2026-08-18', now), 0, 'past 15:30 on expiry day');
  assert.equal(bs.yearsToExpiry('2026-08-01', now), 0, 'long expired');
  assert.equal(bs.yearsToExpiry('2020-01-01', now), 0);
});

test('T = 0 yields zero Greeks, not NaN or Infinity', () => {
  const g = bs.calculateGreeks76({ F: 24000, K: 24000, T: 0, r: 0.065, sigma: 0.15, type: 'CE' });
  for (const [k, v] of Object.entries(g)) {
    assert.equal(v, 0, `${k} at T=0`);
  }
});

test('near-zero T stays finite', () => {
  const T = 1 / (365 * 24 * 60); // one minute
  const g = bs.calculateGreeks76({ F: 24000, K: 24000, T, r: 0.065, sigma: 0.15, type: 'CE' });
  for (const [k, v] of Object.entries(g)) {
    assert.ok(Number.isFinite(v), `${k} must be finite at T=1min, got ${v}`);
  }
});

// ---------------------------------------------------------------- IST
test('todayIst is the IST calendar day, not UTC', () => {
  // The gap that matters: 00:00-05:30 IST is still the PREVIOUS UTC day.
  const istDate = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
  // 2026-08-18 19:00 UTC == 2026-08-19 00:30 IST
  assert.equal(istDate(Date.parse('2026-08-18T19:00:00Z')), '2026-08-19');
  // 2026-08-18 18:00 UTC == 2026-08-18 23:30 IST
  assert.equal(istDate(Date.parse('2026-08-18T18:00:00Z')), '2026-08-18');
  assert.match(vega.todayIst(), /^\d{4}-\d{2}-\d{2}$/);
});

test('market hours in IST map inside one UTC calendar date', () => {
  /**
   * This is the invariant that stops yesterday's data appearing under today's
   * date. snapshot_date is the IST day; sampled_at is UTC. They agree for every
   * real sample only because 09:15-15:30 IST is 03:45-10:00 UTC — the same UTC
   * date. Widening MARKET_OPEN_MIN below 330 (05:30 IST) would break it.
   */
  const cfg = require('../src/config/vegaConfig');
  assert.ok(cfg.MARKET_OPEN_MIN >= 330,
    'sampling must not start before 05:30 IST or the UTC/IST dates diverge');
  assert.ok(cfg.MARKET_CLOSE_MIN <= 1439);

  for (const min of [cfg.MARKET_OPEN_MIN, cfg.MARKET_CLOSE_MIN]) {
    const utcMinutes = min - 330;
    assert.ok(utcMinutes >= 0 && utcMinutes < 1440,
      `IST minute ${min} must fall inside the same UTC day`);
  }
});

test('a stored UTC timestamp round-trips to the same instant', () => {
  // persistSamples writes toISOString().slice(0,19).replace('T',' ');
  // rowToPoint reads it back by appending 'Z'.
  const epoch = 1755000000;
  const written = new Date(epoch * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const readBack = Math.floor(new Date(`${written.replace(' ', 'T')}Z`).getTime() / 1000);
  assert.equal(readBack, epoch, 'the UTC write/read pair must be lossless');
});

// ---------------------------------------------------------------- B-14
test('tick timestamp is always epoch milliseconds, whatever the source', () => {
  const base = { instrument_token: 256265, last_price: 100, ohlc: {}, depth: {} };
  const when = new Date('2026-08-18T06:00:00Z');

  const fromExchange = normalizeTick({ ...base, exchange_timestamp: when });
  assert.equal(typeof fromExchange.timestamp, 'number');
  assert.equal(fromExchange.timestamp, when.getTime());
  assert.equal(fromExchange.timestampSource, 'exchange');

  const fromTrade = normalizeTick({ ...base, last_trade_time: when });
  assert.equal(typeof fromTrade.timestamp, 'number');
  assert.equal(fromTrade.timestampSource, 'lastTrade');

  const fromServer = normalizeTick({ ...base });
  assert.equal(typeof fromServer.timestamp, 'number', 'the fallback used to be an ISO STRING');
  assert.equal(fromServer.timestampSource, 'server');

  // Seconds-vs-milliseconds disambiguation.
  const secs = normalizeTick({ ...base, exchange_timestamp: 1755000000 });
  assert.equal(secs.timestamp, 1755000000000, 'a seconds value must be scaled to ms');
});

test('change is null (not 0) when there is no previous close', () => {
  const t = normalizeTick({ instrument_token: 1, last_price: 100, ohlc: {}, depth: {} });
  assert.equal(t.change, null, 'a fabricated 0.00% is worse than a blank');
  assert.equal(t.percentChange, null);

  const withClose = normalizeTick({ instrument_token: 1, last_price: 110, ohlc: { close: 100 }, depth: {} });
  assert.equal(withClose.change, 10);
  assert.equal(withClose.percentChange, 10);
});
