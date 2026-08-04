import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  TbChevronLeft, TbChevronRight, TbCalendarStats, TbRefresh,
  TbDatabase, TbBroadcast, TbClockHour4, TbChevronDown, TbCalendarTime,
} from 'react-icons/tb';
import api from '../../api/axios';
import VegaChart, { SERIES_COLORS } from './VegaChart';

/**
 * Vega Analysis — date-wise + expiry-wise historical workspace.
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
 */

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
const TIMEFRAMES = ['1m', '3m', '5m', '15m'];
const POLL_MS = 60_000; // matches the server's per-minute sample cadence

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

const fmtTime = (unixSeconds) =>
  unixSeconds == null
    ? '–'
    : new Date(unixSeconds * 1000).toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
      });

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

function Segmented({ options, value, onChange, ariaLabel }) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex overflow-hidden rounded-lg border border-vega-border bg-vega-panel-muted p-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          onClick={() => onChange(option)}
          aria-pressed={value === option}
          className={`flex-1 rounded-md px-2.5 py-1.5 text-xs font-bold transition-colors sm:px-3 ${
            value === option
              ? 'bg-vega-panel text-vega-blue shadow-sm'
              : 'text-ink-600 hover:text-ink-900'
          }`}
        >
          {option}
        </button>
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

  return (
    <div className="glass-card overflow-hidden">
      <div className={`${cap} px-3 py-2 text-2xs font-bold uppercase tracking-wider text-white`}>
        {label}
      </div>
      <div className="px-3 py-3">
        <div className={`num text-xl font-bold leading-none sm:text-2xl ${valueTone}`}>
          {signed ? fmtSigned(value) : fmt(value)}
        </div>
        {sub && <div className="mt-1.5 text-2xs font-medium text-ink-500">{sub}</div>}
      </div>
    </div>
  );
}

