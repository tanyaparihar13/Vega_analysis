import { memo, useEffect, useMemo, useRef } from 'react';

/**
 * Kite-style layout: calls on the left, strike in the centre, puts on the
 * right. ITM side gets a subtle tint, ATM row gets the accent border.
 *
 * Columns shown (fixed, always visible):
 *   CALL Delta | CALL Vega | Strike | PUT Vega | PUT Delta
 *
 * Uses only the existing design tokens (vega-*, glass-card, num, scroll-thin).
 */

const fmt = (v, dp = 2) =>
  v == null || Number.isNaN(v) ? '–' : Number(v).toFixed(dp);

const fmtInt = (v) =>
  v == null ? '–' : Number(v).toLocaleString('en-IN');

/**
 * ---------------------------------------------------------------------------
 * DELTA BAND FILTER  (display only — snapshot.chain is never touched)
 * ---------------------------------------------------------------------------
 * THE BAND COMES FROM THE SERVER (B-06). It is not defined here.
 *
 * This file used to carry its own DELTA_BANDS table, and it had drifted from
 * the server's:
 *
 *   · stock floor       client 0.05   server 0.20  (vegaConfig.STOCK_START)
 *   · ceiling           client 0.60 hardcoded      server env-tunable
 *                                                  (VEGA_DELTA_MAX)
 *   · epsilon           client 1e-6 slack          server none
 *
 * So the table showed a different basket of strikes from the one the Vega chart
 * was actually summing for the same instrument — and changing VEGA_DELTA_MAX
 * silently desynchronised them further. The history of this file makes the case
 * on its own: it previously shipped with min and max SWAPPED for NIFTY and
 * SENSEX, so `d >= 0.60 && d <= 0.05` was unsatisfiable and the call side was
 * dead for both symbols. Two implementations of one financial rule is one too
 * many.
 *
 * `snapshot.deltaBand` is emitted by optionChainService.buildChain() from
 * vegaConfig.deltaStartFor() — the same function vegaMath's sums are filtered
 * with. The test below is byte-for-byte the server's vegaMath.passes():
 *
 *     abs(delta) >= start && abs(delta) <= max
 *
 * inclusive at both ends, no epsilon, absolute value on both sides. Call delta
 * is positive and put delta negative straight from the feed, so taking the
 * absolute value is what applies one band symmetrically to both — exactly as
 * the engine does.
 * ---------------------------------------------------------------------------
 */

/** Mirrors vegaConfig defaults; used only if a payload predates `deltaBand`. */
const FALLBACK_BAND = { start: 0.05, max: 0.60 };

function getDeltaBand(snapshot) {
  const b = snapshot?.deltaBand;
  return (b && Number.isFinite(Number(b.start)) && Number.isFinite(Number(b.max)))
    ? { start: Number(b.start), max: Number(b.max) }
    : FALLBACK_BAND;
}

/**
 * server/src/utils/vegaMath.js :: passes() — same rule, same inclusivity.
 *
 *     CALL:      start <= delta <=  max
 *     PUT :      -max  <= delta <= -start
 *
 * Signed, not abs(): identical for correctly-signed input, but a put delta that
 * arrives positive (or a call delta that arrives negative) is rejected here the
 * same way the server rejects it, so the table and the Vega sums cannot drift
 * apart on bad data.
 */
function passes(delta, band, side) {
  if (delta == null) return false;
  const d = Number(delta);
  if (!Number.isFinite(d)) return false;
  if (side === 'call') return d >= band.start && d <= band.max;
  if (side === 'put') return d >= -band.max && d <= -band.start;
  return d >= 0 ? (d >= band.start && d <= band.max) : (d >= -band.max && d <= -band.start);
}

/**
 * Which side decides whether a strike is shown.
 *
 *   'CALL' call delta must be in band          <- matches the Zerodha view
 *   'PUT'  put delta must be in band
 *   'OR'   either side
 *   'AND'  both sides
 *
 * 'CALL' is the default because it reproduces the reference screenshot. 'OR'
 * looks wrong on a chain because |Δcall| + |Δput| = 1 at every strike: the
 * 0.90-delta call sits opposite a −0.10 put, which IS inside the band, so 'OR'
 * keeps the deep-ITM rows the band exists to hide.
 *
 * Whichever mode is set, rows are kept or dropped WHOLE — a surviving row
 * always carries the call and the put of the SAME strike, and order is never
 * touched (we filter, we never sort or rebuild).
 */
