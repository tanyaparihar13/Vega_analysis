'use strict';

/**
 * PRE-DEPLOYMENT VERIFICATION for the late-baseline recovery path (60f36d4).
 *
 * Two things this file exists to prove, because both are load-bearing claims
 * that were asserted before they were checked:
 *
 * 1. THE RECONSTRUCTION QUERY CANNOT MIX DAYS. earliestChain() is a NEW read
 *    against vega_chain_snapshots, added to recover a missed 09:16 baseline.
 *    A baseline is the origin of an entire session, so pulling YESTERDAY's
 *    chain into today would be the worst possible version of the date-mixing
 *    bug this branch has spent three commits eliminating — not a few stray
 *    rows in a table, but every value of the day silently displaced. It is
 *    scoped twice (snapshot_date AND a sampled_at floor) and both are asserted
 *    here against the real SQL.
 *
 * 2. THE SESSION'S FIRST SAMPLE IS 09:16, NOT 09:15, AND IT IS ~0 RATHER THAN
 *    EXACTLY 0. The baseline floor (b67ead6) defers capture to 09:16, and no
 *    point can exist before the baseline it is measured against — so the 09:15
 *    row visible in production today is an ARTEFACT of the stale baseline and
 *    will disappear. And `current - open` is only exactly zero when the two
 *    chains are identical; there is an awaited DB write between the baseline
 *    build and the first sample build, so a tick usually lands in between.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// The archive is off by default, and earliestChain short-circuits when it is,
// so the flag has to be set BEFORE vegaConfig is first required.
process.env.VEGA_STORE_RAW_CHAINS = 'true';

const queries = [];
const dbPath = require.resolve('../src/config/db');
const stub = new Module(dbPath, null);
stub.filename = dbPath;
stub.loaded = true;
stub.exports = {
  async query(sql, params = {}) {
    queries.push({ sql, params });
    if (/FROM vega_chain_snapshots/.test(sql)) {
      // A realistic archive holding BOTH sessions, so a query that failed to
      // scope by date would return yesterday's chain and pass silently.
      const rows = [
        { snapshot_date: '2026-08-19', sampled_at: '2026-08-19 03:46:00', expiry: '2026-08-25',
          chain: JSON.stringify([{ strike: 1, call: { vega: 111 }, put: { vega: 111 } }]) },
        { snapshot_date: '2026-08-20', sampled_at: '2026-08-20 03:46:00', expiry: '2026-08-25',
          chain: JSON.stringify([{ strike: 1, call: { vega: 222 }, put: { vega: 222 } }]) },
      ].filter((r) => r.snapshot_date === params.date)
       .filter((r) => (params.expiry ? r.expiry === params.expiry : true))
       .filter((r) => (params.cutoff ? r.sampled_at >= params.cutoff : true));
      return [rows];
    }
    return [[]];
  },
};
require.cache[dbPath] = stub;

const chainSnapshotStore = require('../src/services/chainSnapshotStore');
const cfg = require('../src/config/vegaConfig');
const vega = require('../src/services/vegaTimeseriesService');

test.beforeEach(() => { queries.length = 0; });

// ===========================================================================
// 1. THE RECONSTRUCTION QUERY IS DOUBLE-SCOPED BY DATE
// ===========================================================================

test('earliestChain is scoped by snapshot_date AND by a sampled_at floor', async () => {
  const got = await chainSnapshotStore.earliestChain('NIFTY', '2026-08-20', '2026-08-25');
  assert.ok(got, 'the archive has a chain for this session');
  assert.equal(got.chain[0].call.vega, 222, "today's chain, not yesterday's");

  const q = queries.find((x) => /vega_chain_snapshots/.test(x.sql));
  assert.match(q.sql, /snapshot_date = :date/, 'scoped by the trading day');
  assert.match(q.sql, /sampled_at >= :cutoff/, 'and by a floor inside that day');
  assert.match(q.sql, /expiry = :expiry/, 'and by expiry, which is a separate axis');
  assert.equal(q.params.date, '2026-08-20');

  // The cutoff is 09:16 IST expressed in UTC, because sampled_at is stored in
  // UTC. Getting this wrong by the 5.5h offset would silently widen the window
  // into the previous evening.
  assert.equal(q.params.cutoff, '2026-08-20 03:46:00',
    '09:16 IST == 03:46 UTC — the column is UTC, so the cutoff must be too');
});

test('asking for one session never returns the other', async () => {
  const a = await chainSnapshotStore.earliestChain('NIFTY', '2026-08-19', '2026-08-25');
  const b = await chainSnapshotStore.earliestChain('NIFTY', '2026-08-20', '2026-08-25');
  assert.equal(a.chain[0].call.vega, 111, '19-Aug returns the 19-Aug chain');
  assert.equal(b.chain[0].call.vega, 222, '20-Aug returns the 20-Aug chain');

  // A day with nothing archived yields null rather than the nearest thing it
  // can find — "no baseline" must never degrade into "some other day's".
  assert.equal(await chainSnapshotStore.earliestChain('NIFTY', '2026-08-18', '2026-08-25'), null);
});

test('a chain archived BEFORE the floor is not eligible to be the open', async () => {
  // 09:00 IST pre-open rows exist in the archive on some feeds. The baseline
  // floor exists because the board at that time still carries yesterday's
  // close, so such a row must not be reachable as a baseline.
  const q0 = await chainSnapshotStore.earliestChain('NIFTY', '2026-08-20', '2026-08-25', '09:16:00');
  assert.ok(q0, 'the 09:16 row itself is eligible');
  const cutoff = queries.at(-1).params.cutoff;
  assert.ok(cutoff > '2026-08-20 03:45:00',
    'the cutoff sits at or after 09:15 IST, never before the bell');
});

// ===========================================================================
// 2. THE FIRST SAMPLE OF A NORMAL SESSION
// ===========================================================================

test('no sample can exist before the baseline it is measured against', () => {
  // MARKET_OPEN_MIN is 09:15 and BASELINE_MIN_IST is 09:16, so there is one
  // minute in which sampling is "open" but no baseline may be taken yet.
  assert.equal(cfg.MARKET_OPEN_MIN, 555, '09:15 bell');
  assert.equal(cfg.BASELINE_MIN_IST, 556, '09:16 baseline floor (b67ead6)');
  assert.ok(cfg.BASELINE_MIN_IST > cfg.MARKET_OPEN_MIN,
    'the gap is deliberate — the 09:15 board still carries yesterday’s close');

  // computeDiffs returns null without a baseline, so that minute produces NO
  // row. The 09:15 rows in production today exist only because a STALE
  // baseline made entry.open truthy; once it is gone, so are they.
  assert.equal(vega.needsDayOpenCapture({ date: vega.todayIst(), open: null }), true,
    'at 09:15 the slot still has no baseline and keeps asking for one');
});

test('the first sample is EXACTLY zero only if the board did not move', () => {
  const { computePoint } = require('../src/utils/vegaMath');
  const chain = [
    { strike: 24250, call: { delta: 0.51, vega: 11.5 }, put: { delta: -0.48, vega: 11.5 } },
    { strike: 24300, call: { delta: 0.45, vega: 11.4 }, put: { delta: -0.54, vega: 11.4 } },
  ];
  const same = computePoint({
    currentChain: chain, openChain: chain, start: 0.05, deltaMax: 0.60, mode: 'dynamic',
  });
  assert.equal(same.callVegaDiff, 0);
  assert.equal(same.putVegaDiff, 0);
  assert.equal(same.vegaDiff, 0);

  /**
   * BUT NOT IN GENERAL. captureDayOpen builds the baseline chain, then AWAITS
   * persistDayOpen() — a real DB write — and only then does computeDiffs build
   * the chain for the first sample. That await yields the event loop, so the
   * ticker usually updates the forward in between and the two chains differ by
   * a fraction of a point of movement.
   *
   * The residual is bounded by how far the board can move in those few
   * milliseconds, which is small enough to round to 0.00-0.02 on the display —
   * and is a different order of magnitude from the +5.42 anchor error that a
   * late baseline produces. Both facts matter: "≈0" is the health check, and
   * "exactly 0" would be an over-claim.
   */
  const moved = chain.map((r) => ({
    strike: r.strike,
    call: { delta: r.call.delta, vega: r.call.vega + 0.0036 },
    put: { delta: r.put.delta, vega: r.put.vega - 0.0036 },
  }));
  const p = computePoint({
    currentChain: moved, openChain: chain, start: 0.05, deltaMax: 0.60, mode: 'dynamic',
  });
  assert.notEqual(p.callVegaDiff, 0, 'a tick between the two builds makes it non-zero');
  assert.ok(Math.abs(p.callVegaDiff) < 0.05,
    'but bounded by the movement, not by the morning — this is the ≈0 claim');
  assert.ok(Math.abs(p.callVegaDiff) < 5.42 / 100,
    'two orders of magnitude below the late-anchor error it replaces');
});
