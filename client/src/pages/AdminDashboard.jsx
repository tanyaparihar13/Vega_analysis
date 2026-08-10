import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api/axios';
import DataManagementPanel from '../features/admin/DataManagementPanel';
import PurgeBackupPanel from '../features/admin/PurgeBackupPanel';
import AuditLogPanel from '../features/admin/AuditLogPanel';
import UserActivityPanel from '../features/admin/UserActivityPanel';
import OnboardingPanel from '../features/admin/OnboardingPanel';

// Onboarding sits second, right after Overview: it is the queue with work in
// it, and burying it behind the data-management tabs would mean new leads are
// found rather than seen.
const TABS = ['Overview', 'Onboarding', 'Data Management', 'Purge & Backup', 'Audit Log', 'User Activity'];

function ZerodhaPanel() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(null); // 'connect' | 'disconnect' | 'refresh'
  const popupRef = useRef(null);

  const loadStatus = useCallback(async () => {
    try {
      const { data } = await api.get('/zerodha/status');
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not read Zerodha status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  /**
   * The OAuth popup reports its outcome with postMessage — see
   * zerodhaController.respond(). Nothing listened for it before, so a
   * successful connect closed the tab and left this page still showing
   * "Not connected" until a manual reload.
   *
   * The message is treated ONLY as a "go re-check with the server" trigger:
   * the connected state is always re-read from /zerodha/status, never taken
   * from the message body. The popup lives on the Cloudflare tunnel origin
   * while this page is on localhost, so we cannot pin event.origin to our own
   * origin — and because we never trust the payload, we do not need to.
   */
  useEffect(() => {
    const onMessage = (event) => {
      const result = event.data;
      if (!result || result.source !== 'vega-zerodha-oauth') return;
      setNotice(result.result?.message || null);
      setBusy(null);
      loadStatus();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [loadStatus]);

  // If the admin closes the popup without finishing, stop showing "Connecting…".
  useEffect(() => {
    if (busy !== 'connect') return undefined;
    const id = setInterval(() => {
      if (popupRef.current?.closed) {
        setBusy(null);
        loadStatus();
      }
    }, 800);
    return () => clearInterval(id);
  }, [busy, loadStatus]);

  const connect = async () => {
    setBusy('connect');
    setNotice(null);
    setError(null);
    try {
      const { data } = await api.get('/zerodha/login-url');
      popupRef.current = window.open(data.loginUrl, 'zerodha-login', 'width=520,height=700');
      if (!popupRef.current) {
        setBusy(null);
        setError('Your browser blocked the login popup. Allow popups for this site and try again.');
      }
    } catch (err) {
      setBusy(null);
      setError(err.response?.data?.message || 'Could not start the Zerodha login flow');
    }
  };

  const disconnect = async () => {
    setBusy('disconnect');
    setNotice(null);
    try {
      const { data } = await api.post('/zerodha/disconnect');
      setNotice(data.message);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Disconnect failed');
    } finally {
      setBusy(null);
    }
  };

  const refreshInstruments = async () => {
    setBusy('refresh');
    setNotice(null);
    try {
      const { data } = await api.post('/zerodha/refresh-instruments');
      setNotice(`Instrument master refreshed — ${data.count ?? data.stats?.instrumentCount ?? 0} contracts.`);
      await loadStatus();
    } catch (err) {
      setError(err.response?.data?.message || 'Instrument refresh failed');
    } finally {
      setBusy(null);
    }
  };

  const connected = !!status?.connected;
  const feed = status?.feed;
  const instruments = status?.instruments;

  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="font-semibold">Zerodha Connection</h2>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                connected ? 'bg-gain/10 text-gain' : 'bg-loss/10 text-loss'
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-gain' : 'bg-loss'}`} />
              {loading ? 'Checking…' : connected ? 'Connected' : 'Not connected'}
            </span>
          </div>

          <p className="mt-1 text-sm text-gray-500">
            {loading
              ? 'Reading session status…'
              : connected
                ? `Kite user ${status.kite_user_id || '—'} · token expires ${
                    status.expires_at ? new Date(status.expires_at).toLocaleString() : '—'
                  }`
                : status?.reason === 'expired'
                  ? 'Session expired. Zerodha requires an interactive login every trading day.'
                  : 'Not connected. Live data needs an admin to connect Zerodha.'}
          </p>

          {!loading && (
            <p className="mt-1 text-xs text-gray-600">
              Feed: {feed?.connected ? 'streaming' : 'down'}
              {feed?.needsReauth ? ' (re-auth required)' : ''}
              {feed?.subscribedCount != null ? ` · ${feed.subscribedCount} tokens` : ''}
              {' · '}Instruments: {instruments?.instrumentCount ?? 0}
              {instruments?.refreshing ? ' (refreshing…)' : ''}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button onClick={connect} disabled={!!busy} className="btn-primary disabled:opacity-50">
            {busy === 'connect' ? 'Waiting for Kite…' : connected ? 'Reconnect' : 'Connect Zerodha'}
          </button>
          <button
            onClick={refreshInstruments}
            disabled={!!busy || !connected}
            title={!connected ? 'Connect Zerodha first' : 'Re-download the instrument master'}
            className="rounded-lg border border-vega-border px-3 py-1.5 text-sm text-gray-300 hover:bg-white/5 disabled:opacity-40"
          >
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh Instruments'}
          </button>
          <button
            onClick={disconnect}
            disabled={!!busy || !connected}
            className="rounded-lg border border-loss/40 px-3 py-1.5 text-sm text-loss hover:bg-loss/10 disabled:opacity-40"
          >
            {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      </div>

      {notice && <p className="rounded-lg bg-gain/10 px-3 py-2 text-xs text-gain">{notice}</p>}
      {error && <p className="rounded-lg bg-loss/10 px-3 py-2 text-xs text-loss">{error}</p>}

      {/*
        A mismatch between this value and the Redirect URL registered on
        developers.kite.trade makes Kite redirect without a request_token, which
        surfaces as a confusing "did not send a request_token" error. Showing it
        here makes the mismatch obvious — it matters especially with Cloudflare
        quick-tunnels, whose hostname changes on every restart.
      */}
      {status?.redirectUrl && (
        <div className="rounded-lg border border-vega-border bg-slate-50 p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Redirect URL — must match your Kite app exactly
            </p>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(status.redirectUrl);
                setNotice('Redirect URL copied.');
              }}
              className="rounded border border-vega-border bg-white px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100"
            >
              Copy
            </button>
          </div>
          <code className="block break-all text-[11px] text-slate-700">{status.redirectUrl}</code>
          <p className="mt-1.5 text-[11px] text-slate-400">
            Paste this into the “Redirect URL” field at developers.kite.trade. Cloudflare
            quick-tunnel hostnames change on every restart — update both places when it does.
          </p>
        </div>
      )}
    </div>
  );
}

const STATUS_FILTERS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Active' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'rejected', label: 'Rejected' },
  { key: '', label: 'All' },
];

const STATUS_STYLE = {
  pending: 'bg-vega-amber/10 text-vega-amber',
  approved: 'bg-vega-green/10 text-vega-green',
  blocked: 'bg-vega-red/10 text-vega-red',
  rejected: 'bg-slate-200 text-slate-600',
};

// Display labels for users.broker. Accounts created before the column existed
// have NULL and render as an em dash rather than a guessed broker name.
const BROKER_LABEL = {
  zerodha: 'Zerodha',
  angelone: 'Angel One',
  dhan: 'Dhan',
  upstox: 'Upstox',
  groww: 'Groww',
};

function UserManagement() {
  const [users, setUsers] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('pending');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async (status) => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/users', { params: status ? { status } : {} });
      setUsers(data.users || []);
      setCounts(data.counts || {});
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(filter); }, [load, filter]);

  const act = async (id, status) => {
    setBusyId(id);
    setError(null);
    try {
      await api.patch(`/admin/users/${id}/approval`, { status });
      await load(filter);
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  /**
   * is_active is a SEPARATE axis from approval status.
   *   status    — has the admin approved this signup? (login gate)
   *   is_active — is the account switched on? (login gate too, checked first)
   * Deactivating suspends an already-approved user without losing their
   * approval. This control was dropped when the users table was rebuilt; the
   * endpoint always existed.
   */
  const toggleActive = async (id, isActive) => {
    setBusyId(id);
    setError(null);
    try {
      await api.patch(`/admin/users/${id}/status`, { is_active: !isActive });
      await load(filter);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not change account state');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id, email) => {
    // Deletion is irreversible and cascades to that user's history, so it is
    // confirmed explicitly rather than fired straight from the row button.
    if (!window.confirm(`Permanently delete ${email}? This cannot be undone.`)) return;
    setBusyId(id);
    setError(null);
    try {
      await api.delete(`/admin/users/${id}`);
      await load(filter);
    } catch (err) {
      setError(err.response?.data?.message || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="glass-card p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-slate-900">User Management</h2>
        <div className="ml-auto flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setFilter(f.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-vega-blue text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.label}
              {f.key && counts[f.key] != null && (
                <span className={`ml-1.5 ${filter === f.key ? 'text-white/75' : 'text-slate-400'}`}>
                  {counts[f.key]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="mb-3 rounded-lg bg-vega-red/10 px-3 py-2 text-sm text-vega-red">{error}</p>}

      {loading ? (
        <p className="py-6 text-center text-sm text-slate-400">Loading users…</p>
      ) : users.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          No {filter ? STATUS_FILTERS.find((f) => f.key === filter)?.label.toLowerCase() : ''} users.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm">
            <thead>
              <tr className="border-b border-vega-border text-left text-slate-500">
                <th className="py-2 font-medium">Name</th>
                <th className="py-2 font-medium">Email</th>
                <th className="py-2 font-medium">Mobile</th>
                <th className="py-2 font-medium">Broker</th>
                <th className="py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium">Account</th>
                <th className="py-2 font-medium">Registered</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-vega-border/60 hover:bg-slate-50">
                  <td className="py-2.5 font-medium text-slate-800">{u.name}</td>
                  <td className="py-2.5 text-slate-500">{u.email}</td>
                  <td className="num py-2.5 text-slate-500">{u.phone || '—'}</td>
                  <td className="py-2.5 text-slate-500">{BROKER_LABEL[u.broker] || '—'}</td>
                  <td className="py-2.5 capitalize text-slate-500">{u.role}</td>
                  <td className="py-2.5">
                    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${STATUS_STYLE[u.status] || ''}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="py-2.5">
                    <span className={`text-[11px] font-medium ${u.is_active ? 'text-vega-green' : 'text-slate-400'}`}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="py-2.5 text-xs text-slate-400">
                    {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-2.5 text-right">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {u.status !== 'approved' && (
                        <Action onClick={() => act(u.id, 'approved')} disabled={busyId === u.id} tone="green">
                          {u.status === 'blocked' ? 'Unblock' : 'Approve'}
                        </Action>
                      )}
                      {u.status === 'pending' && (
                        <Action onClick={() => act(u.id, 'rejected')} disabled={busyId === u.id} tone="grey">
                          Reject
                        </Action>
                      )}
                      {u.status === 'approved' && u.role !== 'admin' && (
                        <Action onClick={() => act(u.id, 'blocked')} disabled={busyId === u.id} tone="red">
                          Block
                        </Action>
                      )}
                      {u.role !== 'admin' && (
                        <Action
                          onClick={() => toggleActive(u.id, u.is_active)}
                          disabled={busyId === u.id}
                          tone={u.is_active ? 'grey' : 'green'}
                        >
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </Action>
                      )}
                      {u.role !== 'admin' && (
                        <Action onClick={() => remove(u.id, u.email)} disabled={busyId === u.id} tone="red">
                          Delete
                        </Action>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Action({ onClick, disabled, tone, children }) {
  const tones = {
    green: 'border-vega-green/40 text-vega-green hover:bg-vega-green/10',
    red: 'border-vega-red/40 text-vega-red hover:bg-vega-red/10',
    grey: 'border-vega-border text-slate-500 hover:bg-slate-100',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

/* =========================================================================
 * SYSTEM STATUS — the "is the platform actually working right now?" panel.
 * Reads GET /api/admin/system-status, which aggregates the Zerodha session,
 * market feed, WebSocket, instrument master, Vega recorder and stored rows in
 * one request so polling stays cheap.
 * ======================================================================= */

const REFRESH_MS = 10_000;

function Dot({ ok, warn }) {
  const c = ok ? 'bg-vega-green' : warn ? 'bg-vega-amber' : 'bg-vega-red';
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${c}`} />;
}

function StatusCard({ title, ok, warn, headline, rows }) {
  return (
    <div className="rounded-xl border border-vega-border bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <Dot ok={ok} warn={warn} />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      </div>
      <p className={`text-sm font-semibold ${ok ? 'text-vega-green' : warn ? 'text-vega-amber' : 'text-vega-red'}`}>
        {headline}
      </p>
      <dl className="mt-2.5 space-y-1">
        {rows.filter(Boolean).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 text-[11px]">
            <dt className="text-slate-400">{k}</dt>
            <dd className="num truncate text-slate-600">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function SystemStatusPanel() {
  const [s, setS] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/system-status');
      setS(data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not read system status');
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  if (error) {
    return <div className="glass-card p-4 text-sm text-vega-red">{error}</div>;
  }
  if (!s) {
    return <div className="glass-card p-4 text-sm text-slate-400">Reading system status…</div>;
  }

  const { zerodha, feed, websocket, instruments, vegaRecorder, recording } = s;
  const standing = websocket?.standing?.['vega-sampler'] ?? 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-slate-900">System Status</h2>
        <span className="text-[11px] text-slate-400">
          auto-refreshes every {REFRESH_MS / 1000}s
        </span>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <StatusCard
          title="Zerodha Session"
          ok={zerodha?.connected}
          headline={zerodha?.connected ? 'Connected' : zerodha?.reason === 'expired' ? 'Expired' : 'Not connected'}
          rows={[
            ['Kite user', zerodha?.kiteUserId || '—'],
            ['Expires', zerodha?.expiresAt ? new Date(zerodha.expiresAt).toLocaleString() : '—'],
            ['Verified', zerodha?.lastVerifiedAt ? new Date(zerodha.lastVerifiedAt).toLocaleTimeString() : '—'],
          ]}
        />

        <StatusCard
          title="Market Feed"
          ok={feed?.connected}
          warn={feed?.needsReauth}
          headline={feed?.connected ? 'Streaming' : feed?.needsReauth ? 'Re-auth required' : 'Down'}
          rows={[
            ['Subscribed tokens', feed?.subscribedCount ?? 0],
            ['Reconnects', feed?.reconnectAttempts ?? 0],
            ['Last connected', feed?.lastConnectedAt ? new Date(feed.lastConnectedAt).toLocaleTimeString() : '—'],
            feed?.lastError && ['Last error', String(feed.lastError).slice(0, 40)],
          ]}
        />

        <StatusCard
          title="WebSocket"
          ok={websocket?.running}
          headline={websocket?.running ? `Listening · ${websocket.clients} client${websocket.clients === 1 ? '' : 's'}` : 'Not running'}
          rows={[
            ['Browser clients', websocket?.clients ?? 0],
            ['Distinct tokens', websocket?.distinctTokens ?? 0],
            ['From clients', websocket?.clientTokens ?? 0],
            ['Strike window', websocket?.strikeWindow ?? '—'],
          ]}
        />

        <StatusCard
          title="Instrument Master"
          ok={instruments?.ready}
          warn={instruments?.refreshing}
          headline={
            instruments?.refreshing ? 'Refreshing…'
              : instruments?.ready ? `${instruments.instrumentCount.toLocaleString()} contracts`
                : 'Not loaded'
          }
          rows={[
            ['Underlyings', instruments?.underlyingCount ?? 0],
            ['Last refresh', instruments?.lastRefreshAt ? new Date(instruments.lastRefreshAt).toLocaleTimeString() : '—'],
            instruments?.lastRefreshError && ['Error', String(instruments.lastRefreshError).slice(0, 40)],
          ]}
        />

        <StatusCard
          title="Vega Recorder"
          ok={vegaRecorder?.sampling && standing > 0}
          warn={vegaRecorder?.sampling && standing === 0}
          headline={
            !vegaRecorder?.sampling ? 'Not scheduled'
              : standing === 0 ? 'Scheduled · no tokens subscribed'
                : vegaRecorder.window ? 'Recording' : 'Scheduled · market closed'
          }
          rows={[
            ['In market window', vegaRecorder?.window ? 'yes' : 'no'],
            ['Instruments ready', vegaRecorder?.instrumentsReady ? 'yes' : 'no'],
            ['Standing tokens', standing],
            ['Delta band', `${vegaRecorder?.deltaMax != null ? `≤ ${vegaRecorder.deltaMax}` : '—'} · ${vegaRecorder?.strikeMode ?? ''}`],
          ]}
        />

        <StatusCard
          title="Historical Recording"
          ok={recording?.rowsToday > 0}
          warn={recording?.totalRows > 0 && !recording?.rowsToday}
          headline={
            recording?.rowsToday
              ? `${recording.rowsToday.toLocaleString()} rows today`
              : recording?.totalRows
                ? 'Nothing recorded today'
                : 'No data recorded yet'
          }
          rows={[
            ['Trading date', recording?.tradingDate ?? '—'],
            ['Symbols today', `${recording?.symbolsToday ?? 0} · ${recording?.baselinesToday ?? 0} baselines`],
            ['Total stored', `${(recording?.totalRows ?? 0).toLocaleString()} rows / ${recording?.totalDays ?? 0} days`],
            ['Range', recording?.firstDay ? `${String(recording.firstDay).slice(0, 10)} → ${String(recording.lastDay).slice(0, 10)}` : '—'],
          ]}
        />
      </div>
    </div>
  );
}

function OverviewTab() {
  return (
    <div className="space-y-6">
      <ZerodhaPanel />
      <SystemStatusPanel />
      <UserManagement />
    </div>
  );
}

export default function AdminDashboard() {
  const [tab, setTab] = useState('Overview');

  return (
    <div className="animate-fade-in space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Admin Console</h1>
        <p className="text-sm text-slate-500">
          User approvals, Zerodha connection and live platform health.
        </p>
      </div>

      <div className="flex flex-wrap gap-2 border-b border-vega-border pb-2">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors ${
              tab === t
                ? 'bg-vega-blue text-white'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Overview' && <OverviewTab />}
      {tab === 'Onboarding' && <OnboardingPanel />}
      {tab === 'Data Management' && <DataManagementPanel />}
      {tab === 'Purge & Backup' && <PurgeBackupPanel />}
      {tab === 'Audit Log' && <AuditLogPanel />}
      {tab === 'User Activity' && <UserActivityPanel />}
    </div>
  );
}
