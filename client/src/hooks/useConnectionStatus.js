import { useEffect } from 'react';
import { useMarketStore, initMarketFeed } from '../store/marketStore';

export function useConnectionStatus() {
  useEffect(() => { initMarketFeed(); }, []);
  return useMarketStore((state) => state.connectionStatus);
}
