import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TbChevronLeft, TbChevronRight, TbCalendarStats, TbRefresh,
  TbDatabase, TbBroadcast, TbChevronDown, TbCalendarTime,
  TbFileSpreadsheet,
} from 'react-icons/tb';
import api from '../../api/axios';
import { downloadBlob } from '../../utils/download';
import VegaChart, { SERIES_COLORS } from './VegaChart';
import InstrumentSelector from './InstrumentSelector';
import useVegaStream from './useVegaStream';

/**
 * Vega Analysis — instrument-, expiry-, timeframe- and date-wise workspace.
 *
 * Every number is computed server-side (vegaTimeseriesService + vegaMath) and
 * only read here; this component never sums vega.
 *
 * DATE-WISE HISTORY is the organising idea. One piece of state — `date` —
 * drives the chart, the table, the summary tiles and the day-open panel
 * together, and changing it refetches in place (no reload, no route change):
 *
 *   date === today  ->  live series, polled every 60s to match the sampler
 *   any past date   ->  the rows stored in MySQL for that trading day
 *
 * The date is anchored to the SERVER's IST day (`/dates` returns `today`), not
 * the browser clock — otherwise a user outside IST would ask for a date the
 * market has not traded yet and get an empty chart with no explanation.
 *
 * EXPIRY-WISE is the second axis, and it works the same way: `expiry` is a
 * single piece of state that goes into ONE request, and the chart, the table
 * and every tile are all rendered from that one response. There is no separate
 * "chart data" and "table data" fetch to fall out of step — `points` is the
 * single array both read, which is what makes the tooltip and the table
 * numerically identical by construction rather than by luck.
 *
 * WHY THE EXPIRY LIST IS FETCHED PER {symbol, date}: which expiries exist is a
 * property of the session, not of the app. Today offers the contracts the
 * recorder is sampling right now; a past day offers exactly what it recorded,
 * including contracts that have since expired and are gone from the instrument
 * master. Resolving that on the server keeps the dropdown honest — it can only
 * offer an expiry that will actually return data.
 *
 * ===========================================================================
 * TWO SOURCES, ONE ARRAY
 * ===========================================================================
 * Points arrive from exactly one of two places, never both:
 *
 *   today   the WebSocket stream (useVegaStream) — the server pushes one point
 *           per timeframe period, so a 5s chart moves every five seconds and a
 *           15m chart every fifteen minutes, with no polling at all.
 *   history the REST series endpoint, fetched once per {instrument, expiry,
 *           timeframe, date}.
 *
 * `points` below picks between them, and the chart, the table, the tiles and
 * the tooltip all render from that ONE array. There is no path where the chart
 * reads a live value and the table reads a fetched one, which is what makes
 * them identical rather than merely usually-consistent.
 */

const POLL_MS = 60_000;

/**
 * Last-resort instrument list.
 *
 * /vega/instruments answers 503 until the instrument master is loaded, which is
 * the normal state of a fresh install and of any morning before an admin has
 * connected Zerodha. Before the selector existed these five were hardcoded, so
 * the page always had something to select; driving the UI purely from the
 * endpoint reintroduced a state where NOTHING is selectable and the page looks
 * broken rather than merely unconfigured.
 *
 * These five are the curated indices from the server's own constants table —
 * they cannot change without a code change — so hardcoding them as a fallback
 * is safe in a way that hardcoding stock names would not be.
 */
const FALLBACK_INDICES = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'].map((symbol) => ({
  symbol,
  label: symbol,
  category: 'index',
  exchange: symbol === 'SENSEX' ? 'BFO' : 'NFO',
  lotSize: null,
  strikeStep: null,
  recorded: true,
  resolution: '5s',
}));

/**
 * Timeframes, grouped the way a desk says them.
 *
 * Seconds tiers only have history where the recorder stores 5s rows (indices);
 * for a stock they are live-only, and the server reports which tiers a given day
 * can actually serve so the picker can disable the rest instead of returning an
 * empty chart.
 */
const TIMEFRAME_GROUPS = [
  { label: 'Seconds', options: ['5s', '10s', '15s', '30s'] },
  { label: 'Minutes', options: ['1m', '3m', '5m', '10m', '15m'] },
];
const ALL_TIMEFRAMES = TIMEFRAME_GROUPS.flatMap((g) => g.options);

const SERIES_META = [
  { key: 'call', label: 'Call Vega', color: SERIES_COLORS.call },
  { key: 'put', label: 'Put Vega', color: SERIES_COLORS.put },
  { key: 'diff', label: 'Difference', color: SERIES_COLORS.diff },
];

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmt = (v, dp = 2) =>
  v == null || Number.isNaN(Number(v)) ? '–' : Number(v).toFixed(dp);

