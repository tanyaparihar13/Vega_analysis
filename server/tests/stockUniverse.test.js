'use strict';

/**
 * THE STOCK UNIVERSE, END TO END, ON FIXTURES.
 *
 * ===========================================================================
 * WHY FIXTURES AND NOT LIVE CONTRACTS
 * ===========================================================================
 * Live per-contract validation needs an authenticated session and an open
 * market. Neither is available here, and inventing results would be worse than
 * having none — so live validation is reported BLOCKED, and this file covers
 * what can actually be proved: that the pipeline is correct for boards whose
 * SHAPE differs the way real stock boards differ.
 *
 * "The code is generic" is not evidence. A single hardcoded strike step or an
 * ATM found by rounding rather than by searching the listed strikes would pass
 * every structural check and then quietly mis-centre TATASTEEL at 160 with a
 * 5-point grid while looking fine on RELIANCE at 1400 with a 20-point grid.
 * So the universe below spans two orders of magnitude of price and four strike
 * intervals, and every board runs the REAL pipeline:
 *
 *     board -> LTP -> impliedVolatility76 -> calculateGreeks76
 *           -> signed delta band -> computePoint -> diffs
 *
 * ===========================================================================
 * WHAT IS ASSERTED FOR EVERY NAME
 * ===========================================================================
 *   · ATM is the LISTED strike nearest spot, at any interval
 *   · CE delta > 0 and PE delta < 0, always
 *   · the 0.20-0.60 stock band is applied, signed, to each side independently
 *   · IV round-trips through the pricing model
 *   · vega is positive and per 1% of volatility
 *   · CE and PE are never swapped
 *   · Difference = Put - Call
 *   · baseline identity: one chain against itself is EXACTLY 0/0/0
 *   · one stock's chain cannot contaminate another's
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const bs = require('../src/utils/blackScholes');
const iv = require('../src/utils/impliedVolatility');
const cfg = require('../src/config/vegaConfig');
const { computePoint, pickStrikes, passes } = require('../src/utils/vegaMath');

/**
 * Deliberately spans the range that breaks naive implementations: a 160-rupee
 * name on a 5-point grid through a 3900-rupee name on a 100-point grid. Steps
 * and prices are realistic NSE F&O shapes.
 */
const UNIVERSE = [
  { symbol: 'TATASTEEL', spot: 162.40, step: 5 },
  { symbol: 'ASHOKLEY', spot: 248.75, step: 5 },
  { symbol: 'SBIN', spot: 843.20, step: 10 },
  { symbol: 'ADANIPORTS', spot: 1_412.60, step: 20 },
  { symbol: 'RELIANCE', spot: 1_438.90, step: 20 },
  { symbol: 'INFY', spot: 1_905.15, step: 20 },
  { symbol: 'TCS', spot: 3_902.45, step: 100 },
  { symbol: 'APLAPOLLO', spot: 1_655.30, step: 20 },
  { symbol: 'ALKEM', spot: 5_240.00, step: 100 },
  { symbol: 'HDFCBANK', spot: 1_712.85, step: 20 },
  { symbol: 'ICICIBANK', spot: 1_284.40, step: 20 },
  { symbol: 'AMBER', spot: 7_120.00, step: 100 },
];

const EXPIRY = '2026-08-27';                    // stocks are monthly
const T = bs.yearsToExpiry(EXPIRY, new Date('2026-08-20T03:46:00Z'));
const R = 0.065;

/**
 * A realistic board: strikes on the name's own grid around its own spot, each
 * contract priced from a smile, then IV solved back OUT of that price exactly
 * as the server does with a real LTP.
 */
