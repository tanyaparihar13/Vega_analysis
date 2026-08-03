import { memo } from 'react';
import { CONNECTION_STATUS } from '../../services/marketSocket';

/**
 * `text-yellow-400` (#facc15) was invisible on the light surface — it is a
 * dark-theme colour. The in-between states now use the amber token, which is
 * contrast-checked for white, and each state gets its own soft fill so the
 * badge reads at a glance without relying on the text colour alone.
 */
const STYLES = {
  [CONNECTION_STATUS.IDLE]: { label: 'Loading', dot: 'bg-ink-400', text: 'text-ink-600', chip: 'border-vega-border bg-vega-panel-muted' },
  [CONNECTION_STATUS.CONNECTING]: { label: 'Loading', dot: 'bg-vega-amber animate-pulse', text: 'text-vega-amber', chip: 'border-vega-amber/40 bg-vega-amber-soft' },
  [CONNECTION_STATUS.CONNECTED]: { label: 'Connected', dot: 'bg-vega-green', text: 'text-vega-green', chip: 'border-vega-green/40 bg-vega-green-soft' },
  [CONNECTION_STATUS.RECONNECTING]: { label: 'Reconnecting', dot: 'bg-vega-amber animate-pulse', text: 'text-vega-amber', chip: 'border-vega-amber/40 bg-vega-amber-soft' },
  [CONNECTION_STATUS.DISCONNECTED]: { label: 'Disconnected', dot: 'bg-vega-red', text: 'text-vega-red', chip: 'border-vega-red/40 bg-vega-red-soft' },
};

function ConnectionBadge({ status }) {
  const style = STYLES[status] || STYLES[CONNECTION_STATUS.IDLE];

  return (
    <span className={`pill ${style.chip} ${style.text}`} title={`Market feed: ${style.label}`}>
      <span className={`h-2 w-2 shrink-0 rounded-full ${style.dot}`} />
      {style.label}
    </span>
  );
}

export default memo(ConnectionBadge);