const MATCH_MODE = 'CALL';

function rowPassesFilter(row, band) {
  const callOk = passes(row?.call?.delta, band, 'call');
  const putOk = passes(row?.put?.delta, band, 'put');
  switch (MATCH_MODE) {
    case 'PUT': return putOk;
    case 'OR': return callOk || putOk;
    case 'AND': return callOk && putOk;
    default: return callOk;
  }
}

/** Flashes a cell when its value changes, the way a real terminal does. */
function useFlash(value) {
  const ref = useRef(null);
  const previous = useRef(value);

  useEffect(() => {
    if (previous.current === value || value == null || previous.current == null) {
      previous.current = value;
      return;
    }
    const up = value > previous.current;
    previous.current = value;
    const el = ref.current;
    if (!el) return;

    el.style.transition = 'none';
    el.style.backgroundColor = up ? 'rgba(22,199,132,0.22)' : 'rgba(255,77,79,0.22)';
    const id = setTimeout(() => {
      el.style.transition = 'background-color 500ms ease-out';
      el.style.backgroundColor = 'transparent';
    }, 60);
    return () => clearTimeout(id);
  }, [value]);

  return ref;
}

const ChainRow = memo(function ChainRow({ row, onSelect, rowRef }) {
  const { call: c, put: p, strike, isAtm } = row;

  const callItm = c.moneyness === 'ITM';
  const putItm = p.moneyness === 'ITM';

  const itmTint = 'bg-vega-amber/[0.06]';
  const rowBase = 'border-b border-vega-border/50 hover:bg-white/[0.03] transition-colors';
  const atmRing = isAtm ? 'ring-1 ring-inset ring-vega-cyan/60' : '';

  return (
    <tr ref={rowRef} className={`${rowBase} ${atmRing}`}>
      {/* ---------- CALL ---------- */}
      <td className={`num px-2 py-1.5 text-right text-gray-400 ${callItm ? itmTint : ''}`}>{fmt(c.delta, 3)}</td>
      <td className={`num px-2 py-1.5 text-right text-gray-400 ${callItm ? itmTint : ''}`}>{fmt(c.vega)}</td>

      {/* ---------- STRIKE ---------- */}
      <td
        onClick={() => onSelect?.(row)}
        className={`num cursor-pointer border-x border-vega-border px-3 py-1.5 text-center font-semibold ${
          isAtm ? 'bg-[#172d3a] text-vega-cyan' : 'bg-vega-panel-raised text-gray-200'
        }`}
      >
        {fmtInt(strike)}
      </td>

      {/* ---------- PUT ---------- */}
      <td className={`num px-2 py-1.5 text-right text-gray-400 ${putItm ? itmTint : ''}`}>{fmt(p.vega)}</td>
      <td className={`num px-2 py-1.5 text-right text-gray-400 ${putItm ? itmTint : ''}`}>{fmt(p.delta, 3)}</td>
    </tr>
  );
});

const Th = ({ children, className = '' }) => (
  <th className={`px-2 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-gray-500 ${className}`}>
    {children}
  </th>
);