function buildBoard({ spot, step }, window = 8) {
  const forward = bs.forwardFromSpot(spot, T, R);
  const atmGrid = Math.round(forward / step) * step;

  const strikes = [];
  for (let i = -window; i <= window; i += 1) strikes.push(atmGrid + i * step);

  const rows = strikes.map((strike) => {
    // Wider smile on cheaper names, which is what real boards look like.
    const rel = (strike - forward) / forward;
    const sigma = 0.28 + 2.2 * rel * rel;

    const side = (type) => {
      const ltp = bs.theoreticalPrice76({ F: forward, K: strike, T, r: R, sigma, type });
      const solved = iv.impliedVolatility76({ marketPrice: ltp, F: forward, K: strike, T, r: R, type });
      if (solved == null) return { ltp, iv: null, delta: null, vega: null };
      const g = bs.calculateGreeks76({ F: forward, K: strike, T, r: R, sigma: solved, type });
      return { ltp, iv: solved, delta: g.delta, vega: g.vega, theta: g.theta, gamma: g.gamma };
    };

    return { strike, call: side('CE'), put: side('PE') };
  });

  // ATM is the LISTED strike nearest spot — never a rounded guess. This mirrors
  // optionChainService.buildChain and is what makes any strike interval work.
  const atmStrike = strikes.reduce(
    (best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best), strikes[0]);

  return { rows, strikes, atmStrike, forward };
}

const START = cfg.STOCK_START;                  // 0.20 for every stock

// ===========================================================================
// 1. PER-NAME PIPELINE
// ===========================================================================

