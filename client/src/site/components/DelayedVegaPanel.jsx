import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiOutlineClock, HiOutlineLockClosed, HiOutlineInformationCircle, HiOutlineArrowRight,
} from 'react-icons/hi';
import publicApi from '../api/publicApi';
import PublicVegaChart, { PUBLIC_SERIES_COLORS } from './PublicVegaChart';
import { useAuth } from '../../context/AuthContext';

/**
 * The delayed NIFTY Vega panel — the centrepiece of the home page.
 *
 * ===========================================================================
 * LAYOUT: A TRADING TERMINAL, ABOVE THE FOLD
 * ===========================================================================
 * Modelled on the Alpha Edge reference: a dense, compact grid where the chart
 * and the time-wise records table are read TOGETHER, not one after the other.
 *
 *   row 1   four compact metric tiles — Call / Put / Difference / Trend
 *   row 2   the "Unlock Live Vega Analysis" card, centred and compact
 *   row 3   the chart (left, dominant) beside the records table (right)
 *
 * The whole panel is engineered to fit one desktop screen without scrolling.
 * That is a HEIGHT BUDGET, not a style preference, and it is why almost every
 * element here is smaller than a marketing page would normally make it: the
 * navbar, panel header, metric row, unlock card, legend and disclosure footer
 * together consume a fixed amount, and whatever the viewport has left over is
 * given to the chart and the table (see `useTerminal`).
 *
 * ===========================================================================
 * EVERYTHING HERE IS REAL RECORDED DATA
 * ===========================================================================
 * The same per-sample rows the terminal serves, held back by the delay the
 * server applies. No sample data, no synthetic curve, no placeholder series.
 * Three states must be distinguishable at a glance:
 *
 *   today, delayed        "30 Min Delayed Market Data"
 *   previous session      "Last session · <date>"   (isFallbackDay)
 *   nothing recorded yet  an empty state explaining the recorder has not run
 *
 * Showing last Friday's curve under a "Live" badge would be worse than showing
 * an empty box, so the fallback case is labelled explicitly.
 */

const SYMBOL = 'NIFTY';
const POLL_MS = 60_000; // matches the server's sample cadence

const SERIES_LEGEND = [
  { key: 'call', label: 'Call Vega', color: PUBLIC_SERIES_COLORS.call, dashed: false },
  { key: 'put', label: 'Put Vega', color: PUBLIC_SERIES_COLORS.put, dashed: false },
  { key: 'diff', label: 'Difference', color: PUBLIC_SERIES_COLORS.diff, dashed: true },
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

/**
 * The shared height of the chart and the records table, plus a `compact` flag.
 *
 * Derived from the VIEWPORT, not the container, because the constraint being
 * solved is "does the whole terminal fit on one screen" — a container-derived
 * height knows nothing about the navbar and the metric row above it.
 *
 * TWO CHROME BUDGETS, because a 1366x768 laptop cannot afford the same
 * furniture a 1080p desktop can. Both are MEASURED on the built page:
 *
 *   tall  (>=800px inner)  navbar+padding 89 · header 61 · metrics 75 ·
 *                          unlock 113 · legend+padding 46 · footer 55
 *   short (<800px inner)   the same bands in `compact` form —
 *                          89 + 44 + 62 + 64 + 46 + 40 = 345
 *
 * `compact` is what makes the short budget real: it drops the header subtitle,
 * the unlock card's description and secondary badge, and shortens the footer.
 * Without it a 1366x768 screen overflows by ~83px — measured — and the records
 * table falls off the fold, which is the one thing this layout exists to
 * prevent.
 *
 *   1920x1080 -> ~970 usable -> 970-382 = 588 -> capped at 480
 *   1366x768  -> ~658 usable -> 658-345 = 313
 */
const CHROME_TALL = 382;
const CHROME_SHORT = 345;
const COMPACT_BELOW = 800;
const MIN_TERMINAL = 280;
const MAX_TERMINAL = 480;

function useTerminal() {
  const measure = () => {
    if (typeof window === 'undefined') return { height: 440, compact: false };
    const vh = window.innerHeight;
    const compact = vh < COMPACT_BELOW;
    // Below `lg` the chart and table stack, so the fold budget no longer
    // applies — give the chart a comfortable fixed height instead.
    if (window.innerWidth < 1024) {
      return { height: window.innerWidth < 640 ? 320 : 380, compact };
    }
    const chrome = compact ? CHROME_SHORT : CHROME_TALL;
    return {
      height: Math.max(MIN_TERMINAL, Math.min(vh - chrome, MAX_TERMINAL)),
      compact,
    };
  };

  const [state, setState] = useState(measure);

  // Layout effect + resize/orientation, so the first paint is already correct
  // rather than being corrected a frame later (which the chart would see as a
  // resize and respond to with a re-fit).
  useLayoutEffect(() => {
    const apply = () => setState((prev) => {
      const n = measure();
      return prev.height === n.height && prev.compact === n.compact ? prev : n;
    });
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
    };
  }, []);

  return state;
}

