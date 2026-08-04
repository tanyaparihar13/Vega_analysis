import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';

/**
 * Vega Analysis chart — on TradingView's lightweight-charts.
 *
 * Three signed series, all measured against the frozen day-open baseline:
 *   green  Call Vega   (current call vega − day-open call vega)   PHP diff1
 *   red    Put  Vega   (current put  vega − day-open put  vega)   PHP diff2
 *   slate  Difference  (put diff − call diff)                     PHP diff3
 *
 * RESPONSIVENESS. The chart used to take a fixed 460px height at every width,
 * which on a phone left a letterbox strip with unreadable axis labels, and on a
 * 1440p monitor wasted the bottom half of the card. Height now comes from the
 * container width (see `heightFor`), and a ResizeObserver keeps it correct
 * through sidebar collapse, orientation change and the desktop -> tablet
 * reflow — `autoSize` alone only reacts to the canvas's own box, not to a
 * height we want to derive from the width.
 *
 * This component renders only. Every value arrives already computed by the
 * server (vegaTimeseriesService + vegaMath); no vega arithmetic happens here.
 */

// Contrast-checked against the light card surface (#ffffff / #f8fafc).
export const SERIES_COLORS = {
  call: '#0f7a46',
  put: '#c62828',
  diff: '#41527a',
};

const AXIS_TEXT = '#5a6a85';
const GRID_LINE = 'rgba(15,23,42,0.07)';
const AXIS_LINE = 'rgba(15,23,42,0.16)';

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});

/**
 * lightweight-charts renders timestamps in UTC. Our points are UNIX seconds and
 * the market is IST, so every axis label and crosshair readout is formatted
 * explicitly in Asia/Kolkata — otherwise a 09:16 sample shows as 03:46.
 */
const fmtIst = (unixSeconds) => IST_TIME.format(new Date(unixSeconds * 1000));
const fmtNum = (v) => (v == null || Number.isNaN(Number(v)) ? '–' : Number(v).toFixed(2));

/**
 * Chart height.
 *
 * Keyed off the VIEWPORT, not the container. Those diverge exactly where it
 * matters: at 1700px the workspace puts the records table beside the chart, so
 * the chart's container is only ~760px — container-width tiers would hand the
 * largest monitor the phone-sized 340px box while a 690px table sat next to it.
 *
 * Above the desktop tier the height tracks the viewport so a tall screen
 * actually gets used, capped at 560px so the summary tiles above and the table
 * beside it stay in view together.
 */
function heightFor(viewportWidth, viewportHeight) {
  if (viewportWidth < 480) return 300;
  if (viewportWidth < 768) return 340;
  if (viewportWidth < 1280) return 400;
  return Math.max(440, Math.min(Math.round((viewportHeight || 800) * 0.5), 560));
}

/**
 * Tooltip geometry. The card is positioned from the crosshair and then clamped
 * inside the chart box, so it never hangs off the left edge of a phone-width
 * card or over the price axis on the right.
 */
const TOOLTIP_WIDTH = 208;
const TOOLTIP_HEIGHT = 210;
const TOOLTIP_GAP = 14;

/** DD-MM-YYYY -> "28 Aug", which is how an expiry is said out loud. */
const EXPIRY_LABEL = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric', month: 'short', timeZone: 'UTC',
});
const fmtExpiry = (iso) => {
  if (!iso) return null;
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso).slice(0, 10) : EXPIRY_LABEL.format(d);
};

const fmtStrike = (v) => {
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  // Index strikes are whole numbers; some stock boards list in 2.5s.
  return Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toFixed(2);
};

