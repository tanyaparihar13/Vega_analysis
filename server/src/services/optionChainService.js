const {
  calculateGreeks, calculateGreeks76, forwardFromSpot, yearsToExpiry,
} = require('../utils/blackScholes');
const { impliedVolatility, impliedVolatility76 } = require('../utils/impliedVolatility');
const { getUnderlying } = require('../constants/instruments');
const instrumentService = require('./instrumentService');

const RISK_FREE_RATE = Number(process.env.RISK_FREE_RATE || 0.065);

/**
 * Builds one option chain snapshot from the live tick cache.
 *
 * This is pure assembly — it reads whatever the ticker has cached and derives
 * everything else. It does not call Kite. That keeps it cheap enough to run on
 * a broadcast interval.
 */
function buildChain({ symbol, expiry, latestTicks, oiBaseline = null, strikeWindow = 20 }) {
  const cfg = getUnderlying(symbol);
  if (!cfg) {
    const err = new Error(`Unknown underlying: ${symbol}`);
    err.statusCode = 404;
    throw err;
  }

  const spotTick = latestTicks.get(cfg.spotToken);
  const spot = spotTick?.lastPrice ?? null;

  const { strikes, byStrike } = instrumentService.getStrikeMap(symbol, expiry);
  const selectedStrikes = instrumentService.selectStrikes(strikes, spot, strikeWindow);

  const T = yearsToExpiry(expiry);

  /**
   * The FORWARD used to price every contract on this board (Black-76).
   *
   * Indian index options settle against the index but are priced off the
   * futures. Using spot understates the forward by the cost of carry, which
   * biases delta — and delta is exactly what selects which strikes enter the
   * Call/Put Vega sums (the [start, deltaMax] band in vegaMath). So a spot-based
   * delta quietly changes WHICH contracts the Vega totals are built from, not
   * just the decimals.
   *
   * Preference order:
   *   1. the nearest future's traded price — the market's own forward
   *   2. S * e^(rT) — the no-arbitrage forward, when no future tick is cached
   */
  const future = instrumentService.getNearestFuture(cfg.key);
  const futureTick = future ? latestTicks.get(future.instrumentToken) : null;
  const futurePrice = futureTick?.lastPrice ?? null;

  const forward = futurePrice != null
    ? futurePrice
    : (spot != null ? forwardFromSpot(spot, T, RISK_FREE_RATE) : null);

  const forwardSource = futurePrice != null ? 'future' : (spot != null ? 'carry' : null);

  // ATM = listed strike closest to spot. Falls back to the middle of the board
  // before the first spot tick arrives, so the table still renders.
  const atmStrike = spot != null
    ? selectedStrikes.reduce(
        (best, s) => (Math.abs(s - spot) < Math.abs(best - spot) ? s : best),
        selectedStrikes[0]
      )
    : selectedStrikes[Math.floor(selectedStrikes.length / 2)] ?? null;

  const chain = selectedStrikes.map((strike) => {
    const pair = byStrike[strike];
    return {
      strike,
      isAtm: strike === atmStrike,
      call: buildSide({ leg: pair.CE, type: 'CE', strike, spot, forward, T, latestTicks, oiBaseline }),
      put: buildSide({ leg: pair.PE, type: 'PE', strike, spot, forward, T, latestTicks, oiBaseline }),
    };
  });

  const atmRow = chain.find((row) => row.isAtm) || null;

  return {
    symbol: cfg.key,
    label: cfg.label,
    expiry,
    spot,
    spotChange: spotTick?.change ?? null,
    spotPercentChange: spotTick?.percentChange ?? null,
    atmStrike,
    daysToExpiry: Number((T * 365).toFixed(3)),
    lotSize: cfg.lotSize,
    riskFreeRate: RISK_FREE_RATE,
    // Black-76 inputs, surfaced so the UI/diagnostics can show what the Greeks
    // were actually priced against rather than assuming it was spot.
    pricingModel: 'black76',
    forward: forward != null ? Number(forward.toFixed(2)) : null,
    forwardSource,                                   // 'future' | 'carry' | null
    futureSymbol: future?.tradingsymbol ?? null,
    pcr: calculatePCR(chain),
    maxPain: calculateMaxPain(chain),
    atmIv: calculateAtmIv(atmRow),
    totalCallOi: sum(chain, (r) => r.call.oi),
    totalPutOi: sum(chain, (r) => r.put.oi),
    chain,
    timestamp: new Date().toISOString(),
  };
}

