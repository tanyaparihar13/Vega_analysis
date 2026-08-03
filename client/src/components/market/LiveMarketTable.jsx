import { memo } from 'react';
import { INDEX_SYMBOLS } from '../../utils/constants';
import { useMarketData } from '../../hooks/useMarketData';
import { formatPrice, formatPercent, changeDirection } from '../../utils/formatters';

function LiveMarketTable({ delayed }) {
  return (
    <div className="glass-card p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-slate-900 font-semibold">Live Market</h2>
        {delayed && (
          <span className="text-[10px] uppercase bg-yellow-500/10 text-yellow-400 px-2 py-0.5 rounded-full border border-yellow-500/30">
            Delayed Data
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-left border-b border-vega-border">
              <th className="py-2 font-medium">Symbol</th>
              <th className="py-2 font-medium">LTP</th>
              <th className="py-2 font-medium">Change %</th>
              <th className="py-2 font-medium">Open</th>
              <th className="py-2 font-medium">High</th>
              <th className="py-2 font-medium">Low</th>
              <th className="py-2 font-medium">Close</th>
            </tr>
          </thead>
          <tbody>
            {INDEX_SYMBOLS.map((symbol) => (
              <MemoMarketRow key={symbol} symbol={symbol} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MarketRow({ symbol }) {
  const tick = useMarketData(symbol);

  if (!tick) {
    return (
      <tr className="border-b border-vega-border/50">
        <td className="py-2.5 text-gray-200 font-medium">{symbol}</td>
        <td colSpan={6} className="py-2.5 text-gray-600 text-xs">Waiting for live ticks…</td>
      </tr>
    );
  }

  const direction = changeDirection(tick.change);
  const colorClass = direction === 'up' ? 'text-gain' : direction === 'down' ? 'text-loss' : 'text-gray-400';

  return (
    <tr className="border-b border-vega-border/50 hover:bg-white/5 transition-colors">
      <td className="py-2.5 text-gray-200 font-medium">{symbol}</td>
      <td className="py-2.5 tabular-nums text-slate-800">{formatPrice(tick.lastPrice)}</td>
      <td className={`py-2.5 tabular-nums font-medium ${colorClass}`}>{formatPercent(tick.percentChange)}</td>
      <td className="py-2.5 tabular-nums text-gray-400">{formatPrice(tick.open)}</td>
      <td className="py-2.5 tabular-nums text-gray-400">{formatPrice(tick.high)}</td>
      <td className="py-2.5 tabular-nums text-gray-400">{formatPrice(tick.low)}</td>
      <td className="py-2.5 tabular-nums text-gray-400">{formatPrice(tick.previousClose)}</td>
    </tr>
  );
}

// Each row only re-renders when ITS symbol's tick changes (zustand selector),
// so a NIFTY tick never re-renders the BANKNIFTY row.
const MemoMarketRow = memo(MarketRow);

export default memo(LiveMarketTable);
