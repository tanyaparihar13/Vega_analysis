import { memo, useState } from 'react';
import { INDEX_SYMBOLS } from '../../utils/constants';
import { useCandleSeries } from '../../hooks/useCandleSeries';
import CandlestickChart from '../charts/CandlestickChart';
import AreaChartPanel from '../charts/AreaChartPanel';

function MarketChartPanel() {
  const [symbol, setSymbol] = useState(INDEX_SYMBOLS[0]);
  const [chartType, setChartType] = useState('candlestick');
  const { candles, lineSeries } = useCandleSeries(symbol, 60);

  return (
    <div className="glass-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-slate-900 font-semibold">Live Chart</h2>
        <div className="flex items-center gap-2">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="input-dark text-xs py-1.5"
          >
            {INDEX_SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <div className="flex rounded-lg border border-vega-border overflow-hidden text-xs">
            <button
              onClick={() => setChartType('candlestick')}
              className={`px-3 py-1.5 transition-colors ${chartType === 'candlestick' ? 'bg-vega-blue text-white' : 'text-gray-400 hover:bg-white/5'}`}
            >
              Candles
            </button>
            <button
              onClick={() => setChartType('area')}
              className={`px-3 py-1.5 transition-colors ${chartType === 'area' ? 'bg-vega-blue text-white' : 'text-gray-400 hover:bg-white/5'}`}
            >
              Area
            </button>
          </div>
        </div>
      </div>

      <div className="h-[320px]">
        {candles.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">
            Waiting for live ticks to build the chart…
          </div>
        ) : chartType === 'candlestick' ? (
          <CandlestickChart candles={candles} />
        ) : (
          <AreaChartPanel data={lineSeries} />
        )}
      </div>
    </div>
  );
}

export default memo(MarketChartPanel);