function buildSide({ leg, type, strike, spot, forward, T, latestTicks, oiBaseline }) {
  if (!leg) return emptySide(type);

  const tick = latestTicks.get(leg.instrumentToken);
  const base = {
    type,
    instrumentToken: leg.instrumentToken,
    tradingsymbol: leg.tradingsymbol,
    lotSize: leg.lotSize,
  };

  if (!tick) return { ...emptySide(type), ...base };

  const ltp = tick.lastPrice ?? null;

  // OI change needs yesterday's closing OI, which a tick does not carry.
  // See oiBaselineService — null until a baseline has been captured.
  const priorOi = oiBaseline?.get?.(leg.instrumentToken) ?? null;
  const oiChange = priorOi != null && tick.oi != null ? tick.oi - priorOi : null;
  const oiChangePercent =
    priorOi ? Number((((tick.oi - priorOi) / priorOi) * 100).toFixed(2)) : null;

  // Solve IV from the traded price, then price the Greeks with it — both
  // against the FORWARD (Black-76), which is how Indian index options are
  // quoted. See the `forward` derivation in buildChain().
  const iv = (ltp != null && forward != null && T > 0)
    ? impliedVolatility76({ marketPrice: ltp, F: forward, K: strike, T, r: RISK_FREE_RATE, type })
    : null;

  const greeks = (iv != null && forward != null)
    ? calculateGreeks76({ F: forward, K: strike, T, r: RISK_FREE_RATE, sigma: iv, type })
    : { delta: null, gamma: null, theta: null, vega: null, rho: null };

  const intrinsic = spot == null
    ? null
    : type === 'CE'
      ? Math.max(0, spot - strike)
      : Math.max(0, strike - spot);

  const timeValue = (ltp != null && intrinsic != null)
    ? Number(Math.max(0, ltp - intrinsic).toFixed(2))
    : null;

  return {
    ...base,
    ltp,
    ltpChange: tick.change ?? null,
    ltpPercentChange: tick.percentChange != null ? Number(tick.percentChange.toFixed(2)) : null,
    oi: tick.oi ?? null,
    oiChange,
    oiChangePercent,
    volume: tick.volume ?? null,
    bidQty: tick.bidQty ?? null,
    bidPrice: tick.bidPrice ?? null,
    askPrice: tick.askPrice ?? null,
    askQty: tick.askQty ?? null,
    averagePrice: tick.averagePrice ?? null,
    open: tick.open ?? null,
    high: tick.high ?? null,
    low: tick.low ?? null,
    previousClose: tick.previousClose ?? null,
    lowerCircuitLimit: tick.lowerCircuitLimit ?? null,
    upperCircuitLimit: tick.upperCircuitLimit ?? null,
    depth: tick.depth ?? { buy: [], sell: [] },
    iv: iv != null ? Number((iv * 100).toFixed(2)) : null, // percent, for display
    ...greeks,
    intrinsicValue: intrinsic != null ? Number(intrinsic.toFixed(2)) : null,
    timeValue,
    moneyness: classifyMoneyness({ type, strike, spot }),
  };
}

function emptySide(type) {
  return {
    type,
    instrumentToken: null, tradingsymbol: null, lotSize: null,
    ltp: null, ltpChange: null, ltpPercentChange: null,
    oi: null, oiChange: null, oiChangePercent: null, volume: null,
    bidQty: null, bidPrice: null, askPrice: null, askQty: null,
    averagePrice: null, open: null, high: null, low: null, previousClose: null,
    lowerCircuitLimit: null, upperCircuitLimit: null,
    depth: { buy: [], sell: [] },
    iv: null, delta: null, gamma: null, theta: null, vega: null, rho: null,
    intrinsicValue: null, timeValue: null, moneyness: null,
  };
}

function classifyMoneyness({ type, strike, spot }) {
  if (spot == null) return null;
  if (type === 'CE') return strike < spot ? 'ITM' : strike > spot ? 'OTM' : 'ATM';
  return strike > spot ? 'ITM' : strike < spot ? 'OTM' : 'ATM';
}

function sum(chain, pick) {
  return chain.reduce((acc, row) => acc + (pick(row) || 0), 0);
}

/** PCR = total put OI / total call OI */
function calculatePCR(chain) {
  const putOi = sum(chain, (r) => r.put.oi);
  const callOi = sum(chain, (r) => r.call.oi);
  if (!callOi) return null;
  return Number((putOi / callOi).toFixed(3));
}

/**
 * Max Pain: the settlement price at which option writers collectively lose
 * the least. Evaluated at every listed strike.
 */
function calculateMaxPain(chain) {
  let minLoss = Infinity;
  let maxPainStrike = null;

  for (const { strike: settlement } of chain) {
    let loss = 0;
    for (const row of chain) {
      // Call writers lose when settlement is above the strike they wrote
      if (settlement > row.strike) loss += (settlement - row.strike) * (row.call.oi || 0);
      // Put writers lose when settlement is below it
      if (settlement < row.strike) loss += (row.strike - settlement) * (row.put.oi || 0);
    }
    if (loss < minLoss) { minLoss = loss; maxPainStrike = settlement; }
  }

  return maxPainStrike;
}

/** ATM IV = mean of the ATM call and put IV, whichever are available. */
function calculateAtmIv(atmRow) {
  if (!atmRow) return null;
  const values = [atmRow.call.iv, atmRow.put.iv].filter((v) => v != null);
  if (!values.length) return null;
  return Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2));
}

/**
 * IV percentile: where today's ATM IV sits within its own trailing history.
 *
 * This is NOT derivable from a live tick — it needs a stored series. Returns
 * null until you have enough days banked (see schema additions). Do not
 * substitute a placeholder; a fabricated percentile is worse than a blank cell.
 */
function calculateIvPercentile(currentAtmIv, history, minSamples = 20) {
  if (currentAtmIv == null || !Array.isArray(history) || history.length < minSamples) {
    return null;
  }
  const below = history.filter((v) => v < currentAtmIv).length;
  return Number(((below / history.length) * 100).toFixed(1));
}

module.exports = {
  buildChain,
  calculatePCR,
  calculateMaxPain,
  calculateAtmIv,
  calculateIvPercentile,
};
