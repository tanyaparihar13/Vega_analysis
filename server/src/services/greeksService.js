const { calculateGreeks } = require('../utils/blackScholes');

/**
 * greeksService — a thin, explicitly-invoked wrapper around the
 * Black-Scholes math in utils/blackScholes.js.
 *
 * IMPORTANT: this is called on-demand only (a controller hit from a button
 * click / manual API call). It is NOT subscribed to KiteTicker and does NOT
 * run automatically on every tick — recomputing Greeks for every strike on
 * every tick would be wasted work for data nobody is looking at. The Option
 * Chain page should call POST /api/greeks/calculate(-batch) explicitly
 * (e.g. on page load / manual refresh / expiry change), not on a timer.
 */

const DEFAULT_RISK_FREE_RATE = 0.065;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Converts an expiry date (or explicit day count) into years-to-expiry,
 * the T that Black-Scholes expects.
 */
function resolveTimeToExpiryYears({ expiryDate, daysToExpiry }) {
  if (daysToExpiry != null) {
    return Math.max(daysToExpiry, 0) / 365;
  }
  if (expiryDate) {
    const diffMs = new Date(expiryDate).getTime() - Date.now();
    const diffDays = diffMs / MS_PER_DAY;
    return Math.max(diffDays, 0) / 365;
  }
  throw new Error('Either expiryDate or daysToExpiry is required');
}

function validateInput({ spot, strike, iv, optionType }) {
  if (typeof spot !== 'number' || spot <= 0) throw new Error('spot must be a positive number');
  if (typeof strike !== 'number' || strike <= 0) throw new Error('strike must be a positive number');
  if (typeof iv !== 'number' || iv <= 0) throw new Error('iv must be a positive number (decimal, e.g. 0.15 for 15%)');
  if (!['CE', 'PE', 'CALL', 'PUT'].includes(optionType)) {
    throw new Error('optionType must be one of CE, PE, CALL, PUT');
  }
}

/**
 * Manually-triggered single-contract Greeks calculation.
 * input: { spot, strike, iv, optionType, expiryDate? , daysToExpiry?, riskFreeRate? }
 */
function calculateForContract(input) {
  validateInput(input);
  const T = resolveTimeToExpiryYears(input);
  const riskFreeRate = input.riskFreeRate ?? DEFAULT_RISK_FREE_RATE;

  const result = calculateGreeks({
    S: input.spot,
    K: input.strike,
    T,
    r: riskFreeRate,
    sigma: input.iv,
    type: input.optionType,
  });

  return {
    ...result,
    inputs: {
      spot: input.spot,
      strike: input.strike,
      iv: input.iv,
      optionType: input.optionType,
      riskFreeRate,
      daysToExpiry: Number((T * 365).toFixed(2)),
    },
  };
}

/**
 * Manually-triggered batch calculation — one call computes Greeks for a
 * whole list of contracts (e.g. every strike in a chosen expiry) in a
 * single explicit request, rather than one call per strike.
 * contracts: [{ strike, iv, optionType }]
 * shared: { spot, expiryDate | daysToExpiry, riskFreeRate? }
 */
function calculateForChain({ contracts, ...shared }) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    throw new Error('contracts must be a non-empty array');
  }
  return contracts.map((contract) => calculateForContract({ ...shared, ...contract }));
}

module.exports = { calculateForContract, calculateForChain };
