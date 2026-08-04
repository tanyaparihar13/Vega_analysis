import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiOutlineClock, HiOutlineLockClosed, HiOutlineInformationCircle, HiOutlineArrowRight,
} from 'react-icons/hi';
import publicApi from '../api/publicApi';
import PublicVegaChart, { PUBLIC_SERIES_COLORS } from './PublicVegaChart';
import { useAuth } from '../../context/AuthContext';

/**
 * The delayed NIFTY Vega chart — the centrepiece of the home page.
 *
 * Everything here is real recorded data from the Vega recorder — the same
 * per-minute rows the terminal serves — held back by the delay the server
 * applies. There is no sample data, no synthetic curve and no placeholder
 * series: when the recorder has nothing to show, this panel says so.
 *
 * TELLING THE TRUTH ABOUT WHAT IS ON SCREEN is the whole job of this
 * component's header, and it matters more here than anywhere else on the site
 * because this is the most persuasive surface the product has. Three distinct
 * states have to be distinguishable at a glance:
 *
 *   today, delayed        "30 Min Delayed Market Data"
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

export default function DelayedVegaPanel() {
  const { user } = useAuth();
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

  // Where "Go Live Now" sends people. A signed-in user goes straight to the
  // real terminal; everyone else enters the existing registration funnel. This
  // is the app's own flow, unchanged.
  const liveTarget = user
    ? (user.role === 'admin' ? '/admin' : '/vega-analysis')
    : '/register';

  const emptyLabel = failed
    ? 'The delayed chart is temporarily unavailable. Please try again shortly.'
    : `No Vega data has been recorded for ${SYMBOL} yet. The recorder samples every minute between 09:15 and 15:30 IST on trading days.`;

  return (
    <div className="site-ring shadow-[0_40px_120px_-40px_rgba(0,230,118,0.35)]">
      <div className="site-ring-inner overflow-hidden">
        {/* ================= header ================= */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b border-white/[0.08] px-5 py-4 sm:px-7 sm:py-5">
          <div className="min-w-0">
            <h3 className="font-display text-lg font-bold tracking-tight text-text sm:text-xl">
              {SYMBOL} Vega Analysis
            </h3>
            <p className="mt-0.5 text-xs text-muted sm:text-sm">
              Call &amp; Put vega measured against the day-open baseline
            </p>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {isFallback ? (
              <span className="site-badge">
                <HiOutlineClock size={13} />
                Last session · {fmtDateLong(data?.date)}
              </span>
            ) : (
              <DelayBadge minutes={delay} />
            )}

            {latest?.trend && (
              <span
                className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide"
                style={{
                  color: latest.trendColor,
                  backgroundColor: `${latest.trendColor}1f`,
                  border: `1px solid ${latest.trendColor}55`,
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: latest.trendColor }}
                />
                {latest.trend}
              </span>
            )}
          </div>
        </div>

        {/* ================= headline numbers ================= */}
        <div className="grid grid-cols-3 divide-x divide-white/[0.07] border-b border-white/[0.07]">
          <Stat label="Call Vega" value={latest?.callVegaDiff} color={PUBLIC_SERIES_COLORS.call} />
          <Stat label="Put Vega" value={latest?.putVegaDiff} color={PUBLIC_SERIES_COLORS.put} />
          <Stat label="Difference" value={latest?.vegaDiff} color={PUBLIC_SERIES_COLORS.diff} />
        </div>

        {/* ================= legend ================= */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 pt-4 sm:px-7">
          {SERIES_LEGEND.map((s) => (
            <span key={s.key} className="flex items-center gap-2">
              <span
                className="h-0.5 w-5 shrink-0 rounded-full"
                style={
                  s.dashed
                    ? { backgroundImage: `repeating-linear-gradient(to right, ${s.color} 0 5px, transparent 5px 9px)` }
                    : { background: s.color, boxShadow: `0 0 8px ${s.color}` }
                }
              />
              <span className="text-xs font-semibold" style={{ color: s.color }}>
                {s.label}
              </span>
            </span>
          ))}
          {latest && (
            <span className="ml-auto font-mono text-xs tabular-nums text-muted">
              as of {fmtTime(latest.time)} IST
            </span>
          )}
        </div>

        {/* ================= chart + unlock card =================
            SIDE BY SIDE, NOT OVERLAID.

            The unlock card used to float over the chart (absolute, top-right)
            on large screens. That was always a gamble: the card is ~330px wide
            and ~250px tall, and where the Vega curve actually runs depends on
            the day — a session that trends up puts the Call line straight
            through the card, and on a rangebound day the dashed Difference
            line disappears behind it. Nothing about "the emptiest part of the
            chart" is true often enough to bet the product's most persuasive
            surface on.

            The chart and the card are now grid siblings, so the plot area is
            whatever is left after the card, and the two can never intersect at
            any width. The chart's own ResizeObserver picks up the narrower
            column with no extra work.

            Below `lg` this collapses to one column and the card sits under the
            chart — which is what it already did, because a 330px card over a
            340px-tall phone chart would have covered the very thing it is
            advertising. */}
        <div className="grid grid-cols-1 gap-4 px-2 pb-3 pt-3 sm:px-4 sm:pb-4 lg:grid-cols-[minmax(0,1fr)_20.5rem] lg:items-start lg:gap-5">
          <div className="min-w-0">
            <PublicVegaChart
              points={points}
              loading={loading}
              emptyLabel={emptyLabel}
              variant="hero"
            />
          </div>

          <UnlockCard to={liveTarget} signedIn={!!user} />
        </div>

        {/* ================= premium gate ================= */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-white/[0.08] bg-[rgba(255,255,255,0.02)] px-5 py-4 sm:px-7">
          <p className="flex max-w-2xl items-start gap-2.5 text-xs leading-relaxed text-muted sm:text-sm">
            <HiOutlineLockClosed size={16} className="mt-0.5 shrink-0 text-primary" />
            <span>
              This chart is{' '}
              <span className="font-semibold text-text">delayed by {delay} minutes</span>.
              The live chart, historical sessions, option chain and full Greeks need an
              approved account.
            </span>
          </p>
          <Link to={liveTarget} className="site-btn-primary ml-auto !px-5 !py-2.5 !text-sm">
            {user ? 'Open Terminal' : 'Get Access'} <HiOutlineArrowRight size={15} />
          </Link>
        </div>
      </div>
    </div>
  );
}