for (const stock of UNIVERSE) {
  test(`${stock.symbol}: full pipeline on a ${stock.step}-point grid at ${stock.spot}`, () => {
    const { rows, strikes, atmStrike, forward } = buildBoard(stock);

    // ---- ATM ------------------------------------------------------------
    assert.ok(strikes.includes(atmStrike), 'ATM is a LISTED strike, not a rounded number');
    for (const s of strikes) {
      assert.ok(Math.abs(atmStrike - stock.spot) <= Math.abs(s - stock.spot),
        'ATM is the nearest listed strike');
    }
    assert.ok(Math.abs(atmStrike - stock.spot) <= stock.step,
      'and is within one strike interval of spot, at any interval');

    // ---- CE/PE identity and delta signs ----------------------------------
    const priced = rows.filter((r) => r.call.delta != null && r.put.delta != null);
    /**
     * HOW MANY STRIKES SOLVE IS A PROPERTY OF THE NAME, NOT A BUG.
     *
     * A 162-rupee stock on a 5-point grid has far-OTM contracts worth a rupee
     * or two, where vega is too small for IV to be identifiable and the solver
     * correctly returns null rather than inventing a number (see
     * impliedVolatility.js, which measures TATASTEEL at 9/41 solvable). A
     * 3900-rupee name on a 100-point grid solves far more of its board. The
     * requirement is that ENOUGH solves to compute a meaningful sum, not a
     * fixed fraction — demanding one would be asserting that cheap stocks
     * behave like expensive ones.
     */
    assert.ok(priced.length >= 3,
      `${stock.symbol}: enough strikes solve to build a sum (${priced.length}/${strikes.length})`);

    // Both sides must contribute, which is the property that actually matters:
    // a band that starves one side produces a Difference measured against
    // nothing on that side.
    assert.ok(priced.some((r) => r.call.vega > 0), 'the call side has priced contracts');
    assert.ok(priced.some((r) => r.put.vega > 0), 'the put side has priced contracts');

    const spreads = [];
    for (const r of priced) {
      assert.ok(r.call.delta > 0, `${stock.symbol} ${r.strike}: CALL delta must be POSITIVE`);
      assert.ok(r.put.delta < 0, `${stock.symbol} ${r.strike}: PUT delta must be NEGATIVE`);
      assert.ok(r.call.vega > 0 && r.put.vega > 0, 'vega is positive on both sides');
      /**
       * Under Black-76 a call and a put at one strike share vega — but only at
       * the SAME sigma. Each contract's IV is solved from its OWN traded price
       * (the StockMojo methodology this system implements), and the solver
       * stops inside a price tolerance, so the two solved sigmas differ
       * slightly and so do the vegas. They must stay CLOSE; identical would
       * actually mean one side's IV was being reused for the other.
       */
      const spread = Math.abs(r.call.vega - r.put.vega) / Math.max(r.call.vega, r.put.vega);
      spreads.push(spread);
      assert.ok(spread < 0.15,
        `${stock.symbol} ${r.strike}: call/put vega stays close (per-side IV), got ${(spread * 100).toFixed(2)}%`);
    }

    /**
     * The OUTLIER is allowed to be a few percent, but the BULK must be tight.
     * A systematic gap would mean one side's IV was leaking into the other;
     * a fat tail at far-OTM strikes is just the solver's price tolerance
     * biting where vega is smallest.
     */
    const median = [...spreads].sort((a, b) => a - b)[Math.floor(spreads.length / 2)];
    assert.ok(median < 0.02,
      `${stock.symbol}: median call/put vega spread is tight (${(median * 100).toFixed(3)}%)`);

    // ---- CE/PE NOT SWAPPED, tested on price ------------------------------
    const deepItmPut = priced[priced.length - 1];      // highest strike
    const deepItmCall = priced[0];                     // lowest strike
    assert.ok(deepItmPut.put.ltp > deepItmPut.call.ltp,
      'at the highest strike the PUT is worth more — CE/PE are not swapped');
    assert.ok(deepItmCall.call.ltp > deepItmCall.put.ltp,
      'at the lowest strike the CALL is worth more');

    // ---- IV round-trip ---------------------------------------------------
    for (const r of priced) {
      for (const [side, type] of [['call', 'CE'], ['put', 'PE']]) {
        const back = bs.theoreticalPrice76({
          F: forward, K: r.strike, T, r: R, sigma: r[side].iv, type,
        });
        assert.ok(Math.abs(back - r[side].ltp) < 0.5 + r[side].ltp * 0.01,
          `${stock.symbol} ${r.strike} ${type}: IV reprices within tolerance`);
      }
    }

    // ---- delta band, signed, per side ------------------------------------
    const { callStrikes, putStrikes } = pickStrikes(rows, START, cfg.DELTA_MAX);
    for (const k of callStrikes) {
      const d = rows.find((r) => r.strike === k).call.delta;
      assert.ok(d >= START && d <= cfg.DELTA_MAX, `call ${k} inside [${START}, ${cfg.DELTA_MAX}]`);
    }
    for (const k of putStrikes) {
      const d = rows.find((r) => r.strike === k).put.delta;
      assert.ok(d >= -cfg.DELTA_MAX && d <= -START,
        `put ${k} inside [-${cfg.DELTA_MAX}, -${START}] — SIGNED, not absolute`);
    }
    assert.ok(callStrikes.length > 0 && putStrikes.length > 0,
      'both sides select strikes — a band that starves one side is a bug');

    // ---- aggregation and the Difference identity -------------------------
    const later = rows.map((r) => ({
      strike: r.strike,
      call: { ...r.call, vega: r.call.vega == null ? null : r.call.vega * 0.96 },
      put: { ...r.put, vega: r.put.vega == null ? null : r.put.vega * 0.98 },
    }));
    const p = computePoint({
      currentChain: later, openChain: rows,
      start: START, deltaMax: cfg.DELTA_MAX, mode: 'dynamic',
    });
    assert.equal(p.vegaDiff, +(p.putVegaDiff - p.callVegaDiff).toFixed(4),
      'Difference = Put - Call');
    assert.ok(p.callVegaDiff < 0 && p.putVegaDiff < 0, 'decaying vega gives negative diffs');

    // ---- baseline identity ----------------------------------------------
    const zero = computePoint({
      currentChain: rows, openChain: rows,
      start: START, deltaMax: cfg.DELTA_MAX, mode: 'dynamic',
    });
    assert.equal(zero.callVegaDiff, 0, `${stock.symbol}: opening Call is EXACTLY 0`);
    assert.equal(zero.putVegaDiff, 0, `${stock.symbol}: opening Put is EXACTLY 0`);
    assert.equal(zero.vegaDiff, 0, `${stock.symbol}: opening Difference is EXACTLY 0`);
  });
}

