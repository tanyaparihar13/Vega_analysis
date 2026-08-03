import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { HiOutlineClock, HiOutlineLockClosed } from 'react-icons/hi';
import publicApi from '../api/publicApi';
import PublicVegaChart from './PublicVegaChart';
import { SERIES_COLORS } from '../../features/vegaAnalysis/VegaChart';

/**
 * The delayed NIFTY Vega chart shown to visitors who have not registered.
 *
 * Everything here is real recorded data from the Vega recorder — the same
 * per-minute rows the terminal serves — held back by the delay the server
 * applies. There is no sample data, no synthetic curve and no placeholder
 * series: when the recorder has nothing to show, this panel says so.
 *
 * TELLING THE TRUTH ABOUT WHAT IS ON SCREEN is the whole job of this
 * component's header. Three distinct states have to be distinguishable:
 *
 *   today, delayed        "Today · delayed by 30 minutes"
 *   previous session      "Last session · <date>"   (isFallbackDay)
 *   nothing recorded yet  empty state explaining the recorder has not run
 *
 * Showing last Friday's curve under a "Live" badge would be worse than showing
 * an empty box, so the fallback case is labelled explicitly rather than
 * quietly rendered.
 */

const SYMBOL = 'NIFTY';
const POLL_MS = 60_000; // matches the server's per-minute sample cadence

const SERIES_LEGEND = [
  { key: 'call', label: 'Call Vega', color: SERIES_COLORS.call, dashed: false },
  { key: 'put', label: 'Put Vega', color: SERIES_COLORS.put, dashed: false },
  { key: 'diff', label: 'Difference', color: SERIES_COLORS.diff, dashed: true },
];

const fmtSigned = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
};

const fmtTime = (unix) =>
  unix == null
    ? '–'
    : new Date(unix * 1000).toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
      });

const fmtDateLong = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
};

export default function DelayedVegaPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const { data: payload } = await publicApi.get(`/vega/${SYMBOL}/delayed-series`);
      setData(payload);
      setFailed(false);
    } catch {
      // A public page must not show an error dialog to a passer-by. Keep the
      // last good series on screen if there is one and fall back to a quiet
      // empty state if there is not.
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const points = useMemo(() => data?.points ?? [], [data]);
  const latest = points.length ? points[points.length - 1] : null;
  const isFallback = !!data?.isFallbackDay;
  const delay = data?.delayMinutes ?? 30;

  const emptyLabel = failed
    ? 'The delayed chart is temporarily unavailable. Please try again shortly.'
    : `No Vega data has been recorded for ${SYMBOL} yet. The recorder samples every minute between 09:15 and 15:30 IST on trading days.`;

  return (
    <div className="site-card overflow-hidden">
      {/* ---------- header ---------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <h3 className="font-display text-base font-bold text-text">
            {SYMBOL} Vega Analysis
          </h3>
          <p className="mt-0.5 text-xs text-text/50">
            Call &amp; Put vega vs the day-open baseline
          </p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isFallback ? (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-text/60">
              <HiOutlineClock size={13} />
              Last session · {fmtDateLong(data?.date)}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] font-semibold text-accent">
              <HiOutlineClock size={13} />
              Delayed {delay} min
            </span>
          )}

          {latest?.trend && (
            <span
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide"
              style={{
                color: latest.trendColor,
                backgroundColor: `${latest.trendColor}17`,
                border: `1px solid ${latest.trendColor}59`,
              }}
            >
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: latest.trendColor }} />
              {latest.trend}
            </span>
          )}
        </div>
      </div>

      {/* ---------- headline numbers ---------- */}
      <div className="grid grid-cols-3 divide-x divide-border border-b border-border">
        <Stat label="Call Vega" value={latest?.callVegaDiff} color={SERIES_COLORS.call} />
        <Stat label="Put Vega" value={latest?.putVegaDiff} color={SERIES_COLORS.put} />
        <Stat label="Difference" value={latest?.vegaDiff} color={SERIES_COLORS.diff} />
      </div>

      {/* ---------- legend ---------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-4">
        {SERIES_LEGEND.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span
              className="h-0.5 w-4 shrink-0 rounded-full"
              style={
                s.dashed
                  ? { backgroundImage: `repeating-linear-gradient(to right, ${s.color} 0 4px, transparent 4px 7px)` }
                  : { background: s.color }
              }
            />
            <span className="text-xs font-semibold" style={{ color: s.color }}>{s.label}</span>
          </span>
        ))}
        {latest && (
          <span className="ml-auto text-[11px] font-medium text-text/40">
            as of {fmtTime(latest.time)} IST
          </span>
        )}
      </div>

      {/* ---------- chart ---------- */}
      <div className="px-2 pb-2 pt-3 sm:px-3 sm:pb-3">
        <PublicVegaChart points={points} loading={loading} emptyLabel={emptyLabel} />
      </div>

      {/* ---------- premium gate ---------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-border bg-slate-50 px-5 py-4">
        <p className="flex items-start gap-2 text-xs leading-relaxed text-text/60">
          <HiOutlineLockClosed size={15} className="mt-px shrink-0 text-primary" />
          <span>
            This chart is <span className="font-semibold text-text/80">delayed by {delay} minutes</span>.
            The live chart, historical sessions, option chain and full Greeks need an approved account.
          </span>
        </p>
        <Link to="/register" className="site-btn-primary ml-auto !px-5 !py-2.5 text-sm">
          Get Access
        </Link>
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  const n = Number(value);
  const hasValue = value != null && !Number.isNaN(n);

  return (
    <div className="px-4 py-3.5 sm:px-5">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text/45">
        {label}
      </div>
      <div
        className="mt-1 font-mono text-lg font-bold tabular-nums sm:text-xl"
        style={{ color: hasValue ? color : undefined }}
      >
        {hasValue ? fmtSigned(value) : <span className="text-text/30">–</span>}
      </div>
    </div>
  );
}
