import { memo, useEffect, useRef } from 'react';
import { createChart, ColorType } from 'lightweight-charts';

function AreaChartPanel({ data }) {
  const containerRef = useRef(null);
  const seriesRef = useRef(null);
  const prevLengthRef = useRef(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#64748b' },
      grid: { vertLines: { color: 'rgba(15,23,42,0.06)' }, horzLines: { color: 'rgba(15,23,42,0.06)' } },
      timeScale: { borderColor: '#e2e8f0', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#e2e8f0' },
      autoSize: true,
    });

    const series = chart.addAreaSeries({
      lineColor: '#2563eb',
      topColor: 'rgba(37,99,235,0.22)',
      bottomColor: 'rgba(37,99,235,0.02)',
      lineWidth: 2,
    });

    seriesRef.current = series;

    return () => chart.remove();
  }, []);

  useEffect(() => {
    if (!seriesRef.current || data.length === 0) return;

    if (prevLengthRef.current === 0 || data.length < prevLengthRef.current) {
      seriesRef.current.setData(data);
    } else {
      seriesRef.current.update(data[data.length - 1]);
    }
    prevLengthRef.current = data.length;
  }, [data]);

  return <div ref={containerRef} className="w-full h-full min-h-[280px]" />;
}

export default memo(AreaChartPanel);