export default function DelayedVegaPanel() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const { height: terminalHeight, compact } = useTerminal();

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

  /**
   * The polling loop is UNCHANGED — same endpoint, same 60s cadence, same
   * delayed/fallback semantics. The layout work above it does not touch how the
   * data arrives, so the hero chart keeps updating continuously exactly as it
   * did before.
   */
  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const points = useMemo(() => data?.points ?? [], [data]);
  const latest = points.length ? points[points.length - 1] : null;
  const isFallback = !!data?.isFallbackDay;
  const delay = data?.delayMinutes ?? 30;

  // Newest first for the table. Reversed once here rather than in render, so a
  // 60-second poll does not re-reverse a 375-row array on every re-render.
  const rows = useMemo(() => [...points].reverse(), [points]);

  // Where "Go Live Now" sends people. A signed-in user goes straight to the
  // real terminal; everyone else enters the existing registration funnel.
  const liveTarget = user
    ? (user.role === 'admin' ? '/admin' : '/vega-analysis')
    : '/register';

  const emptyLabel = failed
    ? 'The delayed chart is temporarily unavailable. Please try again shortly.'
    : `No Vega data has been recorded for ${SYMBOL} yet. The recorder samples between 09:15 and 15:30 IST on trading days.`;

  return (
    <div className="site-ring shadow-[0_30px_90px_-40px_rgba(0,230,118,0.30)]">
      <div className="site-ring-inner overflow-hidden">
        {/* ================= header (compact) ================= */}
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/[0.07] px-4 sm:px-5 ${compact ? 'py-1.5' : 'py-2.5'}`}>
          <div className="min-w-0">
            <h3 className="font-display text-base font-bold tracking-tight text-text sm:text-lg">
              {SYMBOL} Vega Analysis
            </h3>
            {/* The subtitle is the first thing to go on a short screen — it is
                explanatory, not operational, and it costs 17px of chart. */}
            {!compact && (
              <p className="text-[11px] text-muted">
                Call &amp; Put vega against the day-open baseline
              </p>
            )}
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {isFallback ? (
              <span className="site-badge !py-1 !text-[11px]">
                <HiOutlineClock size={12} />
                Last session · {fmtDateLong(data?.date)}
              </span>
            ) : (
              <DelayBadge minutes={delay} />
            )}
            {latest && (
              <span className="font-mono text-[11px] tabular-nums text-muted">
                as of {fmtTime(latest.time)} IST
              </span>
            )}
          </div>
        </div>

        {/* ================= row 1 · metric tiles =================
            Four across on desktop, two-up on a phone. Deliberately short:
            these are reference values, and every pixel they take is a pixel
            the chart below does not get. */}
        <div className={`grid grid-cols-2 gap-2 border-b border-white/[0.07] px-3 sm:px-4 lg:grid-cols-4 lg:gap-3 ${compact ? 'py-1.5' : 'py-2.5'}`}>
          <Stat label="Call Vega" value={latest?.callVegaDiff} color={PUBLIC_SERIES_COLORS.call} compact={compact} />
          <Stat label="Put Vega" value={latest?.putVegaDiff} color={PUBLIC_SERIES_COLORS.put} compact={compact} />
          <Stat label="Difference" value={latest?.vegaDiff} color={PUBLIC_SERIES_COLORS.diff} compact={compact} />
          <TrendStat trend={latest?.trend} color={latest?.trendColor} count={points.length} compact={compact} />
        </div>

        {/* ================= row 2 · unlock card (centred, compact) =================
            A horizontal bar rather than a tall card. It keeps the centre of the
            panel and the float animation — it is still the primary call to
            action — but at ~100px instead of ~250px, which is most of what buys
            the chart its place above the fold. */}
        <div className={`border-b border-white/[0.07] px-3 sm:px-4 ${compact ? 'py-1.5' : 'py-2.5'}`}>
          <UnlockCard to={liveTarget} signedIn={!!user} compact={compact} />
        </div>

        {/* ================= row 3 · chart + records =================
            SIDE BY SIDE FROM `lg`. The chart dominates (1fr) and the table takes
            a fixed 19rem rail; both are exactly `terminalHeight` tall, so the
            row has one clean baseline. Below `lg` they stack, chart first. */}
        <div className="grid grid-cols-1 gap-3 px-3 py-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:gap-3">
          <div className="min-w-0">
            {/* Legend sits inline above the plot — it belongs to the chart, and
                giving it its own full-width band cost 34px for three words. */}
            <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1">
              {SERIES_LEGEND.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5">
                  <span
                    className="h-0.5 w-4 shrink-0 rounded-full"
                    style={
                      s.dashed
                        ? { backgroundImage: `repeating-linear-gradient(to right, ${s.color} 0 5px, transparent 5px 9px)` }
                        : { background: s.color, boxShadow: `0 0 8px ${s.color}` }
                    }
                  />
                  <span className="text-[11px] font-semibold" style={{ color: s.color }}>
                    {s.label}
                  </span>
                </span>
              ))}
            </div>

            <PublicVegaChart
              points={points}
              loading={loading}
              emptyLabel={emptyLabel}
              variant="hero"
              heightOverride={terminalHeight}
            />
          </div>

          <RecordsTable rows={rows} height={terminalHeight} loading={loading} />
        </div>

        {/* ================= disclosure footer (compact) ================= */}
        <div className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.07] bg-[rgba(255,255,255,0.02)] px-4 sm:px-5 ${compact ? 'py-1.5' : 'py-2.5'}`}>
          <p className="flex max-w-2xl items-start gap-2 text-[11px] leading-relaxed text-muted sm:text-xs">
            <HiOutlineLockClosed size={14} className="mt-0.5 shrink-0 text-primary" />
            <span>
              This chart is{' '}
              <span className="font-semibold text-text">delayed by {delay} minutes</span>.
              {compact
                ? ' Live data needs an approved account.'
                : ' The live chart, historical sessions, option chain and full Greeks need an approved account.'}
            </span>
          </p>
          <Link to={liveTarget} className="site-btn-primary ml-auto !px-4 !py-1.5 !text-xs">
            {user ? 'Open Terminal' : 'Get Access'} <HiOutlineArrowRight size={14} />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * Time-wise records, beside the chart.
 *
 * The same columns the terminal's table carries, rendered from the SAME
 * `points` array the chart is drawn from, so the two cannot disagree about a
 * value. That is a property of the data flow, not something kept in step by
 * effects.
 *
 * `height` is passed in rather than derived so it matches the chart exactly; the
 * header is sticky and the body scrolls inside that box, which is what keeps the
 * whole terminal inside one screen no matter how many rows the session has.
 */
