'use strict';

/**
 * B-04 — THE EXPIRY THE USER SELECTED IS THE EXPIRY THEY GET.
 *
 * "If the user selects 11 August, the frontend must NEVER display 18 August."
 *
 * These tests drive the real subscribe handler with the instrument master
 * stubbed, and assert the server never answers with a different expiry than the
 * one asked for. The client-side half of the guard is asserted separately by
 * reproducing the acceptance rule from useVegaStream.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const instrumentService = require('../src/services/instrumentService');
const vega = require('../src/services/vegaTimeseriesService');
const stream = require('../src/services/vegaStreamService');
const subscriptionManager = require('../src/services/subscriptionManager');

const TRACKED = ['2026-08-11', '2026-08-18', '2026-08-25'];

/**
 * Stub the module OBJECTS in place. vegaStreamService captured references to
 * these same objects at require time, so replacing their methods is enough —
 * no module-loader tricks needed.
 */
function stubMaster(tracked = TRACKED) {
  const saved = {
    isReady: instrumentService.isReady,
    resolveSymbol: vega.resolveSymbol,
    trackedExpiries: vega.trackedExpiries,
    registerDemand: vega.registerDemand,
    releaseDemand: vega.releaseDemand,
    ensureSubscriptions: vega.ensureSubscriptions,
    getSeries: vega.getSeries,
    loadByDate: vega.loadByDate,
    persistResolutionFor: vega.persistResolutionFor,
    isIndex: vega.isIndex,
    todayIst: vega.todayIst,
    selectChain: subscriptionManager.selectChain,
    release: subscriptionManager.release,
  };

  instrumentService.isReady = () => true;
  vega.resolveSymbol = (s) => (String(s).toUpperCase() === 'NIFTY'
    ? { key: 'NIFTY', label: 'NIFTY', spotToken: 256265 } : null);
  vega.trackedExpiries = () => tracked.slice();
  vega.registerDemand = () => ({ changed: true, symbol: 'NIFTY', expiry: null });
  vega.releaseDemand = () => true;
  vega.ensureSubscriptions = () => null;
  vega.getSeries = () => [{ time: 1755000000, callVegaDiff: 1, putVegaDiff: -1, vegaDiff: -2 }];
  vega.loadByDate = async () => ({ points: [] });
  vega.persistResolutionFor = () => '5s';
  vega.isIndex = () => true;
  vega.todayIst = () => '2026-08-18';
  subscriptionManager.selectChain = () => ({ tokens: [], strikes: [] });
  subscriptionManager.release = () => {};

  return () => Object.assign(instrumentService, { isReady: saved.isReady })
    && Object.assign(vega, saved) && Object.assign(subscriptionManager, saved);
}

function fakeClient() {
  return { readyState: 1, messages: [], send(raw) { this.messages.push(JSON.parse(raw)); } };
}

