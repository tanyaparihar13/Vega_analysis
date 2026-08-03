import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';
import { formatDateTime } from '../../utils/download';

const PAGE_SIZE = 50;

export default function AuditLogPanel() {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/audit-log', { params: { page, pageSize: PAGE_SIZE } });
      setRows(data.rows);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <div className="glass-card p-2">
      {error && <div className="p-4 text-sm text-vega-red">{error}</div>}
      {!error && loading && <div className="p-10 text-center text-sm text-gray-500">Loading…</div>}
      {!error && !loading && rows.length === 0 && (
        <div className="p-10 text-center text-sm text-gray-500">No admin actions recorded yet.</div>
      )}
      {!error && !loading && rows.length > 0 && (
        <>
          <div className="scroll-thin max-h-[60vh] overflow-auto rounded-lg border border-vega-border">
            <table className="w-full table-fixed border-collapse text-xs">
              <thead className="sticky top-0 z-10 bg-vega-panel">
                <tr className="border-b border-vega-border">
                  {['Time', 'Admin', 'Action', 'Target', 'Details'].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-vega-border/50 hover:bg-white/[0.03]">
                    <td className="px-3 py-1.5 text-gray-400">{formatDateTime(r.created_at)}</td>
                    <td className="px-3 py-1.5 text-gray-300">{r.admin_name}<span className="ml-1 text-gray-600">({r.admin_email})</span></td>
                    <td className="px-3 py-1.5 text-vega-cyan">{r.action}</td>
                    <td className="px-3 py-1.5 text-gray-400">{r.target_type ? `${r.target_type}:${r.target_id}` : '–'}</td>
                    <td className="px-3 py-1.5 text-gray-500">
                      {r.details ? (typeof r.details === 'string' ? r.details : JSON.stringify(r.details)) : '–'}
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
  );
}
