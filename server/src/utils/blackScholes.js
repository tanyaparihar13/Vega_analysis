/**
 * Black-Scholes pricing & Greeks.
 *
 * S = spot, K = strike, T = years to expiry, r = risk-free rate,
 * sigma = volatility as a decimal (0.15 == 15%).
 */

// Abramowitz & Stegun 7.1.26. Max abs error ~1.5e-7 — fine for display, and
// adequate as the inner loop of the IV solver since we converge on price to
// 0.01, well above the noise floor.
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function normCDF(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

function normPDF(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function d1d2(S, K, T, r, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  return { d1, d2: d1 - sigma * sqrtT, sqrtT };
}

function isCallType(type) {
  return type === 'CE' || type === 'CALL';
}

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * Years to expiry, accounting for the fact that Indian index options expire
 * at 15:30 IST (== 10:00 UTC), not at midnight.
 *
 * Treating expiry as a whole day makes theta and gamma badly wrong on expiry
 * day itself — which is exactly when traders care most about them.
 */
function yearsToExpiry(expiryDate, now = new Date()) {
  const expiry = new Date(`${String(expiryDate).slice(0, 10)}T00:00:00Z`);
  expiry.setUTCHours(10, 0, 0, 0); // 15:30 IST
  return Math.max(expiry.getTime() - now.getTime(), 0) / MS_PER_YEAR;
}

/**
 * Returns { price, delta, gamma, theta, vega, rho }.
 * theta is per calendar day; vega and rho are per 1% move.
 */
function calculateGreeks({ S, K, T, r = 0.065, sigma, type = 'CE' }) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const { d1, d2, sqrtT } = d1d2(S, K, T, r, sigma);
  const call = isCallType(type);
  const discount = Math.exp(-r * T);
  const pdfD1 = normPDF(d1);

  const price = call
    ? S * normCDF(d1) - K * discount * normCDF(d2)
    : K * discount * normCDF(-d2) - S * normCDF(-d1);

  const delta = call ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = pdfD1 / (S * sigma * sqrtT);
  const vega = (S * pdfD1 * sqrtT) / 100;

  const theta = call
    ? (-(S * pdfD1 * sigma) / (2 * sqrtT) - r * K * discount * normCDF(d2)) / 365
    : (-(S * pdfD1 * sigma) / (2 * sqrtT) + r * K * discount * normCDF(-d2)) / 365;

  const rho = call
    ? (K * T * discount * normCDF(d2)) / 100
    : (-K * T * discount * normCDF(-d2)) / 100;

  return {
    price: round(price, 2),
    delta: round(delta, 4),
    gamma: round(gamma, 6),
    theta: round(theta, 2),
    vega: round(vega, 4),
    rho: round(rho, 4),
  };
}

/** Unrounded price only — the IV solver needs full precision to converge. */
function theoreticalPrice({ S, K, T, r, sigma, type }) {
  if (!(S > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return 0;
  const { d1, d2 } = d1d2(S, K, T, r, sigma);
  const discount = Math.exp(-r * T);
  return isCallType(type)
    ? S * normCDF(d1) - K * discount * normCDF(d2)
    : K * discount * normCDF(-d2) - S * normCDF(-d1);
}

/** Raw vega, per 1.0 change in sigma (not per 1%). Used by the solver. */
function rawVega({ S, K, T, r, sigma }) {
  if (!(T > 0) || !(sigma > 0)) return 0;
  const { d1, sqrtT } = d1d2(S, K, T, r, sigma);
  return S * normPDF(d1) * sqrtT;
}

// ===========================================================================
// BLACK-76 — options on a FORWARD / FUTURES price
// ===========================================================================
/**
 * Indian index options are priced off the FUTURES, not the spot index.
 *
 * Pricing an option on NIFTY spot with plain Black-Scholes ignores that the
 * forward trades above spot by the cost of carry. Over a monthly expiry at a
 * 6.5% rate that is roughly half a percent of the underlying — small in price
 * terms, but it shifts DELTA, and delta is what decides which strikes enter
 * the Vega sums (the [start, deltaMax] band in vegaMath). A biased delta
 * therefore silently changes which contracts the Call/Put Vega totals are
 * built from.
 *
 * Black-76 removes the assumption entirely by taking the market's own forward
 * (the nearest future's traded price) as the input:
 *
 *     d1 = (ln(F/K) + (sigma^2 / 2) T) / (sigma sqrt(T))
 *     d2 = d1 - sigma sqrt(T)
 *     Call = e^(-rT) [F N(d1) - K N(d2)]
 *     Put  = e^(-rT) [K N(-d2) - F N(-d1)]
 *
 * Same output contract as calculateGreeks(): theta per calendar day, vega and
 * rho per 1% move, so callers and the stored series stay comparable.
 */
function d1d2_76(F, K, T, sigma) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + ((sigma * sigma) / 2) * T) / (sigma * sqrtT);
  return { d1, d2: d1 - sigma * sqrtT, sqrtT };
}

/** Unrounded Black-76 price. Full precision — the IV solver needs it. */
function theoreticalPrice76({ F, K, T, r = 0.065, sigma, type = 'CE' }) {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return 0;
  const { d1, d2 } = d1d2_76(F, K, T, sigma);
  const discount = Math.exp(-r * T);
  return isCallType(type)
    ? discount * (F * normCDF(d1) - K * normCDF(d2))
    : discount * (K * normCDF(-d2) - F * normCDF(-d1));
}

/** Raw Black-76 vega, per 1.0 change in sigma (not per 1%). Used by the solver. */
function rawVega76({ F, K, T, r = 0.065, sigma }) {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) return 0;
  const { d1, sqrtT } = d1d2_76(F, K, T, sigma);
  return F * Math.exp(-r * T) * normPDF(d1) * sqrtT;
}

