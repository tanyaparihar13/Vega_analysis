import { useState } from 'react';
import { useOptionChain } from './useOptionChain';
import OptionChainTable from './OptionChainTable';

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

function formatExpiry(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: '2-digit', timeZone: 'UTC',
  });
}

function Stat({ label, value, tone = 'text-gray-200', hint }) {
  return (
    <div className="flex flex-col" title={hint}>
      <span className="text-[10px] uppercase tracking-wider text-gray-500">{label}</span>
      <span className={`num text-sm font-semibold ${tone}`}>{value ?? '–'}</span>
    </div>
  );
}

export default function OptionChain() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [showGreeks, setShowGreeks] = useState(true);
  const [showExtended, setShowExtended] = useState(false);

  const { expiries, expiry, setExpiry, snapshot, error, isLive, isUnauthorized } =
    useOptionChain(symbol);

  const spotTone =
    snapshot?.spotChange == null ? 'text-gray-200'
      : snapshot.spotChange > 0 ? 'text-gain' : 'text-loss';

  return (
    <div className="animate-fade-in space-y-3">
      {/* Symbol tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {SYMBOLS.map((s) => (
          <button
            key={s}
            onClick={() => setSymbol(s)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              symbol === s
                ? 'bg-vega-cyan/10 text-vega-cyan shadow-glow-cyan'
                : 'bg-vega-panel text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
          >
            {s}
          </button>
        ))}

        <div className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          {isLive ? (
            <><span className="live-dot" /> <span className="text-vega-green">Live</span></>
          ) : (
            <span className="text-vega-amber">Reconnecting…</span>
          )}
        </div>
      </div>

      {/* Controls + stats */}
      <div className="glass-card flex flex-wrap items-end gap-x-6 gap-y-3 p-3">
        <div className="flex flex-col">
          <label className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Expiry</label>
          <select
            value={expiry ?? ''}
            onChange={(e) => setExpiry(e.target.value)}
            disabled={!expiries.length}
            className="input-dark py-1.5 text-sm disabled:opacity-40"
          >
            {!expiries.length && <option>No expiries</option>}
            {expiries.map((e) => (
              <option key={e} value={e}>{formatExpiry(e)}</option>
            ))}
          </select>
        </div>

        <Stat label="Spot" value={snapshot?.spot?.toFixed(2)} tone={spotTone} />
        <Stat
          label="Change"
          value={snapshot?.spotPercentChange == null ? null : `${snapshot.spotPercentChange.toFixed(2)}%`}
          tone={spotTone}
        />
        <Stat label="ATM" value={snapshot?.atmStrike} tone="text-vega-cyan" />
        <Stat
          label="PCR"
          value={snapshot?.pcr}
          tone={snapshot?.pcr == null ? 'text-gray-200' : snapshot.pcr > 1 ? 'text-gain' : 'text-loss'}
          hint="Total put OI / total call OI across the visible strikes"
        />
        <Stat label="Max Pain" value={snapshot?.maxPain} tone="text-vega-amber" />
        <Stat label="ATM IV" value={snapshot?.atmIv == null ? null : `${snapshot.atmIv}%`} />
        <Stat
          label="IV %ile"
          value={snapshot?.ivPercentile == null ? '–' : `${snapshot.ivPercentile}`}
          hint="Needs ~20 trading days of stored ATM IV before it can be computed"
        />
        <Stat
          label="Days to Expiry"
          value={snapshot?.daysToExpiry == null ? null : snapshot.daysToExpiry.toFixed(2)}
        />

        <div className="ml-auto flex items-center gap-4 text-xs">
          <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
            <input
              type="checkbox"
              checked={showGreeks}
              onChange={(e) => setShowGreeks(e.target.checked)}
              className="accent-vega-cyan"
            />
            Greeks
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-gray-400">
            <input
              type="checkbox"
              checked={showExtended}
              onChange={(e) => setShowExtended(e.target.checked)}
              className="accent-vega-cyan"
            />
            Rho / Intrinsic / Time
          </label>
        </div>
      </div>

      {isUnauthorized && (
        <div className="glass-card border-vega-amber/40 p-4 text-sm text-vega-amber">
          Live data requires a premium account. Your session is connected but not
          authorised for the market feed.
        </div>
      )}

      {error && !isUnauthorized && (
        <div className="glass-card border-vega-red/40 p-4 text-sm text-vega-red">{error}</div>
      )}

      {!snapshot && !error && (
        <div className="glass-card p-10 text-center text-sm text-gray-500">
          Loading {symbol} option chain…
        </div>
      )}

      {snapshot && (
        <div className="glass-card p-2">
          <OptionChainTable
            snapshot={snapshot}
            showGreeks={showGreeks}
            showExtended={showExtended}
          />
          <p className="px-2 pt-2 text-[10px] text-gray-600">
            IV solved from traded price via Black-Scholes; blank where the contract
            carries no time value. OI Change requires a stored previous-close baseline.
            Updated {snapshot.timestamp ? new Date(snapshot.timestamp).toLocaleTimeString('en-IN') : '–'}.
          </p>
        </div>
      )}
    </div>
  );
}