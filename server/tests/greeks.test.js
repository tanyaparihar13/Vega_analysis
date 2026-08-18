'use strict';

/**
 * TIER 1 — the pricing engine, verified against finite differences.
 *
 * Every Greek is checked against a numerical derivative of the pricer rather
 * than against a hardcoded expected value. A hardcoded number only proves the
 * function still returns what it returned yesterday; a finite difference proves
 * it returns the DERIVATIVE it claims to be.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bs = require('../src/utils/blackScholes');
const ivm = require('../src/utils/impliedVolatility');

const F = 24000;
const K = 24000;
const T = 7 / 365;
const r = 0.065;
const sigma = 0.15;

const close = (a, b, tol, what) =>
  assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);

test('vega is quoted PER 1% of volatility, not per 1.00', () => {
  const g = bs.calculateGreeks76({ F, K, T, r, sigma, type: 'CE' });
  const p0 = bs.theoreticalPrice76({ F, K, T, r, sigma, type: 'CE' });
  const pUp1pct = bs.theoreticalPrice76({ F, K, T, r, sigma: sigma + 0.01, type: 'CE' });
  const pUp1full = bs.theoreticalPrice76({ F, K, T, r, sigma: sigma + 1.0, type: 'CE' });

  // THE unit lock. If someone ever removes the /100, this fails immediately.
  close(g.vega, pUp1pct - p0, 0.02, 'vega vs dPrice per +1% vol');
  assert.ok(Math.abs(g.vega - (pUp1full - p0)) > 100, 'vega must NOT be the per-1.00 figure');
});

test('delta matches a central difference in the forward', () => {
  const h = 1;
  for (const strike of [23000, 23800, 24000, 24200, 25000]) {
    for (const type of ['CE', 'PE']) {
      const g = bs.calculateGreeks76({ F, K: strike, T, r, sigma, type });
      const up = bs.theoreticalPrice76({ F: F + h, K: strike, T, r, sigma, type });
      const dn = bs.theoreticalPrice76({ F: F - h, K: strike, T, r, sigma, type });
      close(g.delta, (up - dn) / (2 * h), 1e-3, `delta ${type} ${strike}`);
    }
  }
});

test('delta signs: calls positive, puts negative, both bounded by e^(-rT)', () => {
  const disc = Math.exp(-r * T);
  // calculateGreeks76 rounds delta to 4dp, so a deep-ITM delta sitting a
  // fraction below e^(-rT) can round a hair above it. Allow half a unit in the
  // last place; anything larger is a real bound violation.
  const RND = 5e-5;
  for (const strike of [21000, 24000, 27000]) {
    const c = bs.calculateGreeks76({ F, K: strike, T, r, sigma, type: 'CE' });
    const p = bs.calculateGreeks76({ F, K: strike, T, r, sigma, type: 'PE' });
    assert.ok(c.delta >= 0 && c.delta <= disc + RND, `call delta in [0, e^-rT] at ${strike}`);
    assert.ok(p.delta <= 0 && p.delta >= -disc - RND, `put delta in [-e^-rT, 0] at ${strike}`);
    // Black-76 parity of deltas: Dc - Dp = e^(-rT)
    close(c.delta - p.delta, disc, 1e-3, `delta parity at ${strike}`);
  }
});

test('gamma matches a second central difference', () => {
  const h = 1;
  const g = bs.calculateGreeks76({ F, K, T, r, sigma, type: 'CE' });
  const p0 = bs.theoreticalPrice76({ F, K, T, r, sigma, type: 'CE' });
  const up = bs.theoreticalPrice76({ F: F + h, K, T, r, sigma, type: 'CE' });
  const dn = bs.theoreticalPrice76({ F: F - h, K, T, r, sigma, type: 'CE' });
  close(g.gamma, (up - 2 * p0 + dn) / (h * h), 1e-5, 'gamma');
});

test('gamma is identical for a call and a put at the same strike', () => {
  const c = bs.calculateGreeks76({ F, K, T, r, sigma, type: 'CE' });
  const p = bs.calculateGreeks76({ F, K, T, r, sigma, type: 'PE' });
  close(c.gamma, p.gamma, 1e-9, 'call/put gamma');
  close(c.vega, p.vega, 1e-9, 'call/put vega');
});

test('theta is the ANALYTIC derivative divided by 365 (per calendar day)', () => {
  const g = bs.calculateGreeks76({ F, K, T, r, sigma, type: 'CE' });
  // Analytic: -(F e^-rT phi(d1) sigma)/(2 sqrt(T)) + r*price, all over 365.
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + (sigma * sigma / 2) * T) / (sigma * sqrtT);
  const disc = Math.exp(-r * T);
  const price = bs.theoreticalPrice76({ F, K, T, r, sigma, type: 'CE' });
  const expected = ((-(F * disc * bs.normPDF(d1) * sigma) / (2 * sqrtT)) + r * price) / 365;
  close(g.theta, expected, 0.01, 'theta analytic');
  assert.ok(g.theta < 0, 'long ATM theta must be negative');
});

test('rho is per 1% of the rate', () => {
  const g = bs.calculateGreeks76({ F, K, T, r, sigma, type: 'CE' });
  const p0 = bs.theoreticalPrice76({ F, K, T, r, sigma, type: 'CE' });
  const pUp = bs.theoreticalPrice76({ F, K, T, r: r + 0.01, sigma, type: 'CE' });
  close(g.rho, pUp - p0, 0.01, 'rho vs dPrice per +1% rate');
});

test('put-call parity holds exactly under Black-76', () => {
  for (const strike of [22000, 23500, 24000, 25500]) {
    const c = bs.theoreticalPrice76({ F, K: strike, T, r, sigma, type: 'CE' });
    const p = bs.theoreticalPrice76({ F, K: strike, T, r, sigma, type: 'PE' });
    close(c - p, Math.exp(-r * T) * (F - strike), 1e-6, `parity at ${strike}`);
  }
});

test('option value rises with volatility (vega positive for long options)', () => {
  for (const type of ['CE', 'PE']) {
    let prev = -Infinity;
    for (const s of [0.05, 0.10, 0.15, 0.25, 0.40, 0.60]) {
      const px = bs.theoreticalPrice76({ F, K, T, r, sigma: s, type });
      assert.ok(px > prev, `${type} price must increase with sigma (${s})`);
      prev = px;
      assert.ok(bs.calculateGreeks76({ F, K, T, r, sigma: s, type }).vega > 0, 'vega > 0');
    }
  }
});

test('time value decays as expiry approaches', () => {
  let prev = Infinity;
  for (const days of [30, 14, 7, 3, 1, 0.25]) {
    const px = bs.theoreticalPrice76({ F, K, T: days / 365, r, sigma, type: 'CE' });
    assert.ok(px < prev, `ATM value must fall as T shrinks (${days}d)`);
    prev = px;
  }
});

test('degenerate inputs return zeros, never NaN', () => {
  for (const args of [
    { F: 0, K, T, r, sigma }, { F, K: 0, T, r, sigma },
    { F, K, T: 0, r, sigma }, { F, K, T, r, sigma: 0 },
  ]) {
    const g = bs.calculateGreeks76({ ...args, type: 'CE' });
    for (const [k, v] of Object.entries(g)) {
      assert.equal(v, 0, `${k} must be 0 for degenerate input`);
      assert.ok(Number.isFinite(v), `${k} must not be NaN`);
    }
  }
});

test('IV round-trips exactly wherever it is identifiable', () => {
  for (const trueSigma of [0.08, 0.15, 0.30, 0.75]) {
    for (const strike of [23000, 23500, 24000, 24500, 25000]) {
      const px = bs.theoreticalPrice76({ F, K: strike, T, r, sigma: trueSigma, type: 'CE' });
      const solved = ivm.impliedVolatility76({ marketPrice: px, F, K: strike, T, r, type: 'CE' });
      if (solved === null) continue; // refused as unidentifiable — checked below
      close(solved, trueSigma, 1e-3, `IV round trip K=${strike} sigma=${trueSigma}`);
    }
  }
});

test('IV returns null (never 0) when it cannot be identified', () => {
  // Deep ITM: quoted at intrinsic, carries no volatility information.
  const deep = bs.theoreticalPrice76({ F, K: 18000, T, r, sigma, type: 'CE' });
  assert.equal(ivm.impliedVolatility76({ marketPrice: deep, F, K: 18000, T, r, type: 'CE' }), null);
  // Below intrinsic — unsolvable by construction.
  assert.equal(ivm.impliedVolatility76({ marketPrice: 1, F, K: 18000, T, r, type: 'CE' }), null);
  // Above the ceiling.
  assert.equal(ivm.impliedVolatility76({ marketPrice: F, F, K: 24000, T, r, type: 'CE' }), null);
  // Nonsense inputs.
  assert.equal(ivm.impliedVolatility76({ marketPrice: 0, F, K, T, r, type: 'CE' }), null);
  assert.equal(ivm.impliedVolatility76({ marketPrice: 100, F, K, T: 0, r, type: 'CE' }), null);
});

test('greeks are consistent with the premium they were solved from', () => {
  // Full circle: price -> IV -> greeks -> reprice. Must return the input price.
  for (const strike of [23500, 24000, 24500]) {
    const px = bs.theoreticalPrice76({ F, K: strike, T, r, sigma: 0.18, type: 'PE' });
    const iv = ivm.impliedVolatility76({ marketPrice: px, F, K: strike, T, r, type: 'PE' });
    assert.notEqual(iv, null, `IV should solve at K=${strike}`);
    const g = bs.calculateGreeks76({ F, K: strike, T, r, sigma: iv, type: 'PE' });
    close(g.price, px, 0.02, `reprice at K=${strike}`);
  }
});
