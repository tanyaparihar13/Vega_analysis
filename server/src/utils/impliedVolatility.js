const {
  theoreticalPrice, rawVega, isCallType,
  theoreticalPrice76, rawVega76,
} = require('./blackScholes');

/**
 * Kite does not return implied volatility. It has to be solved for.
 *
 * Strategy: Newton-Raphson (fast, ~4-6 iterations near the money), falling
 * back to bisection when Newton diverges — which it reliably does for deep
 * OTM strikes where vega approaches zero and the derivative step explodes.
 *
 * Returns null rather than a number when IV is genuinely undefined. Render
 * those cells blank; showing 0.00 implies a real 0% vol, which is wrong and
 * will mislead anyone reading the chain.
 */

const MIN_SIGMA = 0.001;   // 0.1%
const MAX_SIGMA = 5.0;     // 500%
const NEWTON_ITERATIONS = 50;
const BISECTION_ITERATIONS = 100;

// Below this vega, price barely responds to volatility, so the solved sigma is
// numerically meaningless — a one-tick price move swings it by whole percent.
// This is why deep ITM strikes show blank IV on real terminals rather than a
// confident-looking wrong number.
const MIN_IDENTIFIABLE_VEGA = 2.0;

// An option quoted at (or a whisker above) pure intrinsic carries no volatility
// information at all — deep ITM contracts trade this way constantly. Solving
// anyway produces a confident-looking number that is pure numerical noise.
const MIN_TIME_VALUE = 0.05;

// ===========================================================================
// IDENTIFIABILITY (B-03)
// ===========================================================================
/**
 * MIN_IDENTIFIABLE_VEGA is an ABSOLUTE rupee threshold applied to a quantity
 * that is proportional to the underlying's price:
 *
 *     rawVega = F · e^(−rT) · φ(d1) · √T          →  rawVega ∝ F
 *
 * So the same constant is ~150x stricter on a Rs.160 stock than on a 24,000
 * index. Measured over 41 strikes either side of ATM at 7d / 30% vol:
 *
 *     NIFTY     24000   41/41 solvable      22 inside the 0.20-0.60 band
 *     RELIANCE   1400   16/41                3
 *     TATASTEEL   160    9/41                3
 *     sub-Rs.10 name     0/41                0
 *
 * ---------------------------------------------------------------------------
 * MEASURED CONCLUSION: THIS DOES **NOT** AFFECT THE VEGA SUMS.
 * ---------------------------------------------------------------------------
 * The initial audit claimed the absolute threshold was pulling contracts out of
 * the Call/Put Vega totals for stocks. Measurement (tests/materialChanges.test.js)
 * shows that is WRONG, and the correction matters enough to record here:
 *
 *     underlying   strikes with |delta| in [0.20, 0.60]   ...of which solvable
 *     NIFTY                        22                            22
 *     RELIANCE                      3                             3
 *     SBIN                          3                             3
 *     TATASTEEL                     3                             3
 *
 * Every in-band strike is solvable on every underlying. The threshold rejects
 * only contracts that were ALREADY outside the delta band and therefore never
 * entered the sums. Its effect is confined to blanking IV/Greek cells in the
 * option-chain table — which is the behaviour it was written for, and correct.
 *
 * The real reason a stock's Vega total is built from ~3 contracts while an
 * index's uses ~22 is the STRIKE GRID: a stock's listed strike step is coarse
 * relative to its 7-day move, so few strikes land between delta 0.20 and 0.60.
 * That is market structure, not a defect, and no threshold change alters it.
 * (Widening the band for stocks would — but that is a product decision about
 * what the number means, not a bug fix.)
 *
 * THE RELATIVE RULE, retained as an opt-in. Identifiability is not "vega is big
 * enough"; it is "the price is quoted finely enough for sigma to be pinned
 * down". One tick of price moves the solved sigma by approximately
 *
 *     dSigma ~= tickSize / rawVega
 *
 * which is the scale-invariant way to state the same idea. It is kept because
 * it is the mathematically defensible form of the test and because the
 * option-chain display question is real. It is NOT recommended for activation:
 * measured coverage under it is at best equal to the absolute rule, and at the
 * originally-proposed 0.005 tolerance it is materially WORSE (RELIANCE 16 -> 12
 * solvable strikes, TATASTEEL 9 -> 0). The default tolerance below is 0.02,
 * which reproduces absolute-mode coverage closely on every tested underlying.
 *
 * DEFAULT IS 'absolute' — the existing behaviour, bit for bit. Leave it there
 * unless you have a specific reason and a side-by-side session to compare.
 * call_strike_count / put_strike_count in vega_timeseries record exactly how
 * many contracts each sum was built from, which is the measurement to watch.
 */