async function subscribe(client, msg) {
  stream.handleMessage(client, { type: 'subscribe_vega', ...msg });
  // handleSubscribe is async internally (it may read MySQL for the warm start).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

test('a TRACKED expiry is honoured exactly', async () => {
  const restore = stubMaster();
  try {
    const client = fakeClient();
    await subscribe(client, { symbol: 'NIFTY', expiry: '2026-08-11', timeframe: '1m' });

    const sub = client.messages.find((m) => m.type === 'vega_subscribed');
    assert.ok(sub, 'must confirm the subscription');
    assert.equal(sub.expiry, '2026-08-11', 'must return the expiry that was asked for');
    stream.releaseClient(client);
  } finally { restore(); }
});

test('an UNTRACKED expiry is refused, never substituted', async () => {
  const restore = stubMaster();
  try {
    const client = fakeClient();
    // 2026-09-01 is not in TRACKED. The old code answered with 2026-08-11.
    await subscribe(client, { symbol: 'NIFTY', expiry: '2026-09-01', timeframe: '1m' });

    const sub = client.messages.find((m) => m.type === 'vega_subscribed');
    assert.equal(sub, undefined, 'MUST NOT confirm a subscription for another expiry');

    const un = client.messages.find((m) => m.type === 'vega_unavailable');
    assert.ok(un, 'must say the expiry is unavailable');
    assert.equal(un.expiry, '2026-09-01', 'and echo the expiry that was refused');
    assert.equal(un.reason, 'expiry-not-tracked');
    assert.deepEqual(un.expiries, TRACKED, 'and name what IS tracked');
    stream.releaseClient(client);
  } finally { restore(); }
});

test('no message ever carries an expiry other than the one requested', async () => {
  const restore = stubMaster();
  try {
    for (const requested of ['2026-08-11', '2026-08-18', '2026-08-25', '2026-09-01', '2025-01-01']) {
      const client = fakeClient();
      await subscribe(client, { symbol: 'NIFTY', expiry: requested, timeframe: '1m' });
      for (const m of client.messages) {
        if (m.expiry != null) {
          assert.equal(m.expiry, requested,
            `a ${m.type} message carried ${m.expiry} when ${requested} was requested`);
        }
      }
      stream.releaseClient(client);
    }
  } finally { restore(); }
});

test('an ABSENT expiry may default to the nearest tracked one', async () => {
  const restore = stubMaster();
  try {
    const client = fakeClient();
    await subscribe(client, { symbol: 'NIFTY', timeframe: '1m' });
    const sub = client.messages.find((m) => m.type === 'vega_subscribed');
    assert.ok(sub, 'a request with no expiry is allowed to resolve to a default');
    assert.equal(sub.expiry, TRACKED[0], 'and the default is the nearest');
    stream.releaseClient(client);
  } finally { restore(); }
});

test('no tracked expiries at all is reported, not faked', async () => {
  const restore = stubMaster([]);
  try {
    const client = fakeClient();
    await subscribe(client, { symbol: 'NIFTY', timeframe: '1m' });
    const un = client.messages.find((m) => m.type === 'vega_unavailable');
    assert.ok(un, 'must report unavailability');
    assert.equal(un.reason, 'no-expiries');
    assert.equal(client.messages.some((m) => m.type === 'vega_subscribed'), false);
    stream.releaseClient(client);
  } finally { restore(); }
});

// ---------------------------------------------------------------------------
// The client-side half of the guard.
// Reproduces the acceptance rule from useVegaStream.js exactly.
// ---------------------------------------------------------------------------
const accepts = (msg, want) =>
  msg.symbol === want.symbol && msg.expiry === want.expiry && msg.timeframe === want.timeframe;

test('the client rejects a back-fill for a different expiry', () => {
  const want = { symbol: 'NIFTY', expiry: '2026-08-11', timeframe: '1m' };

  assert.equal(accepts({ symbol: 'NIFTY', expiry: '2026-08-11', timeframe: '1m' }, want), true,
    'the matching payload is accepted');

  // THE bug: this used to be accepted because only symbol and timeframe were compared.
  assert.equal(accepts({ symbol: 'NIFTY', expiry: '2026-08-18', timeframe: '1m' }, want), false,
    '18 August must never be accepted while 11 August is selected');

  assert.equal(accepts({ symbol: 'BANKNIFTY', expiry: '2026-08-11', timeframe: '1m' }, want), false);
  assert.equal(accepts({ symbol: 'NIFTY', expiry: '2026-08-11', timeframe: '5m' }, want), false);
  assert.equal(accepts({ symbol: 'NIFTY', expiry: undefined, timeframe: '1m' }, want), false);
});

test('switching expiry A -> B -> A cannot leave B data in the A series', () => {
  const A = { symbol: 'NIFTY', expiry: '2026-08-11', timeframe: '1m' };
  const B = { symbol: 'NIFTY', expiry: '2026-08-18', timeframe: '1m' };

  // A late in-flight point for B, arriving after the user switched back to A.
  const lateB = { symbol: 'NIFTY', expiry: '2026-08-18', timeframe: '1m', point: { time: 1, callVegaDiff: 999 } };
  assert.equal(accepts(lateB, A), false, 'a stale B point must be dropped while A is selected');

  const goodA = { symbol: 'NIFTY', expiry: '2026-08-11', timeframe: '1m', point: { time: 1, callVegaDiff: 5 } };
  assert.equal(accepts(goodA, A), true);
  assert.equal(accepts(goodA, B), false);
});

/**
 * resolveExpiry() reads vega_timeseries, and it calls listExpiries through the
 * module-local binding, so it cannot be stubbed from outside. This assertion is
 * therefore REAL or it is skipped — it is never faked. It runs on any machine
 * with the database reachable (i.e. the VPS), and reports honestly on one
 * without.
 */
async function dbReachable() {
  try {
    await require('../src/config/db').query('SELECT 1');
    return true;
  } catch { return false; }
}

test('the REST path filters expiry exactly and fails closed', async (t) => {
  if (!(await dbReachable())) {
    return t.skip('database not reachable from this machine — run on the VPS');
  }
  // resolveExpiry passes an unmatched request THROUGH rather than substituting,
  // so the SQL filter returns zero rows: an honest empty chart, never another
  // contract's data.
  const available = await vega.listExpiries('NIFTY', vega.todayIst());
  const known = available.map((e) => e.expiry);

  const unmatched = await vega.resolveExpiry('NIFTY', vega.todayIst(), '1999-01-01');
  assert.equal(unmatched.expiry, '1999-01-01', 'the REQUESTED expiry is passed through unchanged');
  assert.equal(unmatched.matched, false, 'and is flagged as not matching');
  assert.equal(known.includes(unmatched.expiry), false, 'and is not swapped for a known one');

  if (known.length) {
    const matched = await vega.resolveExpiry('NIFTY', vega.todayIst(), known[0]);
    assert.equal(matched.expiry, known[0]);
    assert.equal(matched.matched, true);

    const absent = await vega.resolveExpiry('NIFTY', vega.todayIst(), null);
    assert.equal(absent.expiry, known[0], 'no request resolves to the nearest');
  }
});