const fmtSigned = (v, dp = 2) => {
  if (v == null || Number.isNaN(Number(v))) return '–';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(dp)}`;
};

/**
 * Clock formatting, IST (parity item 7).
 *
 * `withSeconds` is driven by the SELECTED TIMEFRAME, not by the data. On a
 * 5s/10s/15s/30s series the minute-only format collapses twelve distinct rows
 * into twelve rows all reading "09:15" — the table stops being readable and, more
 * importantly, stops being matchable against the chart's crosshair. The chart is
 * given the same flag, so the two always print a point's time identically.
 *
 * Rounding is never applied: the timestamp shown is the point's own bucket start,
 * to the second, exactly as recorded.
 */
const IST_HM = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});
const IST_HMS = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZone: 'Asia/Kolkata',
});

const fmtTime = (unixSeconds, withSeconds = false) =>
  unixSeconds == null
    ? '–'
    : (withSeconds ? IST_HMS : IST_HM).format(new Date(unixSeconds * 1000));

/** True for the 5s/10s/15s/30s tiers — the ones whose rows differ within a minute. */
const isSecondsTimeframe = (tf) => /s$/.test(String(tf || ''));

/** ISO (YYYY-MM-DD) -> the DD-MM-YYYY the desk actually reads. */
const fmtDate = (iso) => {
  if (!iso) return '–';
  const [y, m, d] = String(iso).split('-');
  return `${d}-${m}-${y}`;
};

/** "Wed, 30 Jul" — the human anchor beside the numeric date. */
const fmtDateLong = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC',
  });
};

const browserTodayIst = () =>
  new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/** Bullish/Bearish/Sideways pill. Colour is server-derived (datav1.php rules). */
function TrendBadge({ label, color, size = 'md' }) {
  if (!label) return <span className="text-ink-400">–</span>;
  const pad = size === 'sm' ? 'px-2 py-0.5 text-2xs' : 'px-3 py-1 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-bold uppercase tracking-wide ${pad}`}
      style={{ color, backgroundColor: `${color}17`, border: `1px solid ${color}59` }}
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/**
 * Timeframe picker, split into Seconds and Minutes.
 *
 * A tier the current session cannot serve is DISABLED with the reason in its
 * title, not hidden. Hiding it would make the control silently change shape
 * between an index and a stock, and leave a user wondering where 15s went; a
 * greyed button that says "1m history cannot make a 15s bar" answers the
 * question where it is asked.
 */
