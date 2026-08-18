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
  // Soft, non-alarming state for "this selection has no live stream" (B-04).
  // Distinct from `error`, which means something actually failed.
  const [notice, setNotice] = useState(null);
  /**
   * True from the moment the selection changes until the server's back-fill for
   * the NEW selection lands.
   *
   * This exists so the chart never goes blank. The previous version cleared
   * `points` to [] the instant the user picked another instrument, which
   * guaranteed at least one empty frame — and on a slow round trip, a visibly
   * empty chart — before the new curve arrived. Switching between 26 stocks
   * made that the dominant impression of the page.
   *
   * Now the outgoing series stays on screen and the consumer renders a loading
   * veil over it (VegaChart's `loading` prop), so a switch reads as a
   * transition rather than as a failure. `switching` is what tells it to.
   */
  const [switching, setSwitching] = useState(false);

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
        if (msg.symbol && msg.symbol !== want.symbol) return;
        setError(msg.message || 'Live Vega is unavailable');
        setNotice(null);
        // A failed switch must not leave the PREVIOUS instrument's curve on
        // screen under the new instrument's name — that would be worse than an
        // empty chart, because it looks like real data. Drop it and let the
        // page fall back to the REST path.
        setSwitching(false);
        setPoints([]);
        setMeta(null);
        return;
      }

      /**
       * NO LIVE STREAM FOR THIS SELECTION — not an error (B-04).
       *
       * The server refuses rather than substituting another expiry. Drop the
       * socket series so `streamHealthy` goes false in the page component and
       * the REST path takes over: it filters expiry exactly and returns an
       * honest empty state when that contract has no rows.
       */
      if (msg.type === 'vega_unavailable') {
        if (msg.symbol !== want.symbol) return;
        setSwitching(false);
        setPoints([]);
        setMeta(null);
        setNotice(msg.message || 'No live series for this selection.');
        setError(null);
        return;
      }

      if (msg.type === 'vega_subscribed') {
        /**
         * EXPIRY IS PART OF THE IDENTITY OF THIS SERIES (B-04).
         *
         * This check used to compare symbol and timeframe only. Combined with
         * the server's silent `expiries[0]` fallback, that let another expiry's
         * back-fill be accepted and painted under the selected expiry's label —
         * and since `vega_point` below IS expiry-filtered, no live point ever
         * matched afterwards, so the wrong curve sat frozen on screen looking
         * like real data. All three fields must match or the payload is not
         * ours.
         */
        if (msg.symbol !== want.symbol
          || msg.expiry !== want.expiry
          || msg.timeframe !== want.timeframe) return;
        setError(null);
        setNotice(null);
        setSwitching(false);
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

        /**
         * THIS REDUCER IS THE LIVE AGGREGATOR (B-01).
         *
         * The server now emits EVERY 5s sample stamped with its bucket's start
         * time, so the same timestamp arrives repeatedly while a bucket fills.
         * Replacing in place means the value held for a bucket is always the
         * LATEST sample seen in it — and once the bucket closes, that is the
         * LAST sample, which is exactly what bucketByTimeframe() stores and
         * what a page reload returns.
         *
         * Live and history therefore converge by construction rather than by
         * two functions happening to agree. (Before this, the server sent only
         * the first sample of each bucket and this branch was unreachable.)
         */
        setPoints((prev) => {
          const last = prev[prev.length - 1];
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
      setNotice(null);
      setSwitching(false);
      return undefined;
    }

    marketSocket.connect();
    setError(null);
    setNotice(null);

    /**
     * DELIBERATELY DOES NOT CLEAR `points` OR `meta`.
     *
     * The outgoing series stays mounted until `vega_subscribed` arrives with the
     * new back-fill, at which point both are replaced in one commit. That is
     * what removes the blank frame on every instrument switch.
     *
     * Two things stop the stale curve from being mistaken for the new one:
     *   · `switching` drives a loading veil over the plot, so the user can see
     *     that what is underneath is not yet the thing they asked for
     *   · the message handler drops any `vega_point` whose symbol/expiry/
     *     timeframe does not match `wantRef`, so a tick still in flight for the
     *     previous instrument can never be appended to the new series
     *
     * The one case that DOES clear immediately is `vega_error` (see above) —
     * there, no replacement is coming, so leaving the old curve up would be a
     * lie rather than a transition.
     */
    setSwitching(true);

    marketSocket.send({ type: 'subscribe_vega', symbol, expiry: expiry || undefined, timeframe });

    return () => {
      marketSocket.send({ type: 'unsubscribe_vega' });
    };
  }, [symbol, expiry, timeframe, enabled]);

  return { points, meta, error, notice, switching };
}
