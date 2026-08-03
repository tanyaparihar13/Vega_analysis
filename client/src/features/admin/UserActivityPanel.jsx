import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';
import { formatDateTime } from '../../utils/download';

const PAGE_SIZE = 50;

export default function UserActivityPanel() {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/login-history', {
        params: { dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, page, pageSize: PAGE_SIZE },
      });
      setRows(data.history);
      setTotal(data.total ?? data.history.length);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load user activity');
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <div className="space-y-3">
      <div className="glass-card flex flex-wrap items-end gap-3 p-4">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">From</p>
          <input
            type="date" value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
            className="rounded-lg border border-vega-border bg-vega-panel px-2.5 py-1.5 text-xs text-gray-200 [color-scheme:dark]"
          />
        </div>
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">To</p>
          <input
            type="date" value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
            className="rounded-lg border border-vega-border bg-vega-panel px-2.5 py-1.5 text-xs text-gray-200 [color-scheme:dark]"
          />
        </div>
      </div>

      <div className="glass-card p-2">
        {error && <div className="p-4 text-sm text-vega-red">{error}</div>}
        {!error && loading && <div className="p-10 text-center text-sm text-gray-500">Loading…</div>}
        {!error && !loading && rows.length === 0 && (
          <div className="p-10 text-center text-sm text-gray-500">No login activity in this range.</div>
        )}
        {!error && !loading && rows.length > 0 && (
          <>
            <div className="scroll-thin max-h-[55vh] overflow-auto rounded-lg border border-vega-border">
              <table className="w-full table-fixed border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-vega-panel">
                  <tr className="border-b border-vega-border">
                    {['Time', 'User', 'IP Address', 'Result'].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className="border-b border-vega-border/50 hover:bg-white/[0.03]">
                      <td className="px-3 py-1.5 text-gray-400">{formatDateTime(r.login_at)}</td>
                      <td className="px-3 py-1.5 text-gray-300">{r.name}<span className="ml-1 text-gray-600">({r.email})</span></td>
                      <td className="px-3 py-1.5 text-gray-500">{r.ip_address || '–'}</td>
                      <td className="px-3 py-1.5">
                        <span className={r.success ? 'text-vega-green' : 'text-vega-red'}>
                          {r.success ? 'Success' : 'Failed'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-2 py-2 text-xs text-gray-500">
              <span>{total} entr{total === 1 ? 'y' : 'ies'} total</span>
              <div className="flex items-center gap-2">
                <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded px-2 py-1 disabled:opacity-30 hover:bg-white/5">← Prev</button>
                <span>Page {page} / {totalPages}</span>
                <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)} className="rounded px-2 py-1 disabled:opacity-30 hover:bg-white/5">Next →</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
