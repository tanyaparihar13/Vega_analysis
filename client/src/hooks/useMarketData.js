import { useEffect } from 'react';
import { useMarketStore, initMarketFeed } from '../store/marketStore';

/**
 * Returns the latest tick for a single symbol (e.g. "NIFTY 50").
 * Component only re-renders when THIS symbol's data changes, thanks to
 * zustand's selector subscription — not on every tick for every instrument.
 */
export function useMarketData(symbol) {
  useEffect(() => { initMarketFeed(); }, []);
  return useMarketStore((state) => state.ticksBySymbol[symbol]);
}

/**
 * Returns the full map of symbol -> latest tick (for tables / grids that
 * need everything at once).
 */
export function useAllMarketData() {
  useEffect(() => { initMarketFeed(); }, []);
  return useMarketStore((state) => state.ticksBySymbol);
}
