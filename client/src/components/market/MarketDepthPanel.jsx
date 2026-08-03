import { memo } from 'react';
import { TbLayersSubtract } from 'react-icons/tb';
import FeaturePreviewPanel from './FeaturePreviewPanel';
import Skeleton from '../common/Skeleton';

function DepthRow() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 w-10" />
        <Skeleton className="h-3 flex-1" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-3 flex-1" />
        <Skeleton className="h-3 w-10" />
      </div>
    </div>
  );
}

function MarketDepthPanel() {
  return (
    <FeaturePreviewPanel icon={TbLayersSubtract} title="Market Depth" phaseLabel="Phase 5">
      <div className="space-y-3">
        <div className="grid grid-cols-2 text-[11px] uppercase tracking-wide text-gray-500">
          <span>Bid Qty · Price</span>
          <span className="text-right">Price · Ask Qty</span>
        </div>
        {Array.from({ length: 5 }).map((_, i) => <DepthRow key={i} />)}
        <div className="grid grid-cols-2 gap-3 border-t border-vega-border/60 pt-3 text-xs">
          <span className="text-gray-500">Total Buy Qty <Skeleton className="mt-1 h-3 w-16" /></span>
          <span className="text-right text-gray-500">Total Sell Qty <Skeleton className="mt-1 ml-auto h-3 w-16" /></span>
        </div>
        <p className="pt-1 text-xs text-gray-600">
          5-level bid/ask, OHLC, circuit limits, and average price will populate here from KiteTicker's full mode depth.
        </p>
      </div>
    </FeaturePreviewPanel>
  );
}

export default memo(MarketDepthPanel);
