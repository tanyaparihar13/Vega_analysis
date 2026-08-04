import { useEffect, useRef, useState } from 'react';
import marketSocket from '../../services/marketSocket';

/**
 * Live Vega over the shared /ws/market socket.
 *
 * ONE LISTENER, ONE SUBSCRIPTION, regardless of how often the selection
 * changes. That is the whole design brief of this hook:
 *
 *   - `marketSocket.onMessage` returns its own remover, and the effect that
 *     registers it depends on NOTHING, so the listener is attached once for the
 *     life of the component and torn down once. Re-registering per selection is
 *     how you end up with N listeners and N copies of every point.
 *   - the selection effect sends `subscribe_vega` on change and
 *     `unsubscribe_vega` on unmount. The server treats a repeat of the current
 *     selection as a no-op, so a re-render that produces the same values costs
 *     nothing on the Kite side.
 *   - incoming points are matched against a ref holding the CURRENT selection,
 *     not the closed-over one, so a message still in flight when the user
 *     switches instrument is dropped instead of being appended to the wrong
 *     series.
 *
 * The hook owns only the live tail. Historical loading stays on the REST path
 * in the page component — mixing them here would give two writers for one array
 * and put the chart and the table back out of step.
 *
 * @param {object}   args
 * @param {string}   args.symbol
 * @param {string}   args.expiry
 * @param {string}   args.timeframe
 * @param {boolean}  args.enabled   false for a historical date; no socket traffic at all
 */
export default function useVegaStream({ symbol, expiry, timeframe, enabled }) {
  const [points, setPoints] = useState([]);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);

  // What we are currently subscribed to, readable from inside the message
  // handler without making the handler depend on it.
  const wantRef = useRef({ symbol: null, expiry: null, timeframe: null });
  wantRef.current = enabled ? { symbol, expiry, timeframe } : { symbol: null, expiry: null, timeframe: null };

  // ---- the single message listener ---------------------------------------
  useEffect(() => {
    const off = marketSocket.onMessage((msg) => {
      const want = wantRef.current;
      if (!want.symbol) return;

      if (msg.type === 'vega_error') {
        setError(msg.message || 'Live Vega is unavailable');
        return;
      }

      if (msg.type === 'vega_subscribed') {
        if (msg.symbol !== want.symbol || msg.timeframe !== want.timeframe) return;
        setError(null);
        setMeta({
          symbol: msg.symbol,
          label: msg.label,
          expiry: msg.expiry,
          expiries: msg.expiries || [],
          timeframe: msg.timeframe,
          resolution: msg.resolution,
          isIndex: msg.isIndex,
        });
        // The server back-fills the session so far, so the chart paints the
        // whole curve at once instead of growing a point at a time.
        setPoints(msg.points || []);
        return;
      }

      if (msg.type === 'vega_point') {
        if (msg.symbol !== want.symbol || msg.expiry !== want.expiry || msg.timeframe !== want.timeframe) return;
        const incoming = msg.point;
        if (!incoming) return;

        setPoints((prev) => {
          const last = prev[prev.length - 1];
          // Points are stamped with their BUCKET's start time, so a coarse
          // timeframe re-sends the same timestamp as the bucket fills. Replace
          // in place rather than appending, or a 15m chart would grow a
          // duplicate x value every push.
          if (last && last.time === incoming.time) {
            const next = prev.slice(0, -1);
            next.push(incoming);
            return next;
          }
          if (last && incoming.time < last.time) return prev; // out-of-order, ignore
          return [...prev, incoming];
        });
      }
    });

    return off;
  }, []);

  // ---- subscription lifecycle --------------------------------------------
  useEffect(() => {
    if (!enabled || !symbol || !timeframe) {
      setPoints([]);
      setMeta(null);
      return undefined;
    }

    marketSocket.connect();
    setError(null);
    // Clear immediately so the previous instrument's curve is never briefly
    // shown under the new instrument's name.
    setPoints([]);
    setMeta(null);

    marketSocket.send({ type: 'subscribe_vega', symbol, expiry: expiry || undefined, timeframe });

    return () => {
      marketSocket.send({ type: 'unsubscribe_vega' });
    };
  }, [symbol, expiry, timeframe, enabled]);

  return { points, meta, error };
}
