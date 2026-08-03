import { memo } from 'react';
import { TbActivity, TbPlugConnected, TbLayoutGrid, TbCrown } from 'react-icons/tb';
import { useAuth } from '../../context/AuthContext';
import { useMarketStatus } from '../../hooks/useMarketStatus';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { CONNECTION_STATUS } from '../../services/marketSocket';
import { INDEX_SYMBOLS } from '../../utils/constants';

function StatCard({ icon: Icon, label, value, tone = 'text-gray-200' }) {
  return (
    <div className="glass-card flex items-center gap-3 p-4">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/5">
        <Icon size={18} className={tone} />
      </div>
      <div className="min-w-0">
        <div className="text-[11px] uppercase tracking-wide text-gray-500">{label}</div>
        <div className={`num truncate text-sm font-semibold ${tone}`}>{value}</div>
      </div>
    </div>
  );
}

function StatusCardsRow() {
  const { user } = useAuth();
  const { isOpen, label: marketLabel } = useMarketStatus();
  const connectionStatus = useConnectionStatus();

  const connectionLabel = {
    [CONNECTION_STATUS.CONNECTED]: 'Live',
    [CONNECTION_STATUS.CONNECTING]: 'Connecting',
    [CONNECTION_STATUS.RECONNECTING]: 'Reconnecting',
    [CONNECTION_STATUS.DISCONNECTED]: 'Offline',
    [CONNECTION_STATUS.IDLE]: 'Idle',
  }[connectionStatus] || 'Idle';

  const connectionTone = connectionStatus === CONNECTION_STATUS.CONNECTED ? 'text-vega-green' : 'text-vega-amber';

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <StatCard icon={TbActivity} label="Session" value={marketLabel} tone={isOpen ? 'text-vega-green' : 'text-gray-400'} />
      <StatCard icon={TbPlugConnected} label="Feed Status" value={connectionLabel} tone={connectionTone} />
      <StatCard icon={TbLayoutGrid} label="Instruments Tracked" value={INDEX_SYMBOLS.length} />
      <StatCard
        icon={TbCrown}
        label="Plan"
        value={user?.role === 'admin' ? 'Admin' : user?.role === 'premium' ? 'Premium' : 'Free'}
        tone={user?.role === 'premium' ? 'text-vega-blue-light' : user?.role === 'admin' ? 'text-vega-cyan' : 'text-gray-300'}
      />
    </div>
  );
}

export default memo(StatusCardsRow);
