import { memo } from 'react';
import { useMarketData } from '../../hooks/useMarketData';
import { formatPrice, formatChange, formatPercent, formatTimestamp, changeDirection } from '../../utils/formatters';
import Skeleton from '../common/Skeleton';

function IndexCard({ symbol }) {
  const tick = useMarketData(symbol);
  const direction = changeDirection(tick?.change);
  const colorClass = direction === 'up' ? 'text-gain' : direction === 'down' ? 'text-loss' : 'text-gray-400';

  if (!tick) {
    return (
      <div className="glass-card p-5">
        <Skeleton className="h-4 w-24 mb-4" />
        <Skeleton className="h-8 w-32 mb-3" />
        <div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-3 w-full" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="glass-card p-5 transition-shadow hover:shadow-lg hover:shadow-vega-blue/5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-gray-300 font-medium text-sm tracking-wide">{symbol}</h3>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border bg-white/5 ${colorClass} ${direction === 'up' ? 'border-vega-green/30' : direction === 'down' ? 'border-vega-red/30' : 'border-vega-border'}`}>
          {formatPercent(tick.percentChange)}
        </span>
      </div>

      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-2xl font-semibold text-slate-900 tabular-nums">{formatPrice(tick.lastPrice)}</span>
        <span className={`text-sm font-medium tabular-nums ${colorClass}`}>{formatChange(tick.change)}</span>
      </div>

      <div className="grid grid-cols-2 gap-y-1.5 gap-x-4 text-xs">
        <Metric label="Open" value={formatPrice(tick.open)} />
        <Metric label="Prev Close" value={formatPrice(tick.previousClose)} />
        <Metric label="High" value={formatPrice(tick.high)} valueClass="text-vega-green" />
        <Metric label="Low" value={formatPrice(tick.low)} valueClass="text-vega-red" />
      </div>

      <div className="mt-4 pt-3 border-t border-vega-border/50 text-[11px] text-gray-500 flex items-center justify-between">
        <span>Last updated</span>
        <span className="tabular-nums">{formatTimestamp(tick.timestamp)}</span>
      </div>
    </div>
  );
}

function Metric({ label, value, valueClass = 'text-gray-200' }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-500">{label}</span>
      <span className={`font-medium tabular-nums ${valueClass}`}>{value}</span>
    </div>
  );
}

// Symbol never changes per-instance, so this only re-renders when its own
// tick data changes (thanks to the zustand selector in useMarketData).
export default memo(IndexCard);