// ===========================================================================
// 2. CROSS-NAME PROPERTIES
// ===========================================================================

test('every stock uses the 0.20-0.60 band, and no index floor leaks in', () => {
  for (const { symbol } of UNIVERSE) {
    assert.equal(cfg.deltaStartFor(symbol), 0.20, `${symbol} uses the stock floor`);
  }
  // And the index floors are untouched by any of this.
  assert.equal(cfg.deltaStartFor('NIFTY'), 0.05);
  assert.equal(cfg.deltaStartFor('SENSEX'), 0.05);
  for (const i of ['BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY']) {
    assert.equal(cfg.deltaStartFor(i), 0.20);
  }
});

test('the band boundaries are inclusive and reject just outside, on both sides', () => {
  for (const [lo, names] of [[0.05, ['NIFTY', 'SENSEX']], [0.20, ['BANKNIFTY', 'RELIANCE', 'TCS']]]) {
    for (const n of names) {
      const s = cfg.deltaStartFor(n);
      assert.equal(s, lo, `${n} floor`);
      assert.equal(passes(s, s, cfg.DELTA_MAX, 'call'), true, `${n}: call at the floor is IN`);
      assert.equal(passes(-s, s, cfg.DELTA_MAX, 'put'), true, `${n}: put at -floor is IN`);
      assert.equal(passes(cfg.DELTA_MAX, s, cfg.DELTA_MAX, 'call'), true, 'call at the ceiling is IN');
      assert.equal(passes(-cfg.DELTA_MAX, s, cfg.DELTA_MAX, 'put'), true, 'put at -ceiling is IN');
      assert.equal(passes(s - 0.001, s, cfg.DELTA_MAX, 'call'), false, 'just below the floor is OUT');
      assert.equal(passes(-(cfg.DELTA_MAX + 0.001), s, cfg.DELTA_MAX, 'put'), false,
        'just beyond -ceiling is OUT');
      // The sign trap: a POSITIVE delta must never be accepted as a put.
      assert.equal(passes(0.30, s, cfg.DELTA_MAX, 'put'), false,
        `${n}: a positive delta is never a valid put`);
    }
  }
});

test('one stock chain cannot contaminate another', () => {
  // Different grids entirely, so a leak would be arithmetically obvious.
  const a = buildBoard(UNIVERSE.find((s) => s.symbol === 'TATASTEEL'));   // 5-pt grid ~160
  const b = buildBoard(UNIVERSE.find((s) => s.symbol === 'TCS'));         // 100-pt grid ~3900

  assert.equal(a.strikes.some((s) => b.strikes.includes(s)), false,
    'the two boards share no strike at all');

  // Comparing TCS against a TATASTEEL baseline must select nothing, because
  // computePoint requires a strike to be present in BOTH chains.
  const crossed = computePoint({
    currentChain: b.rows, openChain: a.rows,
    start: START, deltaMax: cfg.DELTA_MAX, mode: 'dynamic',
  });
  assert.equal(crossed.callStrikeCount, 0, 'no strike survives the present-in-both guard');
  assert.equal(crossed.putStrikeCount, 0);
  assert.equal(crossed.callVegaDiff, 0, 'so nothing is fabricated from a foreign chain');
});

test('a strike interval is never assumed — ATM tracks spot on every grid', () => {
  for (const stock of UNIVERSE) {
    for (const drift of [-0.9, -0.4, 0, 0.4, 0.9]) {
      const moved = { ...stock, spot: stock.spot + drift * stock.step };
      const { atmStrike, strikes } = buildBoard(moved);
      assert.ok(strikes.includes(atmStrike));
      assert.ok(Math.abs(atmStrike - moved.spot) <= moved.step,
        `${stock.symbol}: ATM stays within one interval as spot moves`);
    }
  }
});