export default function OptionChainTable({ snapshot, onSelectStrike }) {
  const atmRef = useRef(null);
  const scrolledFor = useRef(null);

  // Scroll ATM into view once per symbol/expiry, not on every tick.
  useEffect(() => {
    if (!snapshot) return;
    const key = `${snapshot.symbol}-${snapshot.expiry}`;
    if (scrolledFor.current === key) return;
    scrolledFor.current = key;
    atmRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [snapshot]);

  /**
   * Derived view only. .filter() returns a NEW array — snapshot.chain, the
   * WebSocket payload and the backend response are all untouched, so live
   * updates keep flowing exactly as before. Order is preserved: filter never
   * reorders, it only drops non-matching rows.
   */
  const filteredRows = useMemo(() => {
    if (!snapshot?.chain?.length) return [];
    const band = getDeltaBand(snapshot);
    return snapshot.chain.filter((row) => rowPassesFilter(row, band));
  }, [snapshot]);

  /**
   * Column sums across the rows that survived the filter — the same totals
   * the Vega Analysis chart plots through the session.
   */
  const totals = useMemo(() => {
    const sum = (pick) => {
      let acc = 0;
      let seen = 0;
      for (const row of filteredRows) {
        const v = pick(row);
        if (v == null || !Number.isFinite(Number(v))) continue;
        acc += Number(v);
        seen += 1;
      }
      return seen ? acc : null;
    };
    return {
      callDelta: sum((r) => r.call?.delta),
      callVega: sum((r) => r.call?.vega),
      putVega: sum((r) => r.put?.vega),
      putDelta: sum((r) => r.put?.delta),
      count: filteredRows.length,
    };
  }, [filteredRows]);

  if (!snapshot) return null;

  // Fixed 5-column layout: CALL Delta, CALL Vega, Strike, PUT Vega, PUT Delta.
  const CALL_COLUMNS = ['Delta', 'Vega'];
  const PUT_COLUMNS = ['Vega', 'Delta'];

  const callSpan = CALL_COLUMNS.length;
  const putSpan = PUT_COLUMNS.length;

  // Mirrored widths. table-fixed stops the browser sizing each column by
  // content — without it the put side (whose deltas carry a minus sign) comes
  // out fractionally wider and the strike drifts off centre.
  const sideWidth = `${(96 / (callSpan + putSpan)).toFixed(3)}%`;

  const band = getDeltaBand(snapshot);
  const CALL_TOTALS = { Delta: totals.callDelta, Vega: totals.callVega };
  const PUT_TOTALS = { Vega: totals.putVega, Delta: totals.putDelta };
  const totalDp = (label) => (label === 'Delta' ? 3 : 2);

  return (
    <div className="scroll-thin max-h-[70vh] overflow-auto rounded-lg border border-vega-border">
      <table className="w-full table-fixed border-collapse text-xs">
        <colgroup>
          {CALL_COLUMNS.map((label, i) => <col key={`c-${label}-${i}`} style={{ width: sideWidth }} />)}
          <col style={{ width: '4%' }} />
          {PUT_COLUMNS.map((label, i) => <col key={`p-${label}-${i}`} style={{ width: sideWidth }} />)}
        </colgroup>

        <thead className="sticky top-0 z-30 bg-vega-panel">
          <tr className="border-b border-vega-border">
            <th colSpan={callSpan} className="bg-vega-green/10 px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wider text-vega-green">
              Calls
            </th>
            <th className="border-x border-vega-border bg-vega-panel-raised px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wider text-gray-400">
              Strike
            </th>
            <th colSpan={putSpan} className="bg-vega-red/10 px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wider text-vega-red">
              Puts
            </th>
          </tr>

          <tr className="border-b border-vega-border bg-vega-panel">
            {CALL_COLUMNS.map((label, i) => <Th key={`ch-${label}-${i}`}>{label}</Th>)}

            <th className="border-x border-vega-border bg-vega-panel-raised px-3 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Price
            </th>

            {PUT_COLUMNS.map((label, i) => <Th key={`ph-${label}-${i}`}>{label}</Th>)}
          </tr>
        </thead>

        <tbody>
          {filteredRows.map((row) => (
            <ChainRow
              key={row.strike}
              rowRef={row.isAtm ? atmRef : null}
              row={row}
              onSelect={onSelectStrike}
            />
          ))}

          {/* Every strike filtered out — say so rather than showing a blank box. */}
          {!filteredRows.length && (
            <tr>
              <td
                colSpan={callSpan + 1 + putSpan}
                className="px-3 py-8 text-center text-xs text-gray-500"
              >
                No strikes with a call delta between {band.start.toFixed(2)} and{' '}
                {band.max.toFixed(2)} yet. Greeks appear once the feed solves IV
                for these contracts.
              </td>
            </tr>
          )}
        </tbody>

        {/* Column totals for the visible band, pinned to the bottom. */}
        {totals.count > 0 && (
          <tfoot className="sticky bottom-0 z-20 bg-vega-panel">
            <tr className="border-t-2 border-vega-border">
              {CALL_COLUMNS.map((label, i) => (
                <td key={`ct-${label}-${i}`} className="num px-2 py-2 text-right text-[11px] font-semibold text-gray-200">
                  {fmt(CALL_TOTALS[label], totalDp(label))}
                </td>
              ))}

              <td className="border-x border-vega-border bg-vega-panel-raised px-3 py-2 text-center text-[10px] uppercase tracking-wide text-gray-500">
                {totals.count}
              </td>

              {PUT_COLUMNS.map((label, i) => (
                <td key={`pt-${label}-${i}`} className="num px-2 py-2 text-right text-[11px] font-semibold text-gray-200">
                  {fmt(PUT_TOTALS[label], totalDp(label))}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}