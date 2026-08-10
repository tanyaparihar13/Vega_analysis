import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';

/**
 * The registration funnel, as the admin works it.
 *
 * Reads GET /api/admin/onboarding and drives every state change through the
 * single PATCH /api/admin/onboarding/:userId { action } endpoint — see
 * server/src/controllers/onboardingController.js, where the whitelist of
 * actions and their SQL live.
 *
 * ONE IMPORTANT DISTINCTION, made visible in the UI: marking a payment received
 * or a broker account complete does NOT grant access. Only "Activate" sets
 * users.status='approved'. Conflating the two would approve accounts as a side
 * effect of bookkeeping, so the activate button is styled and placed apart from
 * the rest.
 */

const OPTION_LABEL = {
  lifetime: 'Lifetime ₹4,999',
  dhan: 'Dhan',
  angel_one: 'Angel One',
};

const OPTION_STYLE = {
  lifetime: 'bg-vega-amber/10 text-vega-amber',
  dhan: 'bg-vega-green/10 text-vega-green',
  angel_one: 'bg-vega-blue/10 text-vega-blue',
};

const PILL = {
  // payment_status / broker_status / whatsapp_status share this ramp
  none: 'bg-slate-100 text-slate-500',
  not_sent: 'bg-slate-100 text-slate-500',
  pending: 'bg-vega-amber/10 text-vega-amber',
  opened: 'bg-vega-blue/10 text-vega-blue',
  received: 'bg-vega-green/10 text-vega-green',
  completed: 'bg-vega-green/10 text-vega-green',
  confirmed: 'bg-vega-green/10 text-vega-green',
};

const FILTERS = [
  { key: 'needsAction', label: 'Needs action', params: { pending: '1' } },
  { key: 'lifetime', label: 'Lifetime', params: { option: 'lifetime' } },
  { key: 'dhan', label: 'Dhan', params: { option: 'dhan' } },
  { key: 'angel_one', label: 'Angel One', params: { option: 'angel_one' } },
  { key: 'paymentPending', label: 'Payment pending', params: { payment: 'pending' } },
  { key: 'all', label: 'All', params: {} },
];

const fmtDate = (v) => (v ? new Date(v).toLocaleString('en-IN', {
  day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}) : '—');

function Pill({ value }) {
  if (!value) return <span className="text-slate-400">—</span>;
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${PILL[value] || PILL.none}`}>
      {String(value).replace('_', ' ')}
    </span>
  );
}

function Action({ onClick, disabled, tone = 'grey', children, title }) {
  const tones = {
    green: 'border-vega-green/40 text-vega-green hover:bg-vega-green/10',
    blue: 'border-vega-blue/40 text-vega-blue hover:bg-vega-blue/10',
    grey: 'border-vega-border text-slate-500 hover:bg-slate-100',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${tones[tone]}`}
    >
      {children}
    </button>
  );
}

