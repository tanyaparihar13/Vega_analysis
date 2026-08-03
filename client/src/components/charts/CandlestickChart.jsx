import { memo, useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

/**
 * Renders a live-updating candlestick chart. Receives already-aggregated
 * candle data (see hooks/useCandleSeries) and pushes only the latest candle
 * via `update()` when possible, to avoid re-drawing the whole series.
 */
function CandlestickChart({ candles }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const seriesRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#64748b' },
      grid: { vertLines: { color: 'rgba(15,23,42,0.06)' }, horzLines: { color: 'rgba(15,23,42,0.06)' } },
      timeScale: { borderColor: '#e2e8f0', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#e2e8f0' },
      crosshair: { mode: 0 },
      autoSize: true,
    });

    const series = chart.addCandlestickSeries({
      upColor: '#15a05e',
      downColor: '#e03131',
      borderVisible: false,
      wickUpColor: '#15a05e',
      wickDownColor: '#e03131',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => chart.remove();
  }, []);

  // Push data: full set() only when the series length shrinks/resets (symbol
  // switch); otherwise a cheap update() of just the last candle.
  const prevLengthRef = useRef(0);
  useEffect(() => {
    if (!seriesRef.current || candles.length === 0) return;

    if (candles.length < prevLengthRef.current) {
      seriesRef.current.setData(candles);
    } else if (candles.length === prevLengthRef.current) {
      seriesRef.current.update(candles[candles.length - 1]);
    } else if (prevLengthRef.current === 0) {
      seriesRef.current.setData(candles);
    } else {
      seriesRef.current.update(candles[candles.length - 1]);
    }
    prevLengthRef.current = candles.length;
  }, [candles]);

  return <div ref={containerRef} className="w-full h-full min-h-[280px]" />;
}

export default memo(CandlestickChart);