const IDENTIFIABILITY_MODE =
  String(process.env.VEGA_IV_IDENTIFIABILITY || 'absolute').toLowerCase() === 'relative'
    ? 'relative'
    : 'absolute';

/**
 * Tolerated sigma uncertainty per one tick of price. 0.02 == 2 vol points.
 *
 * CALIBRATED, not guessed. Measured solvable-strike counts (41-strike board,
 * 7d, 30% vol) against the absolute rule this would replace:
 *
 *     tolerance   NIFTY  RELIANCE  SBIN  TATASTEEL
 *     absolute     41       16      18       9      <- current behaviour
 *     0.005        41       12      12       0      <- materially worse
 *     0.01         41       14      14       5
 *     0.02         41       16      16       9      <- parity
 *     0.05         41       16      18      11
 *
 * 0.02 is the value at which the relative rule reproduces the absolute rule's
 * coverage on every tested underlying, so switching modes is close to a no-op
 * rather than a silent widening.
 */
const MAX_SIGMA_UNCERTAINTY = (() => {
  const n = Number(process.env.VEGA_IV_MAX_SIGMA_UNCERTAINTY);
  return Number.isFinite(n) && n > 0 ? n : 0.02;
})();

const DEFAULT_TICK_SIZE = 0.05;

/**
 * Is a solved sigma trustworthy at this point on the surface?
 * @param {number} rawVegaAtSigma  d(price)/d(sigma), per 1.0 of sigma
 * @param {number} [tickSize]      the contract's own tick size
 */
function isIdentifiable(rawVegaAtSigma, tickSize = DEFAULT_TICK_SIZE) {
  if (!(rawVegaAtSigma > 0)) return false;
  if (IDENTIFIABILITY_MODE === 'absolute') return rawVegaAtSigma >= MIN_IDENTIFIABLE_VEGA;
  const tick = tickSize > 0 ? tickSize : DEFAULT_TICK_SIZE;
  return tick / rawVegaAtSigma <= MAX_SIGMA_UNCERTAINTY;
}

/**
 * The minimum time value a quote must carry to hold any volatility information.
 * Absolute mode keeps the flat Rs.0.05; relative mode scales with the forward so
 * a cheap stock is not held to an index's standard.
 */
function minTimeValueFor(F, tickSize = DEFAULT_TICK_SIZE) {
  if (IDENTIFIABILITY_MODE === 'absolute') return MIN_TIME_VALUE;
  return Math.max(tickSize > 0 ? tickSize : DEFAULT_TICK_SIZE, (Number(F) || 0) * 2e-5);
}

// Absolute tolerance is too loose on a 1,500-rupee ITM contract and too tight
// on a 0.05 far-OTM one. Scale it.
function priceTolerance(marketPrice) {
  return Math.max(0.001, marketPrice * 1e-5);
}

function intrinsicValue({ S, K, T, r, type }) {
  return isCallType(type)
    ? Math.max(0, S - K * Math.exp(-r * T))
    : Math.max(0, K * Math.exp(-r * T) - S);
}

function impliedVolatility({ marketPrice, S, K, T, r = 0.065, type = 'CE', tickSize = DEFAULT_TICK_SIZE }) {
  if (!(marketPrice > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;

  // Below intrinsic there is no volatility that reproduces this price — the
  // quote is stale or crossed. Happens constantly on illiquid far strikes.
  const intrinsic = intrinsicValue({ S, K, T, r, type });
  if (marketPrice - intrinsic < minTimeValueFor(S, tickSize)) return null;

  // Above the theoretical max (S for a call, K*e^-rT for a put) it is also
  // unsolvable.
  const upperBound = isCallType(type) ? S : K * Math.exp(-r * T);
  if (marketPrice >= upperBound) return null;

  const tol = priceTolerance(marketPrice);

  // --- Newton-Raphson ---
  // Brenner-Subrahmanyam gives a decent ATM starting guess and cuts iterations.
  let sigma = Math.min(
    Math.max(Math.sqrt((2 * Math.PI) / T) * (marketPrice / S), 0.05),
    2.0
  );

  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const price = theoreticalPrice({ S, K, T, r, sigma, type });
    const diff = price - marketPrice;

    if (Math.abs(diff) < tol) {
      return finalise(sigma, { S, K, T, r, tickSize });
    }

    const vega = rawVega({ S, K, T, r, sigma });
    if (!(vega > 1e-8)) break; // derivative too flat — Newton is unusable here

    const next = sigma - diff / vega;
    if (!Number.isFinite(next) || next <= MIN_SIGMA || next >= MAX_SIGMA) break;
    sigma = next;
  }

  // --- Bisection fallback ---
  // Price is monotonically increasing in sigma, so this always converges if a
  // root exists in the bracket.
  let lo = MIN_SIGMA;
  let hi = MAX_SIGMA;

  if (theoreticalPrice({ S, K, T, r, sigma: hi, type }) < marketPrice) return null;
  if (theoreticalPrice({ S, K, T, r, sigma: lo, type }) > marketPrice) return null;

  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const price = theoreticalPrice({ S, K, T, r, sigma: mid, type });
    if (Math.abs(price - marketPrice) < tol) return finalise(mid, { S, K, T, r, tickSize });
    if (price > marketPrice) hi = mid;
    else lo = mid;
  }

  return finalise((lo + hi) / 2, { S, K, T, r, tickSize });
}