/** Same shell as SummaryTile but hosting the trend pill instead of a number. */
function TrendTile({ latest, count }) {
  return (
    <div className="glass-card overflow-hidden">
      <div className="bg-vega-cyan px-3 py-2 text-2xs font-bold uppercase tracking-wider text-white">
        Trend
      </div>
      <div className="px-3 py-3">
        <div className="flex min-h-[1.75rem] items-center">
          {latest
            ? <TrendBadge label={latest.trend} color={latest.trendColor} />
            : <span className="text-xl font-bold text-ink-400">–</span>}
        </div>
        <div className="mt-1.5 text-2xs font-medium text-ink-500">
          {count ? `${count} record${count === 1 ? '' : 's'}` : 'No records'}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <span className="font-medium text-ink-500">{label}</span>
      <span className="num font-semibold text-ink-900">{value}</span>
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
  // Seeded from the browser, then corrected by the server's IST date as soon
  // as /dates answers.
  const [today, setToday] = useState(browserTodayIst);
  const [date, setDate] = useState(browserTodayIst);
  const [sessions, setSessions] = useState([]);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState({ call: true, put: true, diff: true });
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

  useEffect(() => {
    if (!expiryReady) return undefined; // wait for the expiry list for this scope
    setLoading(true);
    load();
    // Only poll for TODAY — a past day is finished, re-fetching it is waste.
    if (isToday) {
      const id = setInterval(load, POLL_MS);
      return () => clearInterval(id);
    }
    return undefined;
  }, [load, isToday, expiryReady]);

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

  const points = data?.points ?? [];
  const latest = points.length ? points[points.length - 1] : null;
  const tableRows = useMemo(() => [...points].reverse(), [points]); // newest first

  const toggle = (key) => setVisible((v) => ({ ...v, [key]: !v[key] }));

  const selectSymbol = (s) => { setSymbol(s); setDate(today); };

  const sessionForDate = sessions.find((s) => s.date === date);

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

      {/* ---------- Symbol tabs ---------- */}
      {/* Horizontal scroll instead of wrapping: five 100px chips wrap into two
          ragged rows on a phone, which reads as broken. */}
      <div className="scroll-thin -mx-3 flex gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:px-0 sm:pb-0">
        {SYMBOLS.map((s) => (
          <button
            key={s}
            onClick={() => selectSymbol(s)}
            aria-pressed={symbol === s}
            className={`shrink-0 rounded-lg px-3.5 py-2 text-xs font-bold tracking-wide transition-colors sm:text-sm ${
              symbol === s
                ? 'bg-vega-blue text-white shadow-sm'
                : 'border border-vega-border bg-vega-panel text-ink-700 hover:border-vega-border-strong hover:text-ink-900'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* ---------- Toolbar ---------- */}
      <div className="glass-card flex flex-wrap items-center justify-between gap-3 p-3">
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
          <div className="flex items-center gap-2">
            <span className="hidden text-2xs font-bold uppercase tracking-wider text-ink-500 sm:inline">
              Timeframe
            </span>
            <Segmented
              options={TIMEFRAMES}
              value={timeframe}
              onChange={setTimeframe}
              ariaLabel="Chart timeframe"
            />
          </div>

          {/* Changing this refetches the series for the chosen contract; the
              chart, the table and every tile below re-render from that one
              response, so they move together by construction. */}
          <ExpirySelector
            expiries={expiryOptions}
            value={activeExpiry}
            onChange={selectExpiry}
            loading={loading}
          />
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
          sub={latest ? `As of ${fmtTime(latest.time)} IST` : 'Awaiting data'}
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
          Stacks on everything up to a large laptop; the table moves beside the
          chart only when there is genuinely room for both (>=1536px), which is
          the width at which a 380px table stops squeezing the chart. */}
      <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[minmax(0,1fr)_380px]">
        {/*
          The rail becomes a column only at >=1280. At 1024 the desktop sidebar
          has just appeared, so a 216px rail on top of it left the chart with
          466px — narrower than it gets on a tablet. Below xl the rail instead
          spans the full width and lays its three blocks out side by side.
        */}
        <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-[13.5rem_minmax(0,1fr)]">
          {/* Settings rail */}
          <aside className="glass-card grid h-fit grid-cols-1 gap-4 p-4 sm:grid-cols-3 xl:grid-cols-1">
            <div>
              <p className="panel-subtitle">Session</p>
              <p className="num mt-1 text-sm font-bold text-ink-900">{fmtDate(date)}</p>
              <p className="text-2xs font-medium text-ink-500">{fmtDateLong(date)}</p>
              {sessionForDate?.firstAt && (
                <p className="mt-1.5 flex items-center gap-1 text-2xs font-medium text-ink-500">
                  <TbClockHour4 size={12} />
                  {fmtTime(sessionForDate.firstAt)}–{fmtTime(sessionForDate.lastAt)} IST
                </p>
              )}
              {data && (
                <p className="mt-1.5 text-2xs font-medium text-ink-500">
                  {data.source === 'memory' ? 'Streaming from the live sampler' : 'Read from stored history'}
                </p>
              )}
            </div>

            {/* Divider follows the flow direction: a rule above each block when
                stacked, beside it when the three sit in a row. */}
            {data && (
              <div className="border-t border-vega-border pt-3.5 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0 xl:border-l-0 xl:border-t xl:pl-0 xl:pt-3.5">
                <p className="panel-subtitle">Delta filter</p>
                <p className="num mt-1 text-sm font-bold text-ink-900">
                  {data.start?.toFixed(2)} – {data.deltaMax?.toFixed(2)}
                </p>
                <p className="mt-1.5 text-2xs leading-relaxed text-ink-500">
                  |delta| band matching the addvega filter. Values are differences
                  against the day-open baseline.
                </p>
              </div>
            )}

            {data?.dayOpen && (
              <div className="space-y-2 border-t border-vega-border pt-3.5 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0 xl:border-l-0 xl:border-t xl:pl-0 xl:pt-3.5">
                <p className="panel-subtitle">Day open</p>
                <Row label="Call Vega" value={fmt(data.dayOpen.callVega)} />
                <Row label="Put Vega" value={fmt(data.dayOpen.putVega)} />
                <Row
                  label="Strikes"
                  value={
                    data.dayOpen.callStrikes == null
                      ? '–'
                      : `${data.dayOpen.callStrikes}c / ${data.dayOpen.putStrikes}p`
                  }
                />
              </div>
            )}
          </aside>

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
                loading={loading}
                emptyLabel={error ? null : emptyMessage}
                onHoverPoint={setHoverTime}
              />
            </div>
          </section>
        </div>

        {/* Time-wise historical records */}
        <section className="glass-card flex min-w-0 flex-col overflow-hidden">
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
            The scroll box is capped by viewport height on wide screens so the
            table scrolls internally beside the chart, and by a fixed height
            when stacked underneath — an uncapped table with 375 minute-rows
            would otherwise make the page metres long on a phone.
          */}
          <div className="table-scroll max-h-[26rem] flex-1 lg:max-h-[32rem] 2xl:max-h-[calc(100vh-19rem)]">
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
                    <td className="num font-semibold text-ink-700">{fmtTime(p.time)}</td>
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
  );
}
