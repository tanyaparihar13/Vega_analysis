import { useEffect, useState } from 'react';
import { getMarketStatus } from '../utils/marketStatus';

const CHECK_INTERVAL_MS = 30000;

export function useMarketStatus() {
  const [status, setStatus] = useState(getMarketStatus);

  useEffect(() => {
    const interval = setInterval(() => setStatus(getMarketStatus()), CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  return status;
}
