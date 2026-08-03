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

function impliedVolatility({ marketPrice, S, K, T, r = 0.065, type = 'CE' }) {
  if (!(marketPrice > 0) || !(S > 0) || !(K > 0) || !(T > 0)) return null;

  // Below intrinsic there is no volatility that reproduces this price — the
  // quote is stale or crossed. Happens constantly on illiquid far strikes.
  const intrinsic = intrinsicValue({ S, K, T, r, type });
  if (marketPrice - intrinsic < MIN_TIME_VALUE) return null;

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
      return finalise(sigma, { S, K, T, r });
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
    if (Math.abs(price - marketPrice) < tol) return finalise(mid, { S, K, T, r });
    if (price > marketPrice) hi = mid;
    else lo = mid;
  }

  return finalise((lo + hi) / 2, { S, K, T, r });
}

/**
 * Accepts a solved sigma only if it is inside the valid band AND vega at that
 * point is large enough for the answer to mean anything.
 */
function finalise(sigma, { S, K, T, r }) {
  if (!Number.isFinite(sigma) || sigma <= MIN_SIGMA || sigma >= MAX_SIGMA) return null;
  if (rawVega({ S, K, T, r, sigma }) < MIN_IDENTIFIABLE_VEGA) return null;
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
function impliedVolatility76({ marketPrice, F, K, T, r = 0.065, type = 'CE' }) {
  if (!(marketPrice > 0) || !(F > 0) || !(K > 0) || !(T > 0)) return null;

  const discount = Math.exp(-r * T);

  // Under Black-76 the intrinsic floor is discounted too.
  const intrinsic = isCallType(type)
    ? Math.max(0, discount * (F - K))
    : Math.max(0, discount * (K - F));
  if (marketPrice - intrinsic < MIN_TIME_VALUE) return null;

  // Price ceiling: a call cannot exceed the discounted forward, a put cannot
  // exceed the discounted strike.
  const upperBound = isCallType(type) ? discount * F : discount * K;
  if (marketPrice >= upperBound) return null;

  const tol = priceTolerance(marketPrice);

  const finalise76 = (sigma) => {
    if (!Number.isFinite(sigma) || sigma <= MIN_SIGMA || sigma >= MAX_SIGMA) return null;
    if (rawVega76({ F, K, T, r, sigma }) < MIN_IDENTIFIABLE_VEGA) return null;
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

module.exports = { impliedVolatility, impliedVolatility76, intrinsicValue };