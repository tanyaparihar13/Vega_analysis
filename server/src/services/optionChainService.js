const {
  calculateGreeks, calculateGreeks76, forwardFromSpot, yearsToExpiry,
  discountForwardToExpiry,
} = require('../utils/blackScholes');
const { impliedVolatility, impliedVolatility76 } = require('../utils/impliedVolatility');
const { getUnderlying } = require('../constants/instruments');
const instrumentService = require('./instrumentService');
const vegaCfg = require('../config/vegaConfig');

const RISK_FREE_RATE = Number(process.env.RISK_FREE_RATE || 0.065);

/**
 * Which forward the Black-76 pricer is given (B-02).
 *
 *   'nearest'  the front-month future's traded price, whatever the option's
 *              expiry. This is the behaviour that shipped, and it is the
 *              DEFAULT so no stored financial result changes without an
 *              explicit operator decision.
 *   'matched'  the future that settles with the option where one is listed,
 *              otherwise the nearest one discounted back to the option's own
 *              maturity. Mathematically correct; see the header on
 *              instrumentService.getFutureForExpiry().
 *
 * Set VEGA_FORWARD_MODE=matched to activate. Stocks are unaffected either way,
 * because stock options and stock futures share monthly expiries and therefore
 * always take the `exact` branch.
 */
const FORWARD_MODE =
  String(process.env.VEGA_FORWARD_MODE || 'nearest').toLowerCase() === 'matched'
    ? 'matched'
    : 'nearest';

/**
 * Resolve the forward for one {underlying, expiry}.
 * @returns {{forward: number|null, source: string|null, futureSymbol: string|null}}
 */
function resolveForward({ cfg, expiry, T, spot, latestTicks }) {
  const carry = () => (spot != null
    ? { forward: forwardFromSpot(spot, T, RISK_FREE_RATE), source: 'carry', futureSymbol: null }
    : { forward: null, source: null, futureSymbol: null });

  if (FORWARD_MODE === 'nearest') {
    const future = instrumentService.getNearestFuture(cfg.key);
    const price = future ? latestTicks.get(future.instrumentToken)?.lastPrice ?? null : null;
    if (price != null) return { forward: price, source: 'future', futureSymbol: future.tradingsymbol };
    return carry();
  }

  // --- matched ---
  const pick = instrumentService.getFutureForExpiry(cfg.key, expiry);
  const price = pick ? latestTicks.get(pick.row.instrumentToken)?.lastPrice ?? null : null;
  if (price == null) return carry();

  if (pick.exact) {
    return { forward: price, source: 'future', futureSymbol: pick.row.tradingsymbol };
  }

  const tFuture = yearsToExpiry(pick.futureExpiry);
  const discounted = discountForwardToExpiry(price, tFuture, T, RISK_FREE_RATE);
  if (discounted == null) return carry(); // future settles before the option
  return { forward: discounted, source: 'future-discounted', futureSymbol: pick.row.tradingsymbol };
}

/**
 * Builds one option chain snapshot from the live tick cache.
 *
 * This is pure assembly — it reads whatever the ticker has cached and derives
 * everything else. It does not call Kite. That keeps it cheap enough to run on
 * a broadcast interval.
 */
function buildChain({ symbol, expiry, latestTicks, oiBaseline = null, strikeWindow = 20 }) {
  /**
   * RESOLVED THROUGH instrumentService, NOT constants.getUnderlying.
   *
   * constants/instruments.js is the curated table of five indices. The
   * instrument master additionally carries every equity F&O name discovered in
   * the option dump (RELIANCE, APLAPOLLO, ADANIPORTS...), each with an inferred
   * strike step and a spot token matched from the cash segment.
   *
   * Resolving against only the curated five made this function throw 404 for
   * every stock, which is why nothing downstream — chain, Greeks, Vega — could
   * serve one. resolveUnderlying checks the curated table FIRST and falls back
   * to the derived names, so index behaviour is bit-for-bit what it was and
   * stocks simply start working. Nothing is removed.
   */
  const cfg = instrumentService.resolveUnderlying(symbol) || getUnderlying(symbol);
  if (!cfg) {
    const err = new Error(`Unknown underlying: ${symbol}`);
    err.statusCode = 404;
    throw err;
  }

  // A derived underlying whose cash listing never matched has no spot token.
  const spotTick = cfg.spotToken != null ? latestTicks.get(cfg.spotToken) : null;
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
  const { forward, source: forwardSource, futureSymbol } =
    resolveForward({ cfg, expiry, T, spot, latestTicks });

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
    // 'future' | 'future-discounted' | 'carry' | null
    forwardSource,
    forwardMode: FORWARD_MODE,
    futureSymbol,
    /**
     * The |delta| band the Vega sums are built over, for THIS underlying (B-06).
     *
     * Emitted so the option-chain table can filter on the server's rule instead
     * of re-implementing it. The client copy had drifted: its stock floor was
     * 0.05 against the server's 0.20, and its ceiling was hardcoded 0.60 while
     * the server's is env-tunable — so the table showed a different basket from
     * the one the Vega chart was summing.
     */
    deltaBand: { start: vegaCfg.deltaStartFor(cfg.key), max: vegaCfg.DELTA_MAX },
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
    tickSize: leg.tickSize ?? null,
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
  // tickSize is threaded so the identifiability rule can be expressed relative
  // to how finely THIS contract is quoted (B-03). It is ignored in the default
  // 'absolute' mode, so passing it changes nothing until that mode is switched.
  const iv = (ltp != null && forward != null && T > 0)
    ? impliedVolatility76({
        marketPrice: ltp, F: forward, K: strike, T, r: RISK_FREE_RATE, type,
        tickSize: leg.tickSize,
      })
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
    instrumentToken: null, tradingsymbol: null, lotSize: null, tickSize: null,
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
