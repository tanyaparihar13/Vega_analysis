import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';
import { downloadBlob, formatDateTime } from '../../utils/download';

const SYMBOLS = ['', 'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
const PAGE_SIZE = 50;

const fmt = (v) => (v == null ? '–' : Number(v).toFixed(2));

/**
 * Admin "Data Management" tab — browse stored vega_timeseries rows with
 * symbol/date filters, export the filtered range as CSV or Excel.
 */
export default function DataManagementPanel() {
  const [symbol, setSymbol] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/admin/data/vega-history', {
        params: { symbol: symbol || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined, page, pageSize: PAGE_SIZE },
      });
      setRows(data.rows);
      setTotal(data.total);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load vega history');
    } finally {
      setLoading(false);
    }
  }, [symbol, dateFrom, dateTo, page]);

  useEffect(() => { load(); }, [load]);

  const runExport = async (format) => {
    setExporting(format);
    try {
      const { data } = await api.get(`/admin/data/export/${format}`, {
        params: { symbol: symbol || undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined },
        responseType: 'blob',
      });
      const ext = format === 'excel' ? 'xlsx' : 'csv';
      downloadBlob(data, `vega-history-${Date.now()}.${ext}`);
    } catch (err) {
      setError(err.response?.data?.message || `Failed to export ${format}`);
    } finally {
      setExporting(null);
    }
  };

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <div className="space-y-4">
      <div className="glass-card flex flex-wrap items-end gap-3 p-4">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Symbol</p>
          <select
            value={symbol}
            onChange={(e) => { setSymbol(e.target.value); setPage(1); }}
            className="rounded-lg border border-vega-border bg-vega-panel px-2.5 py-1.5 text-xs text-gray-200"
          >
            {SYMBOLS.map((s) => <option key={s} value={s}>{s || 'All'}</option>)}
          </select>
        </div>
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
        <div className="ml-auto flex gap-2">
          <button onClick={() => runExport('csv')} disabled={exporting != null} className="btn-primary text-xs disabled:opacity-50">
            {exporting === 'csv' ? 'Exporting…' : 'Export CSV'}
          </button>
          <button onClick={() => runExport('excel')} disabled={exporting != null} className="btn-primary text-xs disabled:opacity-50">
            {exporting === 'excel' ? 'Exporting…' : 'Export Excel'}
          </button>
        </div>
      </div>

      <div className="glass-card p-2">
        {error && <div className="p-4 text-sm text-vega-red">{error}</div>}
        {!error && loading && <div className="p-10 text-center text-sm text-gray-500">Loading…</div>}
        {!error && !loading && rows.length === 0 && (
          <div className="p-10 text-center text-sm text-gray-500">No rows match these filters.</div>
        )}
        {!error && !loading && rows.length > 0 && (
          <>
            <div className="scroll-thin max-h-[55vh] overflow-auto rounded-lg border border-vega-border">
              <table className="w-full table-fixed border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-vega-panel">
                  <tr className="border-b border-vega-border">
                    {['Symbol', 'Date', 'Sampled At', 'Call Diff', 'Put Diff', 'Difference', 'Price'].map((h) => (
                      <th key={h} className="px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-gray-500 first:text-left">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.symbol}-${r.sampled_at}-${i}`} className="border-b border-vega-border/50 hover:bg-white/[0.03]">
                      <td className="px-3 py-1.5 text-left text-gray-300">{r.symbol}</td>
                      <td className="num px-3 py-1.5 text-right text-gray-400">{r.snapshot_date}</td>
                      <td className="num px-3 py-1.5 text-right text-gray-400">{formatDateTime(r.sampled_at)}</td>
                      <td className={`num px-3 py-1.5 text-right ${r.call_vega_diff >= 0 ? 'text-vega-green' : 'text-vega-red'}`}>{fmt(r.call_vega_diff)}</td>
                      <td className={`num px-3 py-1.5 text-right ${r.put_vega_diff >= 0 ? 'text-vega-green' : 'text-vega-red'}`}>{fmt(r.put_vega_diff)}</td>
                      <td className={`num px-3 py-1.5 text-right ${r.vega_diff >= 0 ? 'text-vega-green' : 'text-vega-red'}`}>{fmt(r.vega_diff)}</td>
                      <td className="num px-3 py-1.5 text-right text-gray-300">{fmt(r.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between px-2 py-2 text-xs text-gray-500">
              <span>{total} row{total === 1 ? '' : 's'} total</span>
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