export default function OnboardingPanel() {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({});
  const [filter, setFilter] = useState('needsAction');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async (key) => {
    setLoading(true);
    try {
      const params = FILTERS.find((f) => f.key === key)?.params ?? {};
      const { data } = await api.get('/admin/onboarding', { params });
      setRows(data.onboarding || []);
      setCounts(data.counts || {});
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the onboarding queue');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(filter); }, [load, filter]);

  const act = async (userId, action, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusyId(userId);
    setError(null);
    try {
      const { data } = await api.patch(`/admin/onboarding/${userId}`, { action });
      setNotice(data.message);
      await load(filter);
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="glass-card p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div>
          <h2 className="font-semibold text-slate-900">Onboarding</h2>
          <p className="text-xs text-slate-500">
            What each registration asked for, and where it is in the workflow.
          </p>
        </div>

        <div className="ml-auto flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                filter === f.key
                  ? 'bg-vega-blue text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {f.label}
              {counts[f.key] != null && (
                <span className={`ml-1.5 ${filter === f.key ? 'text-white/75' : 'text-slate-400'}`}>
                  {counts[f.key]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {notice && <p className="mb-3 rounded-lg bg-vega-green/10 px-3 py-2 text-xs text-vega-green">{notice}</p>}
      {error && <p className="mb-3 rounded-lg bg-vega-red/10 px-3 py-2 text-sm text-vega-red">{error}</p>}

      {loading ? (
        <p className="py-6 text-center text-sm text-slate-400">Loading onboarding queue…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-slate-400">
          Nothing in this view.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-sm">
            <thead>
              <tr className="border-b border-vega-border text-left text-slate-500">
                <th className="py-2 font-medium">User</th>
                <th className="py-2 font-medium">Source</th>
                <th className="py-2 font-medium">Selected</th>
                <th className="py-2 font-medium">WhatsApp</th>
                <th className="py-2 font-medium">Payment</th>
                <th className="py-2 font-medium">Broker</th>
                <th className="py-2 font-medium">Account</th>
                <th className="py-2 font-medium">Registered</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const busy = busyId === r.user_id;
                const activated = !!r.activated_at;
                return (
                  <tr key={r.user_id} className="border-b border-vega-border/60 align-top hover:bg-slate-50">
                    <td className="py-2.5">
                      <div className="font-medium text-slate-800">{r.name}</div>
                      <div className="text-xs text-slate-500">{r.email}</div>
                      <div className="num text-xs text-slate-500">{r.phone || '—'}</div>
                      <div className="text-[11px] text-slate-400">ID {r.user_id}</div>
                    </td>
                    <td className="py-2.5 text-xs capitalize text-slate-500">{r.registration_source}</td>
                    <td className="py-2.5">
                      {r.selected_option ? (
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OPTION_STYLE[r.selected_option] || ''}`}>
                          {OPTION_LABEL[r.selected_option] || r.selected_option}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">not chosen</span>
                      )}
                      {r.selected_at && (
                        <div className="mt-1 text-[11px] text-slate-400">{fmtDate(r.selected_at)}</div>
                      )}
                    </td>
                    <td className="py-2.5"><Pill value={r.whatsapp_status} /></td>
                    <td className="py-2.5"><Pill value={r.payment_status} /></td>
                    <td className="py-2.5"><Pill value={r.broker_status} /></td>
                    <td className="py-2.5">
                      <span className={`text-[11px] font-medium capitalize ${
                        r.user_status === 'approved' ? 'text-vega-green' : 'text-slate-500'
                      }`}
                      >
                        {r.user_status}
                      </span>
                      {r.contacted_at && (
                        <div className="text-[11px] text-slate-400">contacted</div>
                      )}
                    </td>
                    <td className="py-2.5 text-xs text-slate-400">{fmtDate(r.registered_at)}</td>
                    <td className="py-2.5 text-right">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        {!r.contacted_at && (
                          <Action onClick={() => act(r.user_id, 'contacted')} disabled={busy}>
                            Contacted
                          </Action>
                        )}
                        {r.selected_option === 'lifetime' && r.payment_status !== 'received' && (
                          <Action onClick={() => act(r.user_id, 'payment_received')} disabled={busy} tone="green">
                            Payment received
                          </Action>
                        )}
                        {r.selected_option === 'dhan' && r.broker_status !== 'completed' && (
                          <Action onClick={() => act(r.user_id, 'dhan_completed')} disabled={busy} tone="green">
                            Dhan done
                          </Action>
                        )}
                        {r.selected_option === 'angel_one' && r.broker_status !== 'completed' && (
                          <Action onClick={() => act(r.user_id, 'angel_completed')} disabled={busy} tone="green">
                            Angel One done
                          </Action>
                        )}
                        {r.whatsapp_status !== 'confirmed' && (
                          <Action onClick={() => act(r.user_id, 'whatsapp_confirmed')} disabled={busy}>
                            WA received
                          </Action>
                        )}
                        {/* Set apart deliberately: this is the only action that
                            grants access. */}
                        {!activated && r.role !== 'admin' && (
                          <Action
                            onClick={() => act(
                              r.user_id, 'activate',
                              `Activate ${r.email}? This approves the account and lets them sign in.`
                            )}
                            disabled={busy}
                            tone="blue"
                            title="Approves the account — the user can sign in immediately"
                          >
                            Activate
                          </Action>
                        )}
                        {activated && (
                          <span className="rounded-md bg-vega-green/10 px-2.5 py-1 text-xs font-medium text-vega-green">
                            Activated
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
