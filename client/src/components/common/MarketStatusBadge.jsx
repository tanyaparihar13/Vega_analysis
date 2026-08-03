import { memo } from 'react';
import { useMarketStatus } from '../../hooks/useMarketStatus';

function MarketStatusBadge() {
  const { isOpen, label } = useMarketStatus();

  return (
    <span
      className={`pill ${
        isOpen
          ? 'border-vega-green/40 bg-vega-green-soft text-vega-green'
          : 'border-vega-border bg-vega-panel-muted text-ink-600'
      }`}
      title={`Market is ${isOpen ? 'open' : 'closed'}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${isOpen ? 'bg-vega-green' : 'bg-ink-400'}`} />
      {label}
    </span>
  );
}

export default memo(MarketStatusBadge);
