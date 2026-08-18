const { TOKEN_TO_SYMBOL } = require('../constants/instruments');

/**
 * Flattens a raw KiteTicker tick for the frontend.
 *
 * The previous version kept 11 fields and discarded everything the option
 * chain needs: market depth, bid/ask, circuit limits, average traded price
 * and total buy/sell quantity. All of it is preserved here.
 *
 * Requires `modeFull` on the subscription — in `modeLTP` or `modeQuote` most
 * of these fields are simply absent and will come through as null.
 */
function normalizeTick(tick) {
  const ohlc = tick.ohlc || {};
  const depth = tick.depth || {};

  const bids = Array.isArray(depth.buy) ? depth.buy : [];
  const asks = Array.isArray(depth.sell) ? depth.sell : [];

  // Only compute change when we actually have a previous close. The old code
  // fell back to last_price, which fabricated an exact 0.00% on the first tick.
  const previousClose = typeof ohlc.close === 'number' ? ohlc.close : null;
  const change = previousClose != null ? tick.last_price - previousClose : null;
  const percentChange =
    previousClose ? (change / previousClose) * 100 : null;

  return {
    instrumentToken: tick.instrument_token,
    symbol:
      TOKEN_TO_SYMBOL[tick.instrument_token] ||
      tick.tradingsymbol ||
      String(tick.instrument_token),
    tradable: tick.tradable ?? null,

    lastPrice: tick.last_price ?? null,
    lastQuantity: tick.last_traded_quantity ?? null,
    averagePrice: tick.average_traded_price ?? null,
    change,
    percentChange,

    open: ohlc.open ?? null,
    high: ohlc.high ?? null,
    low: ohlc.low ?? null,
    previousClose,

    volume: tick.volume_traded ?? tick.volume ?? null,
    oi: tick.oi ?? null,
    oiDayHigh: tick.oi_day_high ?? null,
    oiDayLow: tick.oi_day_low ?? null,

    totalBuyQuantity: tick.total_buy_quantity ?? null,
    totalSellQuantity: tick.total_sell_quantity ?? null,

    // Best bid / ask, lifted out of depth for convenience
    bidPrice: bids[0]?.price ?? null,
    bidQty: bids[0]?.quantity ?? null,
    bidOrders: bids[0]?.orders ?? null,
    askPrice: asks[0]?.price ?? null,
    askQty: asks[0]?.quantity ?? null,
    askOrders: asks[0]?.orders ?? null,

    // Full 5-level book, for the Market Depth panel
    depth: {
      buy: bids.map((l) => ({ price: l.price, quantity: l.quantity, orders: l.orders })),
      sell: asks.map((l) => ({ price: l.price, quantity: l.quantity, orders: l.orders })),
    },

    lowerCircuitLimit: tick.lower_circuit_limit ?? null,
    upperCircuitLimit: tick.upper_circuit_limit ?? null,

    /**
     * ONE TYPE (B-14).
     *
     * kiteconnect parses `exchange_timestamp` and `last_trade_time` into JS
     * Date objects, but the fallback branch produced an ISO string — so this
     * field was `Date | string` depending on which branch ran, and every
     * consumer had to guess. Normalised to epoch MILLISECONDS: unambiguous,
     * timezone-free, JSON-safe, and directly comparable against the UNIX
     * seconds used by the vega series (x1000).
     *
     * `timestampSource` says which clock it came from, because an exchange
     * timestamp and the server's own clock are not interchangeable when you are
     * diagnosing a stale feed.
     */
    timestamp: toEpochMs(tick.exchange_timestamp)
      ?? toEpochMs(tick.last_trade_time)
      ?? Date.now(),
    timestampSource: tick.exchange_timestamp ? 'exchange'
      : tick.last_trade_time ? 'lastTrade'
      : 'server',
  };
}

/** Any of Date | number | ISO string -> epoch ms, or null when unusable. */
function toEpochMs(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    // Kite's binary feed carries seconds; anything below ~1e11 is seconds.
    return Number.isFinite(value) ? (value < 1e11 ? value * 1000 : value) : null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

module.exports = { normalizeTick };