function VegaChart({ points, visible = {}, loading = false, emptyLabel, onHoverPoint, instrument }) {
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({ call: null, put: null, diff: null });

  // One piece of state for both dimensions, so a single commit-time effect can
  // resize the chart. Splitting them meant a width-only change (sidebar
  // collapse, table moving beside the chart) never re-ran the resize.
  const [size, setSize] = useState({ width: 0, height: 400 });
  const { height } = size;
  const [isNarrow, setIsNarrow] = useState(false);

  // The hovered point: its values AND where the crosshair is, so the tooltip
  // can follow the pointer. Null whenever the pointer is off the plot.
  const [hover, setHover] = useState(null);

  // The parent uses this to highlight the matching row in the records table.
  // Held in a ref so a new callback identity never tears down the chart, and
  // only fired when the hovered MINUTE changes — a crosshair move emits on
  // every mouse pixel, and re-rendering the whole table that often would make
  // the page stutter.
  const onHoverPointRef = useRef(onHoverPoint);
  onHoverPointRef.current = onHoverPoint;
  const lastHoverTimeRef = useRef(null);

  const emitHover = useCallback((time) => {
    if (lastHoverTimeRef.current === time) return;
    lastHoverTimeRef.current = time;
    onHoverPointRef.current?.(time);
  }, []);

  // ---- responsive sizing -------------------------------------------------
  /**
   * The chart is sized EXPLICITLY from this observer rather than by the
   * library's `autoSize` flag, because `autoSize` only ever matches the
   * container's own box — and the height we want is a function of the WIDTH
   * (see `heightFor`). We have to measure the width here anyway, so the same
   * observer may as well own both dimensions; that keeps one source of truth
   * instead of the library and this component each resizing half the chart.
   *
   * The `window` resize/orientation listener is a fallback, not a duplicate:
   * lightweight-charts documents that ResizeObserver may be missing (it asks
   * callers to polyfill), and a viewport change is the case that matters most
   * on a phone. Both paths funnel through the same idempotent `apply`.
   */
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;

    const apply = (rawWidth) => {
      const width = Math.floor(rawWidth || el.getBoundingClientRect().width);
      if (!width) return;
      // Height follows the VIEWPORT; `isNarrow` follows the CONTAINER, because
      // it is about how much room the axis labels have, not how big the screen
      // is. setSize bails on an unchanged pair, so this is safe to call often.
      const height = heightFor(window.innerWidth, window.innerHeight);
      setIsNarrow(width < 560);
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };

    apply(el.getBoundingClientRect().width);

    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) apply(entry.contentRect.width);
      });
      ro.observe(el);
    }

    const onViewportChange = () => apply(el.getBoundingClientRect().width);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('orientationchange', onViewportChange);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('orientationchange', onViewportChange);
    };
  }, []);

  // ---- create once -------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const chart = createChart(containerRef.current, {
      // OFF on purpose: the sizing effect above owns both dimensions, and
      // leaving this on would have the library fight it every frame.
      autoSize: false,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        // Literal colours, not CSS variables — lightweight-charts paints to
        // canvas and never resolves var().
        textColor: AXIS_TEXT,
        fontSize: 12,
        fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace',
      },
      grid: {
        vertLines: { color: GRID_LINE },
        horzLines: { color: GRID_LINE },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { width: 1, color: 'rgba(29,78,216,0.45)', style: LineStyle.Dashed, labelBackgroundColor: '#1d4ed8' },
        horzLine: { width: 1, color: 'rgba(29,78,216,0.45)', style: LineStyle.Dashed, labelBackgroundColor: '#1d4ed8' },
      },
      rightPriceScale: {
        borderColor: AXIS_LINE,
        // Headroom so the top and bottom of the curve never touch the frame.
        scaleMargins: { top: 0.14, bottom: 0.14 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: AXIS_LINE,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        // Stops the axis cramming labels together on a narrow phone.
        minBarSpacing: 0.5,
        tickMarkFormatter: (time) => fmtIst(time),
      },
      localization: {
        timeFormatter: (time) => fmtIst(time),
        priceFormatter: (p) => Number(p).toFixed(2),
      },
      // wheel zoom + drag pan (both default-on, stated explicitly so an edit
      // here is a deliberate choice rather than an accident)
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
    });

    const common = {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      crosshairMarkerBorderColor: '#ffffff',
      lineType: 0,
    };

    seriesRef.current = {
      call: chart.addLineSeries({ ...common, color: SERIES_COLORS.call, title: 'Call Vega' }),
      put: chart.addLineSeries({ ...common, color: SERIES_COLORS.put, title: 'Put Vega' }),
      diff: chart.addLineSeries({
        ...common, color: SERIES_COLORS.diff, lineWidth: 2,
        lineStyle: LineStyle.Dashed, title: 'Difference',
      }),
    };

    // Everything is a deviation from the day-open baseline, so zero is the
    // reference that matters — draw it on the Call series' scale.
    seriesRef.current.call.createPriceLine({
      price: 0,
      color: 'rgba(15,23,42,0.42)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: '',
    });

    /**
     * The tooltip feed.
     *
     * `seriesData` is what the library resolved for the hovered time on each
     * series, so the three numbers are read from the exact same points the
     * lines were drawn from — the tooltip can never disagree with the curve,
     * and since the table renders the same `points` array, it cannot disagree
     * with the table either.
     *
     * A series the user has toggled off is absent from `seriesData`; the
     * tooltip falls back to the raw point for that row (see `hoverPoint`
     * below) so hiding a line never blanks its number.
     */
    chart.subscribeCrosshairMove((param) => {
      if (!param?.time || !param.point) {
        setHover(null);
        emitHover(null);
        return;
      }
      const read = (s) => {
        const v = param.seriesData.get(s);
        return v && typeof v.value === 'number' ? v.value : null;
      };
      setHover({
        time: param.time,
        x: param.point.x,
        y: param.point.y,
        call: read(seriesRef.current.call),
        put: read(seriesRef.current.put),
        diff: read(seriesRef.current.diff),
      });
      emitHover(param.time);
    });

    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      // The parent must not be left highlighting a row for a chart that no
      // longer exists.
      lastHoverTimeRef.current = null;
      onHoverPointRef.current?.(null);
    };
  }, [emitHover]);

  /**
   * The single resize point.
   *
   * Declared AFTER the create-once effect on purpose: effects run in
   * declaration order, so putting it first meant that on mount `chartRef` was
   * still null, the resize was skipped, and the chart kept lightweight-charts'
   * default size until some later resize happened to fire.
   *
   * It also has to run at commit time rather than inside the observer callback
   * (which fires before React has applied the new wrapper height, so the canvas
   * would take the PREVIOUS one) and rather than in requestAnimationFrame,
   * which would make correct sizing depend on a frame ever being painted.
   */
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !size.width) return;
    chart.resize(size.width, size.height);
    chart.timeScale().fitContent();
  }, [size]);

  // Price-scale labels eat horizontal room that a phone does not have.
  useEffect(() => {
    chartRef.current?.applyOptions({
      layout: { fontSize: isNarrow ? 11 : 12 },
      rightPriceScale: { minimumWidth: isNarrow ? 44 : 60 },
      timeScale: { rightOffset: isNarrow ? 2 : 4 },
    });
    // Series titles are drawn INSIDE the pane; on a narrow chart they overlap
    // the curve, and the legend above already names every series.
    const s = seriesRef.current;
    if (s.call) {
      s.call.applyOptions({ title: isNarrow ? '' : 'Call Vega' });
      s.put.applyOptions({ title: isNarrow ? '' : 'Put Vega' });
      s.diff.applyOptions({ title: isNarrow ? '' : 'Difference' });
    }
  }, [isNarrow]);

  // ---- feed data ---------------------------------------------------------
  // Tracks the last series we pushed so we can tell "one new minute arrived"
  // (cheap update) from "the user switched symbol/date/timeframe" (full reset).
  const prevRef = useRef({ len: 0, firstTime: null, lastTime: null });

  useEffect(() => {
    const s = seriesRef.current;
    if (!s.call || !points) return;

    if (!points.length) {
      s.call.setData([]); s.put.setData([]); s.diff.setData([]);
      prevRef.current = { len: 0, firstTime: null, lastTime: null };
      return;
    }

    const toLine = (key) => points
      .filter((p) => p[key] != null && Number.isFinite(Number(p[key])))
      .map((p) => ({ time: p.time, value: Number(p[key]) }));

    const prev = prevRef.current;
    const first = points[0].time;
    const last = points[points.length - 1].time;

    // Same series, exactly one more point on the end -> append only.
    const isAppend =
      prev.len > 0 &&
      prev.firstTime === first &&
      points.length === prev.len + 1 &&
      last > prev.lastTime;

    if (isAppend) {
      const p = points[points.length - 1];
      if (p.callVegaDiff != null) s.call.update({ time: p.time, value: Number(p.callVegaDiff) });
      if (p.putVegaDiff != null) s.put.update({ time: p.time, value: Number(p.putVegaDiff) });
      if (p.vegaDiff != null) s.diff.update({ time: p.time, value: Number(p.vegaDiff) });
    } else {
      // A date/symbol switch replaces the whole series. setData is synchronous,
      // so fitting the range in the same tick avoids the one-frame flash of the
      // previous day's zoom window over the new day's data.
      s.call.setData(toLine('callVegaDiff'));
      s.put.setData(toLine('putVegaDiff'));
      s.diff.setData(toLine('vegaDiff'));
      chartRef.current?.timeScale().fitContent();
    }

    prevRef.current = { len: points.length, firstTime: first, lastTime: last };
  }, [points]);

  // ---- series visibility toggles ----------------------------------------
  useEffect(() => {
    const s = seriesRef.current;
    if (!s.call) return;
    s.call.applyOptions({ visible: visible.call !== false });
    s.put.applyOptions({ visible: visible.put !== false });
    s.diff.applyOptions({ visible: visible.diff !== false });
  }, [visible.call, visible.put, visible.diff]);

  const resetZoom = useCallback(() => chartRef.current?.timeScale().fitContent(), []);

  const latest = points?.length ? points[points.length - 1] : null;

  // The raw point behind the crosshair. It backfills any series the user has
  // hidden, so the tooltip always shows all four values even when only one
  // line is drawn.
  const hoverPoint = useMemo(
    () => (hover?.time == null ? null : points?.find((p) => p.time === hover.time) || null),
    [hover?.time, points]
  );

  const readout = latest && {
    time: latest.time,
    call: latest.callVegaDiff,
    put: latest.putVegaDiff,
    diff: latest.vegaDiff,
  };

  const hasPoints = !!points?.length;

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {/* Latest readout. Constrained width + wrapping so it never runs off the
          left edge of a phone-width card. This stays pinned to the NEWEST point
          rather than following the crosshair — the tooltip below is what
          answers "what is under my cursor", and having both chase the pointer
          left nowhere showing the current value. */}
      {readout && hasPoints && (
        <div className="pointer-events-none absolute left-2 top-2 z-10 flex max-w-[calc(100%-5.5rem)] flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-vega-border bg-vega-panel/95 px-2.5 py-1.5 shadow-sm backdrop-blur-sm">
          <span className="num text-2xs font-bold text-ink-900">{fmtIst(readout.time)}</span>
          <Readout label="Call" value={readout.call} color={SERIES_COLORS.call} />
          <Readout label="Put" value={readout.put} color={SERIES_COLORS.put} />
          <Readout label="Diff" value={readout.diff} color={SERIES_COLORS.diff} />
        </div>
      )}

      {/* Hover tooltip — Time / Call Vega / Put Vega / Difference for the point
          under the crosshair. */}
      {hover && hasPoints && (
        <ChartTooltip
          time={hover.time}
          instrument={instrument}
          // Per-point, not per-chart: a stored series can legitimately span an
          // expiry rollover, and the tooltip should name the contract the point
          // was actually computed against rather than whatever is selected now.
          expiry={hoverPoint?.expiry}
          strike={hoverPoint?.atmStrike}
          call={hover.call ?? hoverPoint?.callVegaDiff}
          put={hover.put ?? hoverPoint?.putVegaDiff}
          diff={hover.diff ?? hoverPoint?.vegaDiff}
          trend={hoverPoint?.trend}
          trendColor={hoverPoint?.trendColor}
          x={hover.x}
          y={hover.y}
          boxWidth={size.width}
          boxHeight={height}
        />
      )}

      {hasPoints && (
        <button
          onClick={resetZoom}
          className="absolute right-2 top-2 z-10 rounded-lg border border-vega-border bg-vega-panel/95 px-2.5 py-1.5 text-2xs font-bold uppercase tracking-wide text-ink-600 shadow-sm backdrop-blur-sm transition-colors hover:border-vega-border-strong hover:text-ink-900"
          title="Reset zoom to fit the whole session"
        >
          Reset
        </button>
      )}

      {loading && (
        <div className="absolute inset-0 z-20 grid place-items-center rounded-lg bg-vega-panel/70 backdrop-blur-[1px]">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-600">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-vega-border-strong border-t-vega-blue" />
            Loading series…
          </div>
        </div>
      )}

      {!loading && !hasPoints && emptyLabel && (
        <div className="absolute inset-0 z-10 grid place-items-center px-6">
          <p className="max-w-md text-center text-sm leading-relaxed text-ink-500">{emptyLabel}</p>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

/**
 * The hover tooltip.
 *
 * Positioned from the crosshair and CLAMPED into the chart box, so it is
 * readable at every point of the curve instead of being cut off at the edges:
 * it flips to the left of the cursor once there is not enough room on the
 * right, and rides up against the bottom edge rather than overflowing it.
 *
 * `pointer-events-none` matters — a tooltip that can be hovered would steal
 * the crosshair from the chart underneath it and flicker.
 */
function ChartTooltip({
  time, instrument, expiry, strike, call, put, diff, trend, trendColor,
  x, y, boxWidth, boxHeight,
}) {
  const width = boxWidth || 0;
  const height = boxHeight || 0;

  // Prefer the right of the cursor; flip left when the card would clip.
  const flip = width > 0 && x + TOOLTIP_GAP + TOOLTIP_WIDTH > width;
  const left = flip ? x - TOOLTIP_GAP - TOOLTIP_WIDTH : x + TOOLTIP_GAP;
  const top = y - TOOLTIP_HEIGHT / 2;

  const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

  const expiryText = fmtExpiry(expiry);
  const strikeText = fmtStrike(strike);

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 rounded-lg border border-vega-border-strong bg-vega-panel/95 px-3 py-2 shadow-glass-lg backdrop-blur-sm"
      style={{
        width: TOOLTIP_WIDTH,
        left: width ? clamp(left, 4, Math.max(4, width - TOOLTIP_WIDTH - 4)) : left,
        top: height ? clamp(top, 4, Math.max(4, height - TOOLTIP_HEIGHT - 4)) : top,
      }}
    >
      {/* Context block: what am I looking at. Rows that have no value are
          omitted rather than shown as a dash — a stored day that predates the
          atm_strike column has no strike to report, and an empty row is more
          honest than "Strike –". */}
      <div className="space-y-0.5 border-b border-vega-border pb-1.5">
        <MetaRow label="Time" value={fmtIst(time)} strong />
        {instrument && <MetaRow label="Instrument" value={instrument} strong />}
        {expiryText && <MetaRow label="Expiry" value={expiryText} />}
        {strikeText && <MetaRow label="Strike" value={strikeText} />}
      </div>

      <div className="mt-1.5 space-y-1">
        <TooltipRow label="Call Vega" value={call} color={SERIES_COLORS.call} />
        <TooltipRow label="Put Vega" value={put} color={SERIES_COLORS.put} />
        <TooltipRow label="Difference" value={diff} color={SERIES_COLORS.diff} />
      </div>

      {trend && (
        <div className="mt-1.5 flex items-center gap-1.5 border-t border-vega-border pt-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: trendColor }} />
          <span className="text-2xs font-bold uppercase tracking-wide" style={{ color: trendColor }}>
            {trend}
          </span>
        </div>
      )}
    </div>
  );
}

function MetaRow({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-2xs font-bold uppercase tracking-wider text-ink-500">{label}</span>
      <span className={`num truncate text-xs ${strong ? 'font-bold text-ink-900' : 'font-semibold text-ink-700'}`}>
        {value}
      </span>
    </div>
  );
}

function TooltipRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-2xs font-semibold text-ink-600">{label}</span>
      </span>
      <span className="num shrink-0 text-xs font-bold" style={{ color }}>{fmtNum(value)}</span>
    </div>
  );
}

function Readout({ label, value, color }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="text-2xs font-semibold text-ink-500">{label}</span>
      <span className="num text-2xs font-bold" style={{ color }}>{fmtNum(value)}</span>
    </span>
  );
}

export default memo(VegaChart);
