import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';

/**
 * The public, delayed Vega chart.
 *
 * Renders the same three signed series the real terminal draws — Call Vega,
 * Put Vega and their Difference, all measured against the frozen day-open
 * baseline — from `/api/public/vega/:symbol/delayed-series`.
 *
 * WHY THIS IS A SEPARATE COMPONENT FROM features/vegaAnalysis/VegaChart.
 * That one is a dense terminal instrument on a LIGHT surface: crosshair readout
 * panel, zoom controls, series toggles, a height that tracks the viewport so it
 * can sit beside a 380px data table. This one is a marketing surface on BLACK —
 * bigger type, more breathing room, no controls to get lost in, and a
 * first-paint reveal animation. Forking the presentation keeps both honest; the
 * arithmetic is shared because neither computes anything. Every value arrives
 * already calculated by vegaTimeseriesService.
 *
 * WHY THE COLOURS ARE DECLARED HERE RATHER THAN IMPORTED.
 * The app's SERIES_COLORS (#0f7a46 / #c62828 / #41527a) are contrast-checked
 * against a WHITE card, which is correct for the terminal and wrong here — on
 * #050505 they are muddy and the slate Difference line all but disappears.
 * Re-tuning them in the app's file would change the terminal, which this work
 * must not touch, so the site carries its own palette with the same semantic
 * mapping: green = calls, red = puts, blue = the difference between them.
 */

/** Site-only. Tuned for a near-black surface; do not use inside the app. */
export const PUBLIC_SERIES_COLORS = {
  call: '#00E676',
  put: '#FF4D6D',
  diff: '#00BFFF',
};

const AXIS_TEXT = '#93A3B4';
const GRID_LINE = 'rgba(255,255,255,0.045)';
const AXIS_LINE = 'rgba(255,255,255,0.10)';
const CROSSHAIR = 'rgba(0,230,118,0.55)';

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});
const fmtIst = (unixSeconds) => IST_TIME.format(new Date(unixSeconds * 1000));

/**
 * Chart height.
 *
 * Two ladders, because the chart appears at two very different jobs:
 *
 *   hero   the full-bleed centrepiece of the page. Tall enough to be the thing
 *          you look at (640px on a desktop), but still tiered down on a phone —
 *          a 640px canvas on a 375px screen is a wall, not a chart, and it
 *          would push every CTA below the fold.
 *   panel  a chart inside a normal card elsewhere on the site.
 *
 * The hero's top tier starts at 1100px rather than 1280 because the hero chart
 * now shares its row with the unlock card (see DelayedVegaPanel) — it measures
 * ~1210px inside a 1600px panel, and the old 1280 threshold would have quietly
 * demoted the widest desktop layout to the 540px tier.
 */
function heightFor(width, variant) {
  if (variant === 'hero') {
    if (width < 480) return 340;
    if (width < 768) return 420;
    if (width < 1100) return 540;
    return 640;
  }
  if (width < 480) return 260;
  if (width < 768) return 300;
  if (width < 1280) return 360;
  return 420;
}

const REVEAL_MS = 1200;

const fmtNum = (v) => (v == null || Number.isNaN(Number(v)) ? '–' : Number(v).toFixed(2));

/**
 * Hover-tooltip geometry. The card is placed from the crosshair and clamped
 * inside the chart box, so it stays readable at both ends of the curve instead
 * of being cut off by the price axis or the left edge.
 */
const TOOLTIP_WIDTH = 178;
const TOOLTIP_HEIGHT = 120;
const TOOLTIP_GAP = 14;

