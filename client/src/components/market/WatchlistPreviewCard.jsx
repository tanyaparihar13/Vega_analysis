import { memo } from 'react';
import { TbBookmark, TbPlus } from 'react-icons/tb';
import FeaturePreviewPanel from './FeaturePreviewPanel';
import { INDEX_SYMBOLS } from '../../utils/constants';

function WatchlistPreviewCard() {
  return (
    <FeaturePreviewPanel icon={TbBookmark} title="Watchlist" phaseLabel="Phase 6">
      <div className="space-y-1.5">
        {INDEX_SYMBOLS.map((s) => (
          <div key={s} className="flex items-center justify-between rounded-lg px-2 py-1.5 text-sm text-gray-400 hover:bg-white/5">
            {s}
            <span className="text-[10px] text-gray-600">tracked by default</span>
          </div>
        ))}
        <button
          disabled
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-vega-border py-2 text-xs text-gray-600"
        >
          <TbPlus size={14} /> Add symbol — lands with drag/drop persistence
        </button>
      </div>
    </FeaturePreviewPanel>
  );
}

export default memo(WatchlistPreviewCard);
