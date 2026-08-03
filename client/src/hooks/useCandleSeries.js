import { useEffect, useRef, useState } from 'react';
import { useMarketData } from './useMarketData';

const MAX_POINTS = 500;

/**
 * Builds a rolling OHLC candle series (and a parallel LTP line series) from
 * live ticks for one symbol. Candles bucket by `intervalSeconds` — the feed
 * only carries LTP + daily OHLC, so intraday candles are built client-side
 * from observed prices (a real backtick/historical-bar endpoint is a
 * natural future addition once Kite's historical API is wired in).
 */
export function useCandleSeries(symbol, intervalSeconds = 60) {
  const tick = useMarketData(symbol);
  const [candles, setCandles] = useState([]);
  const [lineSeries, setLineSeries] = useState([]);
  const lastBucketRef = useRef(null);

  useEffect(() => {
    if (!tick || tick.lastPrice == null) return;

    const timestampSec = Math.floor(new Date(tick.timestamp).getTime() / 1000) || Math.floor(Date.now() / 1000);
    const bucket = Math.floor(timestampSec / intervalSeconds) * intervalSeconds;
    const price = tick.lastPrice;

    setCandles((prev) => {
      if (prev.length && prev[prev.length - 1].time === bucket) {
        const updated = [...prev];
        const last = { ...updated[updated.length - 1] };
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        updated[updated.length - 1] = last;
        return updated;
      }
      const nextCandle = { time: bucket, open: price, high: price, low: price, close: price };
      const next = [...prev, nextCandle];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });

    setLineSeries((prev) => {
      const next = [...prev, { time: timestampSec, value: price }];
      return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
    });

    lastBucketRef.current = bucket;
  }, [tick, intervalSeconds]);

  return { candles, lineSeries, latestTick: tick };
}