/**
 * Accepts a solved sigma only if it is inside the valid band AND vega at that
 * point is large enough for the answer to mean anything.
 */
function finalise(sigma, { S, K, T, r, tickSize = DEFAULT_TICK_SIZE }) {
  if (!Number.isFinite(sigma) || sigma <= MIN_SIGMA || sigma >= MAX_SIGMA) return null;
  if (!isIdentifiable(rawVega({ S, K, T, r, sigma }), tickSize)) return null;
  return Math.round(sigma * 10000) / 10000;
}

// ===========================================================================
// BLACK-76 IV — solves against the FORWARD instead of spot
// ===========================================================================
/**
 * Same Newton -> bisection strategy and the same refusal to invent a number
 * when IV is not identifiable; only the pricing model differs. See
 * blackScholes.calculateGreeks76 for why index options are priced off the
 * future rather than the index level.
 *
 * @param {{marketPrice:number, F:number, K:number, T:number, r?:number, type?:string}} args
 * @returns {number|null} sigma as a decimal, or null when unsolvable
 */
function impliedVolatility76({ marketPrice, F, K, T, r = 0.065, type = 'CE', tickSize = DEFAULT_TICK_SIZE }) {
  if (!(marketPrice > 0) || !(F > 0) || !(K > 0) || !(T > 0)) return null;

  const discount = Math.exp(-r * T);

  // Under Black-76 the intrinsic floor is discounted too.
  const intrinsic = isCallType(type)
    ? Math.max(0, discount * (F - K))
    : Math.max(0, discount * (K - F));
  if (marketPrice - intrinsic < minTimeValueFor(F, tickSize)) return null;

  // Price ceiling: a call cannot exceed the discounted forward, a put cannot
  // exceed the discounted strike.
  const upperBound = isCallType(type) ? discount * F : discount * K;
  if (marketPrice >= upperBound) return null;

  const tol = priceTolerance(marketPrice);

  const finalise76 = (sigma) => {
    if (!Number.isFinite(sigma) || sigma <= MIN_SIGMA || sigma >= MAX_SIGMA) return null;
    if (!isIdentifiable(rawVega76({ F, K, T, r, sigma }), tickSize)) return null;
    return Math.round(sigma * 10000) / 10000;
  };

  // --- Newton-Raphson ---
  let sigma = Math.min(Math.max(Math.sqrt((2 * Math.PI) / T) * (marketPrice / F), 0.05), 2.0);

  for (let i = 0; i < NEWTON_ITERATIONS; i++) {
    const price = theoreticalPrice76({ F, K, T, r, sigma, type });
    const diff = price - marketPrice;
    if (Math.abs(diff) < tol) return finalise76(sigma);

    const vega = rawVega76({ F, K, T, r, sigma });
    if (!(vega > 1e-8)) break;

    const next = sigma - diff / vega;
    if (!Number.isFinite(next) || next <= MIN_SIGMA || next >= MAX_SIGMA) break;
    sigma = next;
  }

  // --- Bisection fallback ---
  let lo = MIN_SIGMA;
  let hi = MAX_SIGMA;
  if (theoreticalPrice76({ F, K, T, r, sigma: hi, type }) < marketPrice) return null;
  if (theoreticalPrice76({ F, K, T, r, sigma: lo, type }) > marketPrice) return null;

  for (let i = 0; i < BISECTION_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    const price = theoreticalPrice76({ F, K, T, r, sigma: mid, type });
    if (Math.abs(price - marketPrice) < tol) return finalise76(mid);
    if (price > marketPrice) hi = mid;
    else lo = mid;
  }

  return finalise76((lo + hi) / 2);
}

module.exports = {
  impliedVolatility, impliedVolatility76, intrinsicValue,
  // Exported so the test suite and /api/vega/status can report which rule is
  // live without duplicating the env parsing.
  isIdentifiable, minTimeValueFor,
  IDENTIFIABILITY_MODE, MIN_IDENTIFIABLE_VEGA, MAX_SIGMA_UNCERTAINTY, DEFAULT_TICK_SIZE,
};