const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function PublicVegaChart({ points, loading = false, emptyLabel, variant = 'panel' }) {
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({ call: null, put: null, diff: null });
  const rafRef = useRef(null);
  // First paint gets the reveal animation; later polls just swap the data in,
  // otherwise the chart would replay its intro every 60 seconds.
  const hasRevealedRef = useRef(false);
  // `applySize` closes over the variant, and the create-once effect depends on
  // `applySize`. Holding the variant in a ref keeps that effect from tearing
  // down and rebuilding the whole chart if the prop ever changes.
  const variantRef = useRef(variant);
  variantRef.current = variant;

  // Only the HEIGHT lives in React state, because only the height is rendered
  // (it reserves the wrapper's space). The chart's width is applied
  // imperatively via `appliedRef` below, so keeping it in state as well would
  // re-render the component on every pixel of a drag-resize for nothing.
  const [height, setHeight] = useState(() => heightFor(1280, variant));

  // The measured width, kept in a ref for the same reason: the ONLY thing that
  // reads it is the tooltip's clamp, which is evaluated during a render that
  // hovering has already caused. Putting it in state would re-render the whole
  // chart on every pixel of a resize to move a card that is not on screen.
  const widthRef = useRef(0);

  // The hovered point plus the crosshair position. Null when the pointer is off
  // the plot, which is also what unmounts the tooltip.
  const [hover, setHover] = useState(null);

  // ---- responsive sizing -------------------------------------------------
  /**
   * TWO HALVES, EACH DOING ONLY WHAT IT IS GOOD AT.
   *
   * 1. React owns the wrapper's HEIGHT, derived from the container's WIDTH
   *    (`heightFor`). This is the part lightweight-charts cannot do for
   *    itself — `autoSize` matches whatever box it is given, it has no opinion
   *    about a 16:9-ish chart wanting to be shorter on a phone.
   *
   * 2. The chart's `autoSize` owns the CANVAS, matching the box React just
   *    sized.
   *
   * The previous version drove both halves by hand: it called
   * `chart.resize(w, h)` and remembered the applied size in a ref so it could
   * skip redundant calls. That is where the bug was. The moment the remembered
   * pair matched what a later measurement computed, every subsequent call
   * early-returned — including the one that was supposed to correct a chart
   * that had ended up at a different size (an entrance animation still
   * running, a StrictMode remount, a scrollbar appearing as the page filled).
   * The chart then rendered 621px tall inside a 540px wrapper and no resize
   * event could ever fix it, because the bookkeeping insisted it was already
   * correct.
   *
   * Letting the library observe its own container removes the bookkeeping, and
   * with it the entire class of "chart and its box disagree" bug.
   */
  const applySize = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;

    const width = Math.floor(el.getBoundingClientRect().width);
    if (!width) return;

    widthRef.current = width;

    setHeight((prev) => {
      const next = heightFor(width, variantRef.current);
      return prev === next ? prev : next;
    });
  }, []);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;

    applySize();

    // A frame after mount the browser has completed its first real layout, so
    // this catches the case where the initial measurement was taken against a
    // container that had not reached its final width yet.
    const raf = requestAnimationFrame(applySize);

    let ro;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(applySize);
      ro.observe(el);
    }

    // Fallback for browsers without ResizeObserver (lightweight-charts asks
    // callers to polyfill it), and the case that matters most on a phone.
    window.addEventListener('resize', applySize);
    window.addEventListener('orientationchange', applySize);

    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
      window.removeEventListener('resize', applySize);
      window.removeEventListener('orientationchange', applySize);
    };
  }, [applySize]);

  /**
   * `autoSize` keeps the canvas matching its box, but it does not re-fit the
   * visible time range — so after a tier change (phone rotated, window
   * widened past a breakpoint) the curve would keep the old horizontal
   * scaling inside a differently-shaped chart.
   */
  useEffect(() => {
    if (!chartRef.current) return;
    chartRef.current.timeScale().fitContent();
  }, [height]);

  // ---- create once -------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const chart = createChart(containerRef.current, {
      // The container is `h-full w-full` inside a wrapper whose pixel height
      // the effect above sets, so "match your container" is exactly right —
      // and it is the library's own ResizeObserver doing it, which cannot fall
      // out of step with the box the way a hand-rolled resize call did.
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: AXIS_TEXT,
        fontSize: 12,
        fontFamily: 'Inter, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: GRID_LINE },
        horzLines: { color: GRID_LINE },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          width: 1, color: CROSSHAIR,
          style: LineStyle.Dashed, labelBackgroundColor: '#00E676',
        },
        horzLine: {
          width: 1, color: CROSSHAIR,
          style: LineStyle.Dashed, labelBackgroundColor: '#00E676',
        },
      },
      rightPriceScale: {
        borderColor: AXIS_LINE,
        scaleMargins: { top: 0.16, bottom: 0.16 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: AXIS_LINE,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 3,
        minBarSpacing: 0.4,
        // lightweight-charts renders timestamps in UTC; the market is IST, so
        // every label is formatted explicitly or a 09:16 sample reads as 03:46.
        tickMarkFormatter: (time) => fmtIst(time),
      },
      localization: {
        timeFormatter: (time) => fmtIst(time),
        priceFormatter: (p) => Number(p).toFixed(2),
      },
      // A hero chart should not swallow the page scroll under a finger or a
      // trackpad. Visitors here are reading, not analysing — the full
      // interactive chart is what they get after approval.
      handleScroll: false,
      handleScale: false,
    });

    const common = {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerRadius: 4,
      crosshairMarkerBorderWidth: 2,
      // The marker's ring has to match the chart's own surface, not white, or
      // every crosshair dot wears a bright halo on this theme.
      crosshairMarkerBorderColor: '#0A0F14',
    };

    seriesRef.current = {
      call: chart.addLineSeries({ ...common, color: PUBLIC_SERIES_COLORS.call }),
      put: chart.addLineSeries({ ...common, color: PUBLIC_SERIES_COLORS.put }),
      diff: chart.addLineSeries({
        ...common, color: PUBLIC_SERIES_COLORS.diff, lineStyle: LineStyle.Dashed,
      }),
    };

    // Everything is a deviation from the day-open baseline, so zero is the
    // reference line that gives the curve meaning.
    seriesRef.current.call.createPriceLine({
      price: 0,
      color: 'rgba(255,255,255,0.30)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: '',
    });

    /**
     * The hover tooltip's feed.
     *
     * `seriesData` is what the library resolved for the hovered time on each
     * line, so the three numbers come from the exact points the curve was drawn
     * from — the tooltip cannot show anything the chart is not showing.
     *
     * Note this is a READ-ONLY subscription: `handleScroll` / `handleScale`
     * stay off, so hovering reveals values without letting a marketing page
     * swallow the visitor's scroll.
     */
    chart.subscribeCrosshairMove((param) => {
      if (!param?.time || !param.point) { setHover(null); return; }
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
    });

    chartRef.current = chart;

    // Make sure the wrapper's height reflects the live container width before
    // the first paint, rather than the initial guess this component mounted
    // with.
    applySize();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      chart.remove();
      chartRef.current = null;
    };
  }, [applySize]);

  // ---- data + first-paint reveal ----------------------------------------
  useEffect(() => {
    const s = seriesRef.current;
    if (!s.call || !points) return undefined;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!points.length) {
      s.call.setData([]); s.put.setData([]); s.diff.setData([]);
      hasRevealedRef.current = false;
      // A tooltip for a point that no longer exists would be worse than none.
      setHover(null);
      return undefined;
    }

    const toLine = (key) => points
      .filter((p) => p[key] != null && Number.isFinite(Number(p[key])))
      .map((p) => ({ time: p.time, value: Number(p[key]) }));

    const call = toLine('callVegaDiff');
    const put = toLine('putVegaDiff');
    const diff = toLine('vegaDiff');

    const paint = (fraction) => {
      const cut = (arr) => arr.slice(0, Math.max(1, Math.ceil(arr.length * fraction)));
      s.call.setData(cut(call));
      s.put.setData(cut(put));
      s.diff.setData(cut(diff));
    };

    // Straight to the finished chart on refreshes, and for anyone who has
    // asked their OS to reduce motion.
    if (hasRevealedRef.current || prefersReducedMotion()) {
      paint(1);
      chartRef.current?.timeScale().fitContent();
      hasRevealedRef.current = true;
      return undefined;
    }

    // Reveal: draw the curve left to right. The time scale is fitted to the
    // FULL range up front so the x-axis stays still while the line grows —
    // fitting each frame would make the whole chart rescale continuously.
    paint(1);
    chartRef.current?.timeScale().fitContent();

    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / REVEAL_MS);
      // easeOutCubic — quick out of the gate, gentle landing.
      paint(1 - (1 - t) ** 3);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        rafRef.current = null;
        hasRevealedRef.current = true;
      }
    };
    paint(0);
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [points]);

  const hasPoints = !!points?.length;

  // The raw point behind the crosshair, for the trend label the series data
  // does not carry.
  const hoverPoint = useMemo(
    () => (hover?.time == null ? null : points?.find((p) => p.time === hover.time) || null),
    [hover?.time, points]
  );

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {hover && hasPoints && (
        <PublicChartTooltip
          time={hover.time}
          call={hover.call ?? hoverPoint?.callVegaDiff}
          put={hover.put ?? hoverPoint?.putVegaDiff}
          diff={hover.diff ?? hoverPoint?.vegaDiff}
          trend={hoverPoint?.trend}
          trendColor={hoverPoint?.trendColor}
          x={hover.x}
          y={hover.y}
          boxWidth={widthRef.current}
          boxHeight={height}
        />
      )}

      {loading && !hasPoints && (
        <div className="absolute inset-0 z-20 grid place-items-center">
          <div className="flex flex-col items-center gap-3">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
            <span className="font-body text-sm font-medium text-muted">
              Loading Vega series…
            </span>
          </div>
        </div>
      )}

      {!loading && !hasPoints && emptyLabel && (
        <div className="absolute inset-0 z-10 grid place-items-center px-6">
          <p className="max-w-md text-center text-sm leading-relaxed text-muted">{emptyLabel}</p>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

/**
 * The hover tooltip for the public chart.
 *
 * Same information as the terminal's — Time, Call Vega, Put Vega, Difference —
 * but styled for this page's near-black surface rather than the terminal's
 * white card, which is the same reason PUBLIC_SERIES_COLORS exists.
 *
 * `pointer-events-none` is required, not cosmetic: a hoverable tooltip would
 * take the pointer off the canvas underneath it, the crosshair would clear, the
 * tooltip would unmount, the pointer would land back on the canvas — and the
 * card would flicker at 60fps wherever it sat under the cursor.
 */
function PublicChartTooltip({ time, call, put, diff, trend, trendColor, x, y, boxWidth, boxHeight }) {
  const width = boxWidth || 0;
  const height = boxHeight || 0;

  // Prefer the right of the cursor, flip to the left when it would clip.
  const flip = width > 0 && x + TOOLTIP_GAP + TOOLTIP_WIDTH > width;
  const left = flip ? x - TOOLTIP_GAP - TOOLTIP_WIDTH : x + TOOLTIP_GAP;
  const top = y - TOOLTIP_HEIGHT / 2;

  const clamp = (v, min, max) => Math.max(min, Math.min(v, max));

  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-30 rounded-xl border border-white/10 bg-[rgba(8,12,16,0.96)] px-3.5 py-2.5 shadow-card backdrop-blur-xl"
      style={{
        width: TOOLTIP_WIDTH,
        left: width ? clamp(left, 4, Math.max(4, width - TOOLTIP_WIDTH - 4)) : left,
        top: height ? clamp(top, 4, Math.max(4, height - TOOLTIP_HEIGHT - 4)) : top,
      }}
    >
      <div className="flex items-baseline justify-between gap-2 border-b border-white/[0.08] pb-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted">Time</span>
        <span className="font-mono text-xs font-bold tabular-nums text-text">{fmtIst(time)}</span>
      </div>

      <div className="mt-2 space-y-1.5">
        <PublicTooltipRow label="Call Vega" value={call} color={PUBLIC_SERIES_COLORS.call} />
        <PublicTooltipRow label="Put Vega" value={put} color={PUBLIC_SERIES_COLORS.put} />
        <PublicTooltipRow label="Difference" value={diff} color={PUBLIC_SERIES_COLORS.diff} />
      </div>

      {trend && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-white/[0.08] pt-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: trendColor }} />
          <span
            className="text-[10px] font-bold uppercase tracking-[0.12em]"
            style={{ color: trendColor }}
          >
            {trend}
          </span>
        </div>
      )}
    </div>
  );
}

function PublicTooltipRow({ label, value, color }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-[11px] font-semibold text-muted">{label}</span>
      </span>
      <span
        className="shrink-0 font-mono text-xs font-bold tabular-nums"
        style={{ color }}
      >
        {fmtNum(value)}
      </span>
    </div>
  );
}

export default memo(PublicVegaChart);
