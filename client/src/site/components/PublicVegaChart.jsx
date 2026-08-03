import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createChart, ColorType, LineStyle, CrosshairMode } from 'lightweight-charts';
import { SERIES_COLORS } from '../../features/vegaAnalysis/VegaChart';

/**
 * The public, delayed Vega chart.
 *
 * Renders the same three signed series the real terminal draws — Call Vega,
 * Put Vega and their Difference, all measured against the frozen day-open
 * baseline — from `/api/public/vega/:symbol/delayed-series`.
 *
 * WHY THIS IS A SEPARATE COMPONENT FROM features/vegaAnalysis/VegaChart.
 * That one is a dense terminal instrument: crosshair readout panel, zoom
 * controls, series toggles, a height that tracks the viewport so it can sit
 * beside a 380px data table. This one is a marketing surface — bigger type,
 * more breathing room, no controls to get lost in, and a first-paint reveal
 * animation. Forking the presentation keeps both honest; the arithmetic is
 * shared because neither computes anything. Every value arrives already
 * calculated by vegaTimeseriesService.
 *
 * SERIES_COLORS is imported rather than redeclared so the teaser a visitor
 * sees and the chart they get after approval are the same colours.
 */

const AXIS_TEXT = '#6b7280';
const GRID_LINE = 'rgba(17,24,39,0.06)';
const AXIS_LINE = 'rgba(17,24,39,0.12)';

const IST_TIME = new Intl.DateTimeFormat('en-IN', {
  hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
});
const fmtIst = (unixSeconds) => IST_TIME.format(new Date(unixSeconds * 1000));

/** Marketing surface: taller and airier than the terminal chart at every step. */
function heightFor(width) {
  if (width < 480) return 260;
  if (width < 768) return 300;
  if (width < 1280) return 360;
  return 420;
}

const REVEAL_MS = 900;

const prefersReducedMotion = () =>
  typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function PublicVegaChart({ points, loading = false, emptyLabel }) {
  const wrapRef = useRef(null);
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef({ call: null, put: null, diff: null });
  const rafRef = useRef(null);
  // First paint gets the reveal animation; later polls just swap the data in,
  // otherwise the chart would replay its intro every 60 seconds.
  const hasRevealedRef = useRef(false);

  // Only the HEIGHT lives in React state, because only the height is rendered
  // (it reserves the wrapper's space). The chart's width is applied
  // imperatively via `appliedRef` below, so keeping it in state as well would
  // re-render the component on every pixel of a drag-resize for nothing.
  const [height, setHeight] = useState(360);

  // ---- responsive sizing -------------------------------------------------
  /**
   * The size actually handed to the CURRENT chart object.
   *
   * This is the crux of the sizing logic, so it is worth being explicit about
   * why React state is not enough on its own.
   *
   * `size` describes what the layout should be. It does NOT describe what the
   * live chart instance has been told, and the two come apart whenever a chart
   * is created while `size` already holds the right numbers — which happens on
   * every StrictMode remount in development, and any time the container
   * reflows after the first measurement (late CSS, web fonts, the hero's
   * entrance animation settling).
   *
   * When that happens, `setSize` bails out because the value is unchanged, no
   * effect re-runs, and a brand-new chart is left sitting at the library's
   * default 150px width inside a 528px card. The symptom is a chart that
   * renders correctly only after the window is resized.
   *
   * Tracking the applied size per chart instance — and resizing imperatively
   * rather than as a side effect of a state change — closes that gap.
   */
  const appliedRef = useRef({ width: 0, height: 0 });

  const applySize = useCallback(() => {
    const el = wrapRef.current;
    const chart = chartRef.current;
    if (!el) return;

    const width = Math.floor(el.getBoundingClientRect().width);
    if (!width) return;
    const nextHeight = heightFor(width);

    // Drives the wrapper so the card reserves the right space.
    setHeight((prev) => (prev === nextHeight ? prev : nextHeight));

    if (!chart) return;
    if (appliedRef.current.width === width && appliedRef.current.height === nextHeight) return;
    appliedRef.current = { width, height: nextHeight };
    chart.resize(width, nextHeight);
    chart.timeScale().fitContent();
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

  // ---- create once -------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return undefined;

    const chart = createChart(containerRef.current, {
      autoSize: false, // the sizing effect below owns both dimensions
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
          width: 1, color: 'rgba(37,99,235,0.4)',
          style: LineStyle.Dashed, labelBackgroundColor: '#2563eb',
        },
        horzLine: {
          width: 1, color: 'rgba(37,99,235,0.4)',
          style: LineStyle.Dashed, labelBackgroundColor: '#2563eb',
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
      crosshairMarkerBorderColor: '#ffffff',
    };

    seriesRef.current = {
      call: chart.addLineSeries({ ...common, color: SERIES_COLORS.call }),
      put: chart.addLineSeries({ ...common, color: SERIES_COLORS.put }),
      diff: chart.addLineSeries({
        ...common, color: SERIES_COLORS.diff, lineStyle: LineStyle.Dashed,
      }),
    };

    // Everything is a deviation from the day-open baseline, so zero is the
    // reference line that gives the curve meaning.
    seriesRef.current.call.createPriceLine({
      price: 0,
      color: 'rgba(17,24,39,0.35)',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: '',
    });

    chartRef.current = chart;

    // A new chart knows nothing about any size already applied to its
    // predecessor, so clear the record and size this one from the live DOM
    // straight away. Without this the chart would keep the library's default
    // dimensions until something else happened to trigger a resize.
    appliedRef.current = { width: 0, height: 0 };
    applySize();

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      chart.remove();
      chartRef.current = null;
      appliedRef.current = { width: 0, height: 0 };
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

  return (
    <div ref={wrapRef} className="relative w-full" style={{ height }}>
      {loading && !hasPoints && (
        <div className="absolute inset-0 z-20 grid place-items-center">
          <div className="flex items-center gap-2.5 text-sm font-medium text-text/50">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
            Loading chart…
          </div>
        </div>
      )}

      {!loading && !hasPoints && emptyLabel && (
        <div className="absolute inset-0 z-10 grid place-items-center px-6">
          <p className="max-w-sm text-center text-sm leading-relaxed text-text/50">{emptyLabel}</p>
        </div>
      )}

      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

export default memo(PublicVegaChart);