/**
 * The delay disclosure, with an explanation behind an info affordance.
 *
 * Hover alone would hide the explanation from every touch and keyboard user, so
 * the tooltip is driven by `open` state toggled on click AND revealed by
 * `focus-within` — which covers tab navigation without any extra handlers.
 */
function DelayBadge({ minutes }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative">
      <span className="site-badge !border-primary/30 !text-primary" style={{ backgroundColor: 'rgba(0,230,118,0.10)' }}>
        <HiOutlineClock size={13} />
        {minutes} Min Delayed Market Data
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
          aria-label="Why is this data delayed?"
          aria-expanded={open}
          className="ml-0.5 rounded-full text-primary/70 transition-colors hover:text-primary"
        >
          <HiOutlineInformationCircle size={15} />
        </button>
      </span>

      {open && (
        <motion.span
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          role="tooltip"
          className="absolute right-0 top-[calc(100%+0.5rem)] z-30 block w-64 rounded-xl border border-white/10 bg-[rgba(8,12,16,0.97)] p-3.5 text-xs leading-relaxed text-muted shadow-card backdrop-blur-xl"
        >
          The public chart is the real NIFTY Vega series, published{' '}
          <span className="font-semibold text-text">{minutes} minutes behind the market</span>.
          Live values, historical sessions and the option chain are part of the
          subscription.
        </motion.span>
      )}
    </span>
  );
}

/**
 * "Unlock Live Vega Analysis".
 *
 * Sits in its own column beside the chart on large screens and stacks under it
 * below `lg`. It is deliberately NOT positioned over the plot any more — see
 * the note on the grid above.
 *
 * The float animation is kept because it is part of the card's character, but
 * it now runs on `float-sm` (a 6px travel instead of 12px) and only from `lg`.
 * In a grid cell the card has neighbours: a 12px bob beside a static chart
 * reads as drift rather than lift, and on a short viewport it would nudge the
 * card's shadow into the panel's bottom rule.
 */
function UnlockCard({ to, signedIn }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18, scale: 0.97 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, amount: 0.4 }}
      transition={{ duration: 0.5, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="relative mx-1 mt-3 w-auto lg:mx-0 lg:mt-2 lg:animate-float-sm"
    >
      <div className="rounded-2xl border border-primary/25 bg-[rgba(8,13,17,0.92)] p-5 shadow-glow backdrop-blur-2xl">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-primary">
            Live access
          </span>
        </div>

        <h4 className="mt-3 font-display text-lg font-bold leading-snug text-text">
          Unlock Live Vega Analysis
        </h4>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Get real-time Vega charts, option analytics, and instant market updates.
        </p>

        <Link
          to={to}
          className="site-cta mt-5 w-full !py-3 !text-[15px]"
        >
          {signedIn ? 'Open Live Terminal' : 'Go Live Now'}
          <HiOutlineArrowRight size={17} />
        </Link>

        {!signedIn && (
          <p className="mt-2.5 text-center text-[11px] text-muted/80">
            Accounts are activated after administrator approval.
          </p>
        )}
      </div>
    </motion.div>
  );
}

function Stat({ label, value, color }) {
  const n = Number(value);
  const hasValue = value != null && !Number.isNaN(n);

  return (
    <div className="px-4 py-4 sm:px-7 sm:py-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted">
        {label}
      </div>
      <div
        className="mt-1.5 font-mono text-xl font-bold tabular-nums sm:text-2xl"
        style={{
          color: hasValue ? color : undefined,
          textShadow: hasValue ? `0 0 22px ${color}55` : undefined,
        }}
      >
        {hasValue ? fmtSigned(value) : <span className="text-muted/40">–</span>}
      </div>
    </div>
  );
}