function TimeframePicker({ value, onChange, servable }) {
  const canUse = (tf) => !servable || servable.includes(tf);

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" role="group" aria-label="Chart timeframe">
      {TIMEFRAME_GROUPS.map((group) => (
        <div key={group.label} className="flex items-center gap-1.5">
          <span className="hidden text-2xs font-bold uppercase tracking-wider text-ink-400 lg:inline">
            {group.label}
          </span>
          <div className="flex overflow-hidden rounded-lg border border-vega-border bg-vega-panel-muted p-0.5">
            {group.options.map((option) => {
              const usable = canUse(option);
              const active = value === option;
              return (
                <button
                  key={option}
                  onClick={() => usable && onChange(option)}
                  disabled={!usable}
                  aria-pressed={active}
                  title={usable
                    ? `${option} bars`
                    : `${option} is not available for this session — the stored data is too coarse`}
                  className={`rounded-md px-2 py-1.5 text-xs font-bold transition-colors ${
                    active
                      ? 'bg-vega-panel text-vega-blue shadow-sm'
                      : usable
                        ? 'text-ink-600 hover:text-ink-900'
                        : 'cursor-not-allowed text-ink-300'
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A headline number. The coloured cap bar carries the identity, the value sits
 * on white at the largest type size on the page — the previous version put a
 * 20px value on a tinted card, which is where most of the "can't read it"
 * complaints came from.
 */
function SummaryTile({ label, value, tone, sub, signed }) {
  const cap =
    tone === 'call' ? 'bg-vega-green'
    : tone === 'put' ? 'bg-vega-red'
    : tone === 'trend' ? 'bg-vega-cyan'
    : 'bg-ink-700';

  const valueTone =
    !signed || value == null || Number.isNaN(Number(value))
      ? 'text-ink-900'
      : Number(value) > 0 ? 'text-vega-green'
      : Number(value) < 0 ? 'text-vega-red'
      : 'text-ink-700';

  // Compact: the cap bar and value keep their identity but give ~30px of height
  // back to the chart, which is the primary element on this page now.
  return (
    <div className="glass-card overflow-hidden">
      <div className={`${cap} px-3 py-1.5 text-2xs font-bold uppercase tracking-wider text-white`}>
        {label}
      </div>
      <div className="px-3 py-2">
        <div className={`num text-lg font-bold leading-none sm:text-xl ${valueTone}`}>
          {signed ? fmtSigned(value) : fmt(value)}
        </div>
        {sub && <div className="mt-1 truncate text-2xs font-medium text-ink-500">{sub}</div>}
      </div>
    </div>
  );
}

/** Same shell as SummaryTile but hosting the trend pill instead of a number. */
function TrendTile({ latest, count }) {
  return (
    <div className="glass-card overflow-hidden">
      <div className="bg-vega-cyan px-3 py-1.5 text-2xs font-bold uppercase tracking-wider text-white">
        Trend
      </div>
      <div className="px-3 py-2">
        <div className="flex min-h-[1.5rem] items-center">
          {latest
            ? <TrendBadge label={latest.trend} color={latest.trendColor} />
            : <span className="text-lg font-bold text-ink-400">–</span>}
        </div>
        <div className="mt-1 text-2xs font-medium text-ink-500">
          {count ? `${count} record${count === 1 ? '' : 's'}` : 'No records'}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date navigator
// ---------------------------------------------------------------------------

/**
 * Date-wise controls: a native picker, step arrows that hop between days that
 * ACTUALLY have data, a jump-to-today button, and a dropdown of stored
 * sessions. The arrows skipping empty days matters — stepping one calendar day
 * at a time walks the user through weekends and holidays that can never have
 * rows.
 */
function DateNavigator({
  date, onChange, today, sessions, live, loading, onRefresh,
}) {
  const [listOpen, setListOpen] = useState(false);
  const listRef = useRef(null);

  useEffect(() => {
    if (!listOpen) return undefined;
    const onDown = (e) => { if (listRef.current && !listRef.current.contains(e.target)) setListOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setListOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [listOpen]);

  // Newest-first list of selectable days: every stored session plus today, so
  // "today" is reachable from the arrows even before the first sample lands.
  const timeline = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const s of [{ date: today, points: null }, ...sessions]) {
      if (!s.date || seen.has(s.date) || s.date > today) continue;
      seen.add(s.date);
      out.push(s);
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [sessions, today]);

  const index = timeline.findIndex((s) => s.date === date);
  // When the chosen date is not itself a session (an empty day the user typed
  // in), fall back to the nearest neighbours by date.
  const olderDate = index >= 0
    ? timeline[index + 1]?.date
    : timeline.find((s) => s.date < date)?.date;
  const newerDate = index >= 0
    ? timeline[index - 1]?.date
    : [...timeline].reverse().find((s) => s.date > date)?.date;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1 rounded-lg border border-vega-border bg-vega-panel p-1">
        <button
          onClick={() => olderDate && onChange(olderDate)}
          disabled={!olderDate}
          className="btn-icon h-8 w-8"
          aria-label="Previous session with data"
          title={olderDate ? `Previous session: ${fmtDate(olderDate)}` : 'No earlier stored session'}
        >
          <TbChevronLeft size={18} />
        </button>

        <label className="relative flex items-center">
          <span className="sr-only">Select date</span>
          <input
            type="date"
            value={date}
            max={today}
            onChange={(e) => onChange(e.target.value || today)}
            className="input-date w-[9.5rem] border-0 px-2 py-1.5 text-xs focus:ring-0 sm:w-[10.5rem] sm:text-sm"
          />
        </label>

        <button
          onClick={() => newerDate && onChange(newerDate)}
          disabled={!newerDate}
          className="btn-icon h-8 w-8"
          aria-label="Next session with data"
          title={newerDate ? `Next session: ${fmtDate(newerDate)}` : 'Already at the latest session'}
        >
          <TbChevronRight size={18} />
        </button>
      </div>

      {/* Stored-session dropdown */}
      <div className="relative" ref={listRef}>
        <button
          onClick={() => setListOpen((v) => !v)}
          className="btn-secondary px-3 py-2 text-xs"
          aria-haspopup="listbox"
          aria-expanded={listOpen}
        >
          <TbCalendarStats size={16} />
          <span className="hidden sm:inline">Sessions</span>
          <span className="rounded-full bg-vega-blue/10 px-1.5 text-2xs font-bold text-vega-blue">
            {sessions.length}
          </span>
          <TbChevronDown size={14} className={listOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
        </button>

        {listOpen && (
          <div
            role="listbox"
            className="scroll-thin absolute left-0 z-40 mt-1.5 max-h-80 w-[17rem] overflow-y-auto rounded-xl border border-vega-border bg-vega-panel p-1.5 shadow-glass-lg"
          >
            <p className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-ink-500">
              Stored trading days
            </p>
            {sessions.length === 0 && (
              <p className="px-2 py-3 text-xs leading-relaxed text-ink-500">
                No history stored yet. Days appear here once the recorder has
                sampled a session.
              </p>
            )}
            {sessions.map((s) => (
              <button
                key={s.date}
                role="option"
                aria-selected={s.date === date}
                onClick={() => { onChange(s.date); setListOpen(false); }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                  s.date === date
                    ? 'bg-vega-blue/10 text-vega-blue'
                    : 'text-ink-700 hover:bg-vega-panel-muted hover:text-ink-900'
                }`}
              >
                <span className="min-w-0">
                  <span className="num block text-xs font-bold">{fmtDate(s.date)}</span>
                  <span className="block text-2xs font-medium text-ink-500">
                    {fmtDateLong(s.date)}
                    {s.firstAt && s.lastAt ? ` · ${fmtTime(s.firstAt)}–${fmtTime(s.lastAt)}` : ''}
                  </span>
                </span>
                <span className="num shrink-0 rounded-full bg-vega-panel-muted px-2 py-0.5 text-2xs font-bold text-ink-600">
                  {s.points}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!live && (
        <button onClick={() => onChange(today)} className="btn-secondary px-3 py-2 text-xs">
          <TbBroadcast size={16} />
          Go live
        </button>
      )}

      <button
        onClick={onRefresh}
        disabled={loading}
        className="btn-icon"
        aria-label="Refresh"
        title="Refresh this session"
      >
        <TbRefresh size={17} className={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expiry selector
// ---------------------------------------------------------------------------

/** An expiry reads as the same DD-MM-YYYY the date picker beside it uses. */
const expiryLabel = (iso) => fmtDate(iso);

/**
 * How far out an expiry is, in trading terms the desk actually says out loud.
 * The nearest one is "Current"; everything after it is counted from there.
 */
function expiryTag(index) {
  if (index === 0) return 'Current';
  if (index === 1) return 'Next';
  return `+${index}`;
}

/**
 * The expiry dropdown.
 *
 * Built as a listbox rather than a native <select> for the same reason the
 * Sessions picker beside it is: each row carries a second line (how many points
 * that expiry has, whether it is being recorded right now), which a native
 * option cannot show and which is the difference between "this expiry is empty
 * because the market is closed" and "this expiry is not being recorded".
 *
 * Closing on outside-click and Escape is handled the same way as the Sessions
 * dropdown, so both behave identically.
 */
function ExpirySelector({ expiries, value, onChange, loading }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activeIndex = expiries.findIndex((e) => e.expiry === value);

  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-2xs font-bold uppercase tracking-wider text-ink-500 sm:inline">
        Expiry
      </span>

      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          disabled={!expiries.length && !value}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label="Select expiry"
          className="btn-secondary px-3 py-2 text-xs"
        >
          <TbCalendarTime size={16} />
          <span className="num font-bold text-ink-900">
            {value ? expiryLabel(value) : loading ? 'Loading…' : 'No expiry'}
          </span>
          {activeIndex >= 0 && (
            <span className="rounded-full bg-vega-blue/10 px-1.5 text-2xs font-bold text-vega-blue">
              {expiryTag(activeIndex)}
            </span>
          )}
          <TbChevronDown
            size={14}
            className={open ? 'rotate-180 transition-transform' : 'transition-transform'}
          />
        </button>

        {open && (
          <div
            role="listbox"
            aria-label="Expiries"
            className="scroll-thin absolute right-0 z-40 mt-1.5 max-h-80 w-[16rem] overflow-y-auto rounded-xl border border-vega-border bg-vega-panel p-1.5 shadow-glass-lg"
          >
            <p className="px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-ink-500">
              Expiries for this session
            </p>

            {expiries.length === 0 && (
              <p className="px-2 py-3 text-xs leading-relaxed text-ink-500">
                No expiry recorded for this session yet.
              </p>
            )}

            {expiries.map((e, i) => (
              <button
                key={e.expiry}
                role="option"
                aria-selected={e.expiry === value}
                onClick={() => { onChange(e.expiry); setOpen(false); }}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                  e.expiry === value
                    ? 'bg-vega-blue/10 text-vega-blue'
                    : 'text-ink-700 hover:bg-vega-panel-muted hover:text-ink-900'
                }`}
              >
                <span className="min-w-0">
                  <span className="num block text-xs font-bold">{expiryLabel(e.expiry)}</span>
                  <span className="block text-2xs font-medium text-ink-500">
                    {fmtDateLong(e.expiry)}
                    {e.recording ? ' · recording' : ''}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="rounded-full bg-vega-panel-muted px-1.5 py-0.5 text-2xs font-bold text-ink-600">
                    {expiryTag(i)}
                  </span>
                  <span className="num rounded-full bg-vega-panel-muted px-2 py-0.5 text-2xs font-bold text-ink-600">
                    {e.points}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function VegaAnalysis() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [timeframe, setTimeframe] = useState('1m');
  // The instrument catalogue: indices + every F&O stock. Fetched ONCE per
  // mount, then filtered in the browser — a per-keystroke search endpoint would
  // be ~200 requests to re-derive a list already in memory.
  const [catalogue, setCatalogue] = useState({ indices: [], stocks: [], loading: true, error: null });
  // Seeded from the browser, then corrected by the server's IST date as soon
  // as /dates answers.
  const [today, setToday] = useState(browserTodayIst);
  const [date, setDate] = useState(browserTodayIst);
  const [sessions, setSessions] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState({ call: true, put: true, diff: true });
  // Excel export state. `error` is reused for failures so there is one place a
  // user looks for "something went wrong on this page".
  const [exporting, setExporting] = useState(false);
  // The point under the chart crosshair, so the matching table row can light
  // up. Time only — the values are already in `points`, and duplicating them
  // here is how a chart and a table drift apart.
  const [hoverTime, setHoverTime] = useState(null);

  /**
   * Expiry selection, scoped to the {symbol, date} it was resolved for.
   *
   * `scope` is what makes this exactly one series request per change instead of
   * two. Which expiries exist depends on the session, so on a symbol/date
   * change the previous selection may be meaningless; until the list for the
   * NEW scope has arrived we have no expiry worth asking for, and the series
   * fetch below simply waits. Without the scope guard the page would fire once
   * with the stale expiry and again with the corrected one — a wasted round
   * trip and a visible flash of the wrong series.
   */
  const [expiryState, setExpiryState] = useState({ scope: null, list: [], value: null });

  const isToday = date === today;
  const scope = `${symbol}|${date}`;
  const expiryReady = expiryState.scope === scope;
  const expiry = expiryReady ? expiryState.value : null;

  // ---- instrument catalogue (once) --------------------------------------
  useEffect(() => {
    let cancelled = false;
    api.get('/vega/instruments')
      .then(({ data: d }) => {
        if (cancelled) return;
        setCatalogue({
          indices: d.indices || [],
          stocks: d.stocks || [],
          loading: false,
          error: d.ready === false ? d.message : null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setCatalogue({
          indices: [], stocks: [], loading: false,
          error: err.response?.data?.message || 'Could not load the instrument list',
        });
      });
    return () => { cancelled = true; };
  }, []);

  /**
   * The lists the UI actually renders.
   *
   * Falls back to the five curated indices whenever the endpoint returned none
   * — 503 before Zerodha is connected, a network failure, an empty payload — so
   * the page is never left with an empty selector and no way to pick anything.
   * The `error` is still surfaced inside the dropdown; this only guarantees
   * there is something to choose while it is shown.
   */
  const availableIndices = catalogue.indices.length ? catalogue.indices : FALLBACK_INDICES;
  const availableStocks = catalogue.stocks;

  // ---- live stream (today only) -----------------------------------------
  /**
   * A historical date has nothing to stream, so the hook is disabled and no
   * socket traffic happens at all — the server never subscribes tokens for a
   * user who is reading last Tuesday.
   */
  const streamEnabled = isToday && expiryReady && !!expiry;
  const stream = useVegaStream({ symbol, expiry, timeframe, enabled: streamEnabled });

  // ---- expiries for the current {symbol, date} --------------------------
  useEffect(() => {
    let cancelled = false;
    api.get(`/vega/${symbol}/expiries`, { params: { date } })
      .then(({ data: d }) => {
        if (cancelled) return;
        const list = d.expiries || [];
        setExpiryState((prev) => {
          // Carry the user's choice across a date/symbol change WHEN that
          // contract also exists in the new session; otherwise fall to the
          // session's nearest expiry rather than showing an empty chart for a
          // contract this day never recorded.
          const keep = list.some((e) => e.expiry === prev.value) ? prev.value : null;
          return { scope: `${symbol}|${date}`, list, value: keep || d.default || null };
        });
      })
      .catch(() => {
        if (cancelled) return;
        // The series endpoint resolves a default expiry on its own, so an
        // unreachable list must not block the chart — unblock the scope with an
        // empty list and let the server choose.
        setExpiryState({ scope: `${symbol}|${date}`, list: [], value: null });
      });
    return () => { cancelled = true; };
  }, [symbol, date]);

  const selectExpiry = useCallback((next) => {
    setExpiryState((prev) => (prev.value === next ? prev : { ...prev, value: next }));
  }, []);

  /**
   * Response-ordering guard.
   *
   * Flipping between expiries faster than the network answers leaves two
   * requests in flight, and HTTP gives no guarantee they come back in order.
   * Without this, the slower FIRST request can land last and repaint the chart
   * and the table with the expiry the user has already navigated away from —
   * while the dropdown still shows the new one. Stamping each request and
   * ignoring anything but the newest makes that impossible.
   */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = (requestSeq.current += 1);
    try {
      // The date is ALWAYS sent, including for today. The server resolves and
      // echoes it back, which keeps "what am I looking at" unambiguous. The
      // expiry is sent the same way; when it is null the server falls back to
      // the nearest one for that day and tells us which it picked.
      const { data: payload } = await api.get(`/vega/${symbol}/series`, {
        params: { timeframe, date, ...(expiry ? { expiry } : {}) },
      });
      if (seq !== requestSeq.current) return;
      setData(payload);
      setError(null);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setError(err.response?.data?.message || 'Could not load the vega series');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [symbol, timeframe, date, expiry]);

  /**
   * The live tail comes from the socket, so REST is fetched ONCE per selection
   * — it is what supplies the day-open panel, the delta band and the baseline
   * flags, which the stream does not carry.
   *
   * Polling survives only as a fallback for when the stream is not healthy (no
   * token, socket refused, server without a Kite session). With the stream up,
   * a 5s chart costs zero HTTP requests, which is the point.
   */
  const streamHealthy = streamEnabled && !!stream.meta && !stream.error;

  /**
   * ONE fetch per selection.
   *
   * `load` changes identity only when {symbol, timeframe, date, expiry} does, so
   * this fires exactly once per selection. It used to also depend on
   * `streamHealthy` — which always flips false -> true once, when the socket's
   * first `vega_subscribed` lands — so EVERY instrument switch fired two
   * identical /series requests, the second one arriving after the chart had
   * already repainted from the stream.
   */
  useEffect(() => {
    if (!expiryReady) return; // wait for the expiry list for this scope
    setLoading(true);
    load();
  }, [load, expiryReady]);

  /**
   * Polling is a FALLBACK, not a companion to the stream: it runs only while the
   * socket is unhealthy (no token, upgrade refused, no Kite session). With the
   * stream up, a 5s chart costs zero HTTP requests.
   */
  useEffect(() => {
    if (!expiryReady || !isToday || streamHealthy) return undefined;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [load, isToday, expiryReady, streamHealthy]);

  // Days that actually have stored data, for the picker. Re-read on symbol
  // change and after each date change, so a day that has just gained its first
  // sample shows up in the list without a reload.
  useEffect(() => {
    let cancelled = false;
    api.get(`/vega/${symbol}/dates`)
      .then(({ data: d }) => {
        if (cancelled) return;
        setSessions(d.dates || []);
        // Adopt the server's IST day. If the user was sitting on what the
        // BROWSER called today, carry them over to the server's today rather
        // than stranding them on a date the market has not traded.
        if (d.today && d.today !== today) {
          setDate((cur) => (cur === today ? d.today : cur));
          setToday(d.today);
        }
      })
      .catch(() => { if (!cancelled) setSessions([]); });
    return () => { cancelled = true; };
  }, [symbol, date, today]);

  /**
   * THE single array. Live when the socket is healthy, stored otherwise.
   *
   * Chart, table, tiles and tooltip all read this one value, so there is no
   * arrangement of state in which they can disagree — synchronisation is a
   * property of the data flow here, not something kept up by effects.
   */
  const points = streamHealthy ? stream.points : (data?.points ?? []);
  const latest = points.length ? points[points.length - 1] : null;
  const tableRows = useMemo(() => [...points].reverse(), [points]); // newest first

  // One flag, read by the chart AND the table, so a point's timestamp is printed
  // to the same precision in both places.
  const showSeconds = isSecondsTimeframe(timeframe);

  /**
   * Excel export (parity item 10).
   *
   * The server rebuilds the rows from the same loadByDate() the chart was filled
   * from, so the file matches what is on screen — including the display sign
   * convention, which the raw database columns do not carry. Exporting from
   * `points` in the browser would work too, but it would silently diverge the
   * moment the chart is showing the live socket tail and the user has scrolled
   * the table, so the selection is sent instead of the data.
   *
   * Auth is a bearer token in localStorage attached by the axios interceptor, so
   * this cannot be a plain <a download> — hence the blob round trip.
   */
  const exportExcel = useCallback(async () => {
    setExporting(true);
    try {
      // Exactly the parameters the series request used, so "the currently viewed
      // data" is not an approximation — an omitted expiry resolves to the same
      // nearest contract on both endpoints.
      const res = await api.get(`/vega/${symbol}/export`, {
        params: { timeframe, date, ...(expiry ? { expiry } : {}) },
        responseType: 'blob',
      });
      downloadBlob(res.data, `vega_${symbol}_${expiry || date}_${timeframe}_${date}.xlsx`);
    } catch {
      setError('Could not build the Excel export for this selection');
    } finally {
      setExporting(false);
    }
  }, [symbol, timeframe, date, expiry]);

  const toggle = (key) => setVisible((v) => ({ ...v, [key]: !v[key] }));

  const selectSymbol = useCallback((s) => {
    setSymbol(s);
    setDate(today);
  }, [today]);

  const selectedInstrument = useMemo(
    () => [...availableIndices, ...availableStocks].find((i) => i.symbol === symbol) || null,
    [availableIndices, availableStocks, symbol]
  );

  /**
   * Which timeframes this session can actually serve.
   *
   * Live is always all of them — the sampler runs at the 5s base clock for
   * anything being watched, whatever its persist resolution. History is limited
   * by what was stored, and the server says which tiers those rows can build.
   */
  const servableTimeframes = streamHealthy ? ALL_TIMEFRAMES : (data?.servableTimeframes ?? ALL_TIMEFRAMES);

  // Never sit on a timeframe the current session cannot produce — stepping from
  // a live index at 5s to a stock's stored history would otherwise show an
  // empty chart with a perfectly valid-looking control.
  useEffect(() => {
    if (servableTimeframes.length && !servableTimeframes.includes(timeframe)) {
      setTimeframe(servableTimeframes.includes('1m') ? '1m' : servableTimeframes[0]);
    }
  }, [servableTimeframes, timeframe]);

  // What the dropdown shows and what the header labels. `data.expiries` is the
  // same list the series response resolved against, so it is used as the
  // fallback when the dedicated call has not answered — the two can never
  // disagree about which expiry produced the points on screen.
  const expiryOptions = expiryState.list.length ? expiryState.list : (data?.expiries ?? []);
  const activeExpiry = expiry || data?.expiry || null;

  const expiryText = activeExpiry ? fmtDate(activeExpiry) : null;

  const emptyMessage = !isToday
    ? `No data stored for ${symbol}${expiryText ? ` (expiry ${expiryText})` : ''} on ${fmtDate(date)}. It may have been a weekend or a market holiday, it may predate the recorder, or that expiry was not being recorded on that day.`
    : data?.hasBaseline
      ? `No samples yet for ${symbol}${expiryText ? ` (expiry ${expiryText})` : ''} today. The first point lands within a minute.`
      : `Waiting for the day-open baseline for ${symbol}${expiryText ? ` (expiry ${expiryText})` : ''}. Recording runs 09:15–15:30 IST on trading days — pick a stored session to review history.`;

  return (
    <div className="animate-fade-in space-y-4">
      {/* ---------- Page header ---------- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-ink-900 sm:text-2xl">Vega Analysis</h1>
          <p className="mt-0.5 text-sm text-ink-500">
            Call/Put vega drift against the day-open baseline, minute by minute.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`pill ${
              data?.live
                ? 'border-vega-green/40 bg-vega-green-soft text-vega-green'
                : 'border-vega-border bg-vega-panel-muted text-ink-600'
            }`}
          >
            {data?.live
              ? <><span className="live-dot" />Live</>
              : <><TbDatabase size={13} />Historical</>}
          </span>
          <span className="num pill border-vega-border bg-vega-panel text-ink-700">
            {fmtDate(data?.date || date)}
          </span>
          {expiryText && (
            <span className="pill border-vega-border bg-vega-panel text-ink-700">
              Exp
              <span className="num font-bold text-ink-900">{expiryText}</span>
            </span>
          )}
        </div>
      </div>

      {/* ---------- Toolbar ----------
          The instrument selector, the index chips and every control now share
          ONE card. They used to be two stacked blocks plus a separate header
          row, which cost ~120px of vertical space before the chart could even
          start — on a 1080p laptop that was the difference between the plot
          being visible on load and needing a scroll. */}
      <div className="glass-card space-y-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <InstrumentSelector
            indices={availableIndices}
            stocks={availableStocks}
            value={symbol}
            onChange={selectSymbol}
            loading={catalogue.loading}
            error={catalogue.error}
          />

          <div className="scroll-thin -mx-1 flex gap-2 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:px-0 sm:pb-0">
            {availableIndices.map((i) => (
              <button
                key={i.symbol}
                onClick={() => selectSymbol(i.symbol)}
                aria-pressed={symbol === i.symbol}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold tracking-wide transition-colors ${
                  symbol === i.symbol
                    ? 'bg-vega-blue text-white shadow-sm'
                    : 'border border-vega-border bg-vega-panel text-ink-700 hover:border-vega-border-strong hover:text-ink-900'
                }`}
              >
                {i.symbol}
              </button>
            ))}
          </div>

          {selectedInstrument?.category === 'stock' && (
            <span className="pill border-vega-border bg-vega-panel-muted text-ink-600">
              {selectedInstrument.exchange}
              {selectedInstrument.lotSize ? ` · lot ${selectedInstrument.lotSize}` : ''}
            </span>
          )}

          {/*
            The delta band, relocated.

            The left rail that used to carry a "Delta filter" card is gone (the
            dashboard is chart-first now), but the band itself is not cosmetic —
            it is WHICH contracts the Call and Put sums are built from, and a
            reader comparing a stock against an index needs to see that they are
            filtered differently. One pill states it without spending a column.
          */}
          {data?.start != null && (
            <span
              className="num pill ml-auto border-vega-border bg-vega-panel-muted text-ink-600"
              title="|delta| band the Call and Put vega sums are summed over, against the day-open baseline"
            >
              Δ {data.start.toFixed(2)}–{data.deltaMax?.toFixed(2)}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-vega-border pt-3">
        <DateNavigator
          date={date}
          onChange={setDate}
          today={today}
          sessions={sessions}
          live={isToday}
          loading={loading}
          onRefresh={() => { setLoading(true); load(); }}
        />

        <div className="flex flex-wrap items-center gap-3">
          <TimeframePicker
            value={timeframe}
            onChange={setTimeframe}
            servable={servableTimeframes}
          />

          {/* Changing this re-subscribes (live) or refetches (historical) for
              the chosen contract; the chart, the table and every tile below
              re-render from that one array, so they move together by
              construction. */}
          <ExpirySelector
            expiries={expiryOptions}
            value={activeExpiry}
            onChange={selectExpiry}
            loading={loading}
          />

          {/* Downloads exactly what the chart and the table are showing: the
              selected instrument, expiry, timeframe and date. */}
          <button
            onClick={exportExcel}
            disabled={exporting || !points.length}
            className="btn-secondary px-3 py-2 text-xs"
            title={points.length
              ? `Download ${points.length} row${points.length === 1 ? '' : 's'} as Excel (.xlsx)`
              : 'Nothing to export for this selection yet'}
          >
            <TbFileSpreadsheet size={16} />
            <span className="hidden sm:inline">{exporting ? 'Preparing…' : 'Excel'}</span>
          </button>
        </div>
        </div>
      </div>

      {/* ---------- Headline numbers ---------- */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <SummaryTile
          label="Call Vega" tone="call" signed value={latest?.callVegaDiff}
          sub={latest ? `Open ${fmt(latest.openCallVega)}` : 'Awaiting data'}
        />
        <SummaryTile
          label="Put Vega" tone="put" signed value={latest?.putVegaDiff}
          sub={latest ? `Open ${fmt(latest.openPutVega)}` : 'Awaiting data'}
        />
        <SummaryTile
          label="Difference" tone="diff" signed value={latest?.vegaDiff}
          sub={latest ? `As of ${fmtTime(latest.time, showSeconds)} IST` : 'Awaiting data'}
        />
        <TrendTile latest={latest} count={points.length} />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-xl border border-vega-red/40 bg-vega-red-soft p-4 text-sm font-medium text-vega-red"
        >
          {error}
        </div>
      )}

      {/* ---------- Workspace ----------
          TERMINAL LAYOUT: CHART AND RECORDS READ TOGETHER.

          What was here originally: a 13.5rem settings rail on the left (Session
          / Delta filter / Day open) and a 380px records table on the right,
          leaving the chart ~1050px of a 1700px page and starting it ~420px down
          — below the fold on a 1080p laptop.

          The settings rail is gone entirely. The records table returns to the
          RIGHT of the chart, because a Vega reading is a comparison between the
          curve and the numbers behind it, and putting the table below the chart
          means never seeing both. Same arrangement as the public terminal.

          NOTHING WAS LOST WITH THE RAIL, only relocated:
            Session date/times -> the Sessions dropdown in the toolbar, which
                                  already lists each day with its recording window
            Delta filter       -> the "Δ 0.20–0.60" pill in the toolbar
            Day open           -> the `sub` line on the Call and Put summary
                                  tiles, which already read "Open 1284.50"

          The table drops BELOW the chart under 1280px, where a 19rem rail would
          leave the plot too narrow to read.
      */}
      {/*
        The rail is 24rem, not 20rem.

        At 20rem the records table's natural width was 411px inside a 308px box,
        so it carried a permanent horizontal scrollbar — the Trend column alone
        needs 167px because it sizes to the widest label in the session
        ("Sideways Bullish"), not to the first row. 24rem plus the tighter cell
        padding in `.data-table` brings the natural width under the available
        width, so the only scrollbar left is the vertical one that belongs
        there. The chart gives up 64px and is still the dominant element.
      */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_24rem]">
          {/* Chart */}
          <section className="glass-card min-w-0 overflow-hidden">
            <div className="panel-head">
              <h2 className="panel-title">Vega Curve</h2>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {SERIES_META.map(({ key, label, color }) => (
                  <button
                    key={key}
                    onClick={() => toggle(key)}
                    aria-pressed={visible[key]}
                    className={`flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-semibold transition-opacity hover:bg-vega-panel-muted ${
                      visible[key] ? 'opacity-100' : 'opacity-45'
                    }`}
                    title={`${visible[key] ? 'Hide' : 'Show'} ${label}`}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={{ background: visible[key] ? color : 'transparent', border: `2px solid ${color}` }}
                    />
                    <span style={{ color: visible[key] ? color : '#7b8aa3' }}>{label}</span>
                  </button>
                ))}
              </div>
              <span className="ml-auto hidden text-2xs font-medium text-ink-500 lg:inline">
                scroll to zoom · drag to pan
              </span>
            </div>

            <div className="p-2 sm:p-3">
              <VegaChart
                points={points}
                visible={visible}
                /**
                 * The veil goes up while the socket is switching series, even
                 * though `points` still holds the OUTGOING curve. That is the
                 * whole no-blank-chart behaviour: the user sees the previous
                 * shape dimmed under a spinner instead of an empty box, and it
                 * is replaced in one commit when the back-fill lands.
                 */
                loading={(loading && !points.length) || stream.switching}
                emptyLabel={error ? null : emptyMessage}
                onHoverPoint={setHoverTime}
                instrument={symbol}
                showSeconds={showSeconds}
              />
            </div>
          </section>

        {/* Time-wise historical records — beside the chart from `xl`.

            THE WRAPPER EXISTS TO BREAK A SIZING CYCLE.

            As a plain grid item the card sized the row, and the row sized the
            card: with no cap, the 9,000px table made the row 9,000px tall and
            dragged the chart card with it. With a cap, the cap and the real row
            height disagreed and left the bottom of the card blank.

            From `xl` the card is taken OUT OF FLOW (`absolute inset-0`), so it
            contributes no height at all. The row is then sized by the chart
            card alone, this wrapper stretches to that row, and the card fills
            the wrapper — one number, defined in one place, with no arithmetic
            repeated in CSS. Below `xl` both revert to normal flow and the
            `max-h-[22rem]` on the scroll box takes over. */}
        <div className="relative min-w-0">
        <section className="glass-card flex min-w-0 flex-col overflow-hidden xl:absolute xl:inset-0">
          <div className="panel-head">
            <h2 className="panel-title">Time-wise Records</h2>
            {/* Naming the expiry here is what stops the table being read as
                "all expiries" once the dropdown exists. */}
            {expiryText && (
              <span className="num rounded-full bg-vega-panel-muted px-2 py-0.5 text-2xs font-bold text-ink-600">
                {expiryText}
              </span>
            )}
            <span className="num ml-auto rounded-full bg-vega-panel-muted px-2 py-0.5 text-2xs font-bold text-ink-600">
              {points.length}
            </span>
          </div>

          {/*
            HEIGHT COMES FROM THE FLEX PARENT, NOT FROM A SECOND CALCULATION.

            This used to carry `xl:max-h-[calc(100vh-32rem)]` — an independent
            guess at the chart's height. The card ALREADY stretches to the grid
            row that the chart card defines, so there were two competing numbers
            and the smaller one won, leaving the bottom of the card blank. At
            1366x768 the gap was ~190px: rows crowded into the top ~146px and
            the rest of the card sat empty.

            `flex-1` + `min-h-0` is the whole fix. `min-h-0` is not optional — a
            flex item defaults to `min-height:auto`, which refuses to shrink
            below its content, and the content here is a ~9,000px table. Without
            it the box grows to the full table height and blows the card open
            instead of scrolling inside it.

            The cap survives only BELOW `xl`, where the table stacks under the
            chart and has no grid row to inherit a height from; there an
            uncapped 4,500-row table would make the page metres long.
          */}
          <div className="table-scroll min-h-0 max-h-[22rem] flex-1 xl:max-h-none">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="text-left">Time</th>
                  <th className="text-right">Call</th>
                  <th className="text-right">Put</th>
                  <th className="text-right">Diff</th>
                  <th className="text-right">Trend</th>
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-sm text-ink-500">
                      {loading ? 'Loading…' : `No records for ${fmtDate(date)}`}
                    </td>
                  </tr>
                )}
                {tableRows.map((p) => (
                  // Hovering the chart lights up the row it came from. Both are
                  // rendered from the same `points` array, so this is a visual
                  // confirmation that the tooltip and the table are reading the
                  // identical record — not a second copy of the numbers.
                  <tr key={p.time} className={p.time === hoverTime ? 'row-linked' : undefined}>
                    {/* Seconds are shown verbatim on a seconds timeframe —
                        09:15:05, 09:15:10, … — never rounded to the minute. */}
                    <td className="num font-semibold text-ink-700">{fmtTime(p.time, showSeconds)}</td>
                    <td className={`text-right ${p.callVegaDiff >= 0 ? 'val-up' : 'val-down'}`}>
                      {fmt(p.callVegaDiff)}
                    </td>
                    <td className={`text-right ${p.putVegaDiff >= 0 ? 'val-up' : 'val-down'}`}>
                      {fmt(p.putVegaDiff)}
                    </td>
                    <td className={`text-right ${p.vegaDiff >= 0 ? 'val-up' : 'val-down'}`}>
                      {fmt(p.vegaDiff)}
                    </td>
                    <td className="text-right">
                      <TrendBadge label={p.trend} color={p.trendColor} size="sm" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        </div>
      </div>
    </div>
  );
}
