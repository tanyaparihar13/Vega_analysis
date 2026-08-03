import { memo } from 'react';
import IndexCard from './IndexCard';
import { INDEX_SYMBOLS } from '../../utils/constants';

function IndexCardGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {INDEX_SYMBOLS.map((symbol) => (
        <IndexCard key={symbol} symbol={symbol} />
      ))}
    </div>
  );
}

export default memo(IndexCardGrid);
