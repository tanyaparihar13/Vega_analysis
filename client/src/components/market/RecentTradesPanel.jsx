import { memo } from 'react';
import { TbHistory } from 'react-icons/tb';
import FeaturePreviewPanel from './FeaturePreviewPanel';
import Skeleton from '../common/Skeleton';

function RecentTradesPanel() {
  return (
    <FeaturePreviewPanel icon={TbHistory} title="Recent Trades" phaseLabel="Phase 6–7">
      <div className="space-y-2.5">
        <div className="grid grid-cols-3 text-[11px] uppercase tracking-wide text-gray-500">
          <span>Time</span>
          <span>Symbol</span>
          <span className="text-right">Price / Qty</span>
        </div>
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="grid grid-cols-3 items-center gap-2">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 w-16" />
            <Skeleton className="ml-auto h-3 w-14" />
          </div>
        ))}
        <p className="pt-1 text-xs text-gray-600">
          Order execution feed lands with the Orders module — this ties into your broker fills, not simulated data.
        </p>
      </div>
    </FeaturePreviewPanel>
  );
}

export default memo(RecentTradesPanel);