function RecordsTable({ rows, height, loading }) {
  return (
    <div
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[rgba(255,255,255,0.02)]"
      style={{ height }}
    >
      <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">
          Time-wise Records
        </span>
        <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] font-bold text-muted">
          {rows.length}
        </span>
      </div>

      {/* `overscroll-contain` stops a flick at the end of the table from
          scrolling the marketing page underneath it. Scrollbar styling comes
          from the `.site-root` rules in index.css. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-[#0A0F14]">
            <tr className="text-[10px] font-bold uppercase tracking-wider text-muted">
              <th className="px-2 py-1.5 text-left font-bold">Time</th>
              <th className="px-1 py-1.5 text-right font-bold">Call</th>
              <th className="px-1 py-1.5 text-right font-bold">Put</th>
              <th className="px-2 py-1.5 text-right font-bold">Diff</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-8 text-center text-[11px] text-muted">
                  {loading ? 'Loading…' : 'No records yet'}
                </td>
              </tr>
            )}
            {rows.map((p) => (
              <tr
                key={p.time}
                className="border-t border-white/[0.04] transition-colors hover:bg-white/[0.03]"
                title={p.trend || ''}
              >
                <td className="px-2 py-1 font-mono text-[11px] tabular-nums text-muted">
                  {fmtTime(p.time)}
                </td>
                <td
                  className="px-1 py-1 text-right font-mono text-[11px] font-semibold tabular-nums"
                  style={{ color: PUBLIC_SERIES_COLORS.call }}
                >
                  {fmtSigned(p.callVegaDiff)}
                </td>
                <td
                  className="px-1 py-1 text-right font-mono text-[11px] font-semibold tabular-nums"
                  style={{ color: PUBLIC_SERIES_COLORS.put }}
                >
                  {fmtSigned(p.putVegaDiff)}
                </td>
                {/* The trend colour rides on the Difference cell instead of a
                    separate column — a fifth column of word-pills would not fit
                    a 19rem rail, and the colour carries the same information
                    (the row's `title` gives the label on hover). */}
                <td
                  className="px-2 py-1 text-right font-mono text-[11px] font-bold tabular-nums"
                  style={{ color: p.trendColor || PUBLIC_SERIES_COLORS.diff }}
                >
                  {fmtSigned(p.vegaDiff)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The delay disclosure, with an explanation behind an info affordance.
 *
 * Hover alone would hide the explanation from every touch and keyboard user, so
 * the tooltip is driven by `open` state toggled on click as well as hover.
 */
function DelayBadge({ minutes }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative">
      <span
        className="site-badge !border-primary/30 !py-1 !text-[11px] !text-primary"
        style={{ backgroundColor: 'rgba(0,230,118,0.10)' }}
      >
        <HiOutlineClock size={12} />
        {minutes} Min Delayed
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          aria-label="Why is this data delayed?"
          aria-expanded={open}
          className="ml-0.5 rounded-full text-primary/70 transition-colors hover:text-primary"
        >
          <HiOutlineInformationCircle size={14} />
        </button>
      </span>

      {open && (
        <motion.span
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          role="tooltip"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-30 block w-60 rounded-xl border border-white/10 bg-[rgba(8,12,16,0.97)] p-3 text-[11px] leading-relaxed text-muted shadow-card backdrop-blur-xl"
        >
          The public chart is the real NIFTY Vega series, published{' '}
          <span className="font-semibold text-text">{minutes} minutes behind the market</span>.
          Live values, historical sessions and the option chain are part of the subscription.
        </motion.span>
      )}
    </span>
  );
}

/**
 * "Unlock Live Vega Analysis" — centred, and now a horizontal bar.
 *
 * It keeps its identity (emerald ring, live dot, float animation, the CTA) but
 * lays out along the x-axis instead of stacking, which takes it from ~250px of
 * height to ~100px. That reclaimed space is what puts the chart and the records
 * table above the fold together.
 *
 * The glow is dialled back from `shadow-glow` to a tighter ring: at this size a
 * 44px bloom washes into the metric tiles above and the chart below.
 */
function UnlockCard({ to, signedIn, compact }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
      className="mx-auto w-full max-w-3xl lg:animate-float-sm"
    >
      <div
        className={`flex flex-col items-center gap-3 rounded-xl border border-primary/25 bg-[rgba(8,13,17,0.9)] shadow-[0_0_28px_-14px_rgba(0,230,118,0.8)] backdrop-blur-xl sm:flex-row sm:gap-5 sm:px-5 ${
          compact ? 'px-4 py-2' : 'px-4 py-3'
        }`}
      >
        <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 sm:items-start">
          <span className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 sm:justify-start">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-primary">
              Live access
            </span>
            {/* Secondary badge and the description are the compact budget's
                other ~49px. The heading and the CTA — the only two things that
                do a job here — always stay. */}
            {!compact && (
              <span className="rounded-full border border-white/10 px-1.5 text-[9px] font-bold uppercase tracking-[0.1em] text-muted">
                30 min delayed below
              </span>
            )}
          </span>

          <h4
            className={`text-center font-display font-bold leading-tight text-text sm:text-left ${
              compact ? 'text-base' : 'text-base sm:text-lg'
            }`}
          >
            Unlock Live Vega Analysis
          </h4>

          {!compact && (
            <p className="text-center text-[11px] leading-snug text-muted sm:text-left">
              Real-time Vega charts, option analytics, and instant market updates.
            </p>
          )}
        </div>

        <div className="w-full shrink-0 sm:w-auto">
          <Link
            to={to}
            className={`site-cta w-full sm:w-auto ${compact ? '!px-4 !py-2 !text-xs' : '!px-5 !py-2.5 !text-sm'}`}
          >
            {signedIn ? 'Open Live Terminal' : 'Go Live Now'}
            <HiOutlineArrowRight size={15} />
          </Link>
          {!signedIn && !compact && (
            <p className="mt-1 text-center text-[10px] text-muted/75">
              Activated after admin approval.
            </p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** A compact metric tile. Short by design — see the height budget at the top. */
function Stat({ label, value, color, compact }) {
  const n = Number(value);
  const hasValue = value != null && !Number.isNaN(n);

  return (
    <div className={`rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 ${compact ? 'py-1' : 'py-1.5'}`}>
      <div className="truncate text-[9px] font-bold uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <div
        className={`mt-0.5 font-mono font-bold tabular-nums ${compact ? 'text-sm' : 'text-base'}`}
        style={{
          color: hasValue ? color : undefined,
          textShadow: hasValue ? `0 0 16px ${color}44` : undefined,
        }}
      >
        {hasValue ? fmtSigned(value) : <span className="text-muted/40">–</span>}
      </div>
    </div>
  );
}

/** Same shell as Stat, hosting the server-derived trend label. */
function TrendStat({ trend, color, count, compact }) {
  return (
    <div className={`rounded-lg border border-white/[0.07] bg-white/[0.025] px-2.5 ${compact ? 'py-1' : 'py-1.5'}`}>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[9px] font-bold uppercase tracking-[0.14em] text-muted">Trend</span>
        {!!count && (
          <span className="ml-auto font-mono text-[9px] text-muted/60">{count}</span>
        )}
      </div>
      <div
        className={`mt-0.5 truncate font-bold ${compact ? 'text-xs' : 'text-sm'}`}
        style={{ color: color || undefined }}
      >
        {trend || <span className="text-muted/40">–</span>}
      </div>
    </div>
  );
}
