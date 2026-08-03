import { useEffect, useRef, useState, useCallback } from 'react';
import marketSocket, { CONNECTION_STATUS } from '../../services/marketSocket';
import api from '../../api/axios';

/**
 * Owns one option chain subscription on the shared market socket.
 *
 * Deliberately does NOT open its own WebSocket — marketSocket is an app-wide
 * singleton. Mounting this hook twice would otherwise give you two Kite
 * subscriptions for the same data.
 */
export function useOptionChain(symbol) {
  const [expiries, setExpiries] = useState([]);
  const [expiry, setExpiry] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(marketSocket.getStatus());

  // Tracks what we last asked the server for, so we don't resubscribe on every
  // incoming frame.
  const activeRef = useRef({ symbol: null, expiry: null });

  useEffect(() => marketSocket.onStatusChange(setStatus), []);

  // Load expiries over REST — they change once a week, so streaming them
  // would be wasteful.
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);

    api
      .get(`/options/${symbol}/expiries`)
      .then(({ data }) => {
        if (cancelled) return;
        setExpiries(data.expiries || []);
        setExpiry((current) =>
          data.expiries?.includes(current) ? current : data.expiries?.[0] ?? null
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setExpiries([]);
        setError(err.response?.data?.message || 'Could not load expiries');
      });

    return () => { cancelled = true; };
  }, [symbol]);

  // Subscribe / resubscribe whenever symbol or expiry changes.
  useEffect(() => {
    if (!expiry) return undefined;

    const active = activeRef.current;
    if (active.symbol === symbol && active.expiry === expiry) return undefined;
    activeRef.current = { symbol, expiry };

    marketSocket.connect();
    marketSocket.send({ type: 'subscribe_chain', symbol, expiry });

    return () => {
      // Only release when the component actually unmounts, not on every
      // re-render — the server unsubscribes the previous expiry itself.
    };
  }, [symbol, expiry]);

  useEffect(() => marketSocket.onMessage((message) => {
    if (message.type === 'chain') {
      // Ignore frames for a selection we have already moved away from.
      const { symbol: s, expiry: e } = activeRef.current;
      if (message.data.symbol === s && message.data.expiry === e) {
        setSnapshot(message.data);
        setError(null);
      }
    } else if (message.type === 'chain_error') {
      setError(message.message);
    } else if (message.type === 'feed_status') {
      if (message.status === 'reauth_required') {
        setError('Zerodha session expired — an administrator must reconnect.');
      } else if (message.status === 'disconnected') {
        setError('An administrator disconnected the Zerodha feed.');
      } else if (message.status === 'connected') {
        // The feed came back (admin reconnected). Clear the stale banner and
        // re-subscribe: the server dropped our token selection when the
        // ticker was torn down, so without this the chain stays frozen.
        setError(null);
        const { symbol: s, expiry: e } = activeRef.current;
        if (s && e) marketSocket.send({ type: 'subscribe_chain', symbol: s, expiry: e });
      }
    }
  }), []);

  // Release the server-side subscription on unmount so its tokens are freed.
  useEffect(() => () => {
    marketSocket.send({ type: 'unsubscribe_chain' });
    activeRef.current = { symbol: null, expiry: null };
  }, []);

  const refresh = useCallback(() => {
    if (!expiry) return;
    marketSocket.send({ type: 'subscribe_chain', symbol, expiry });
  }, [symbol, expiry]);

  return {
    expiries,
    expiry,
    setExpiry,
    snapshot,
    error,
    refresh,
    isLive: status === CONNECTION_STATUS.CONNECTED,
    isUnauthorized: status === CONNECTION_STATUS.UNAUTHORIZED,
  };
}