/** Returns { price, delta, gamma, theta, vega, rho } under Black-76. */
function calculateGreeks76({ F, K, T, r = 0.065, sigma, type = 'CE' }) {
  if (!(F > 0) || !(K > 0) || !(T > 0) || !(sigma > 0)) {
    return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const { d1, d2, sqrtT } = d1d2_76(F, K, T, sigma);
  const call = isCallType(type);
  const discount = Math.exp(-r * T);
  const pdfD1 = normPDF(d1);

  const price = call
    ? discount * (F * normCDF(d1) - K * normCDF(d2))
    : discount * (K * normCDF(-d2) - F * normCDF(-d1));

  // Delta here is w.r.t. the FORWARD, which is the correct sensitivity to hedge
  // with a futures contract — the instrument a trader on this desk actually uses.
  const delta = call ? discount * normCDF(d1) : -discount * normCDF(-d1);
  const gamma = (discount * pdfD1) / (F * sigma * sqrtT);
  const vega = (F * discount * pdfD1 * sqrtT) / 100;

  // theta = -(F e^-rT phi(d1) sigma) / (2 sqrt(T))  +  r * price
  const theta = ((-(F * discount * pdfD1 * sigma) / (2 * sqrtT)) + r * price) / 365;

  const rho = (-T * price) / 100;

  return {
    price: round(price, 2),
    delta: round(delta, 4),
    gamma: round(gamma, 6),
    theta: round(theta, 2),
    vega: round(vega, 4),
    rho: round(rho, 4),
  };
}

/**
 * The forward to use when no futures tick is available.
 * F = S * e^(rT) is the no-arbitrage forward for a non-dividend-paying index.
 */
function forwardFromSpot(S, T, r = 0.065) {
  if (!(S > 0) || !(T > 0)) return S;
  return S * Math.exp(r * T);
}

function round(value, dp) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

module.exports = {
  calculateGreeks,
  theoreticalPrice,
  rawVega,
  yearsToExpiry,
  normCDF,
  normPDF,
  isCallType,
  // Black-76
  calculateGreeks76,
  theoreticalPrice76,
  rawVega76,
  forwardFromSpot,
};
