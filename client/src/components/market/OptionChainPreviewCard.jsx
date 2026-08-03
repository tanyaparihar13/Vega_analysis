import { memo } from 'react';
import { TbListDetails } from 'react-icons/tb';
import FeaturePreviewPanel from './FeaturePreviewPanel';
import Skeleton from '../common/Skeleton';

function OptionChainPreviewCard({ isPremium }) {
  return (
    <FeaturePreviewPanel icon={TbListDetails} title="Option Chain" phaseLabel="Phase 3" locked={!isPremium}>
      <div className="space-y-2">
        <div className="grid grid-cols-5 text-[11px] uppercase tracking-wide text-gray-500">
          <span>OI</span>
          <span>Volume</span>
          <span className="text-center text-gray-400">Strike</span>
          <span className="text-right">Volume</span>
          <span className="text-right">OI</span>
        </div>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="grid grid-cols-5 items-center gap-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="mx-auto h-3 w-10" />
            <Skeleton className="ml-auto h-3 w-3/4" />
            <Skeleton className="ml-auto h-3 w-full" />
          </div>
        ))}
        <p className="pt-1 text-xs text-gray-600">
          Live CE/PE chain by expiry, sourced from the Kite instrument dump — see <code className="text-gray-500">features/optionChain</code>.
        </p>
      </div>
    </FeaturePreviewPanel>
  );
}

export default memo(OptionChainPreviewCard);
