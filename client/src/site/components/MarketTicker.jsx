import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { HiOutlineClock } from 'react-icons/hi';
import publicApi from '../api/publicApi';

/**
 * The live market strip under the header.
 *
 * WHAT IT SHOWS, AND WHY IT IS NOT SPOT PRICES. A ticker on a trading site
 * usually reads "NIFTY 24,318.20 +0.42%". This one cannot: the public API
 * exposes exactly two things without a session — the delayed vega series and
 * the site contact config. There is no public quotes endpoint, and adding one
 * would be a backend change.
 *
 * The alternative — hard-coding index levels — would put numbers on the front
 * page of a paid market-analytics product that are wrong the moment they are
 * written and never change again. So the strip shows the real thing this
 * product actually measures: per-underlying Call Vega, Put Vega and the trend
 * read, for all five indices, from `/api/public/vega/:symbol/delayed-series`.
 * Every value is genuine recorded data, and the strip labels its own delay.
 *
 * POLLING. One request per underlying per minute, matching the server's sample
 * cadence, from a limiter that allows 120/minute per IP. `Promise.allSettled`
 * so one slow or missing symbol cannot blank the whole strip.
 */

const POLL_MS = 60_000;

/** Fallback if `/vega/symbols` is unreachable — matches the server's set. */
const FALLBACK_SYMBOLS = [
  { key: 'NIFTY', label: 'NIFTY' },
  { key: 'BANKNIFTY', label: 'BANK NIFTY' },
  { key: 'FINNIFTY', label: 'FINNIFTY' },
  { key: 'MIDCPNIFTY', label: 'MIDCAP NIFTY' },
  { key: 'SENSEX', label: 'SENSEX' },
];

const fmtSigned = (v) => {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return '–';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
};

/** Emerald for a rise, red for a fall, neutral grey for flat or missing. */
const toneFor = (v) => {
  const n = Number(v);
  if (v == null || Number.isNaN(n) || n === 0) return '#93A3B4';
  return n > 0 ? '#00E676' : '#FF4D6D';
};

export default function MarketTicker() {
  const [rows, setRows] = useState([]);
  const [delay, setDelay] = useState(30);
  // Symbols change only if the server's instrument list changes, so they are
  // fetched once and then held for the life of the page.
  const symbolsRef = useRef(null);

  const load = useCallback(async () => {
    if (!symbolsRef.current) {
      try {
        const { data } = await publicApi.get('/vega/symbols');
        symbolsRef.current = data?.symbols?.length ? data.symbols : FALLBACK_SYMBOLS;
        if (data?.delayMinutes != null) setDelay(data.delayMinutes);
      } catch {
        symbolsRef.current = FALLBACK_SYMBOLS;
      }
    }

    const results = await Promise.allSettled(
      symbolsRef.current.map((s) =>
        publicApi.get(`/vega/${s.key}/delayed-series`).then(({ data }) => ({ meta: s, data }))
      )
    );

    const next = results
      .filter((r) => r.status === 'fulfilled')
      .map(({ value }) => {
        const points = value.data?.points ?? [];
        const latest = points.length ? points[points.length - 1] : null;
        return {
          key: value.meta.key,
          label: value.meta.label || value.meta.key,
          call: latest?.callVegaDiff ?? null,
          put: latest?.putVegaDiff ?? null,
          trend: latest?.trend ?? null,
          trendColor: latest?.trendColor ?? '#93A3B4',
          stale: !!value.data?.isFallbackDay,
        };
      })
      // A symbol the recorder has never sampled contributes nothing readable,
      // so it is left out rather than shown as a row of dashes.
      .filter((r) => r.call != null || r.put != null);

    setRows(next);
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  /**
   * The track is rendered TWICE and the marquee keyframe translates it by
   * exactly -50%, so the second copy arrives where the first started and the
   * loop is seamless — no measurement, no JS, no jump.
   *
   * The duplicate is `aria-hidden` so a screen reader hears each index once.
   */
  const items = useMemo(() => rows, [rows]);

  if (!items.length) {
    // Nothing recorded yet (a holiday, or before the first sample of the day).
    // A silent, fixed-height placeholder keeps the page from reflowing when the
    // first poll lands.
    return <div className="h-[46px] border-y border-white/[0.06]" aria-hidden="true" />;
  }

  return (
    <div className="relative z-10 border-y border-white/[0.08] bg-[rgba(8,11,15,0.6)] backdrop-blur-md">
      <div className="flex items-stretch">
        {/* Delay label, pinned outside the scrolling region so it is always
            legible — the disclosure must not scroll away from the numbers. */}
        <div className="hidden shrink-0 items-center gap-1.5 border-r border-white/[0.08] px-4 text-[11px] font-semibold uppercase tracking-wider text-muted sm:flex">
          <HiOutlineClock size={13} className="text-primary" />
          {delay} min delayed
        </div>

        <div className="site-marquee flex-1">
          <div className="site-marquee-track">
            {[0, 1].map((copy) => (
              <div key={copy} className="flex items-center" aria-hidden={copy === 1}>
                {items.map((r) => (
                  <TickerItem key={`${copy}-${r.key}`} row={r} />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TickerItem({ row }) {
  return (
    <div className="flex items-center gap-2.5 whitespace-nowrap border-r border-white/[0.06] px-5 py-3">
      <span className="font-body text-xs font-bold tracking-wide text-text">
        {row.label}
      </span>

      {row.trend && (
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{
            color: row.trendColor,
            backgroundColor: `${row.trendColor}1f`,
          }}
        >
          {row.trend}
        </span>
      )}

      <span className="flex items-center gap-1 font-mono text-xs tabular-nums">
        <span className="text-muted/70">C</span>
        <span style={{ color: toneFor(row.call) }} className="font-semibold">
          {fmtSigned(row.call)}
        </span>
      </span>

      <span className="flex items-center gap-1 font-mono text-xs tabular-nums">
        <span className="text-muted/70">P</span>
        <span style={{ color: toneFor(row.put) }} className="font-semibold">
          {fmtSigned(row.put)}
        </span>
      </span>

      {/* Showing the previous session's close under a "live" strip without
          saying so would be the one dishonest thing this component could do. */}
      {row.stale && (
        <span className="text-[10px] font-medium uppercase tracking-wide text-muted/60">
          last session
        </span>
      )}
    </div>
  );
}
