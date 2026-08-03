import { useCallback, useEffect, useState } from 'react';
import api from '../../api/axios';
import { downloadBlob, formatDateTime } from '../../utils/download';

const PURGE_TABLES = [
  { value: 'vega_timeseries', label: 'Vega Timeseries (per-minute samples)' },
  { value: 'vega_chain_snapshots', label: 'Vega Chain Snapshots (raw chain archive)' },
  { value: 'login_history', label: 'Login History' },
];

function formatBytes(bytes) {
  if (bytes == null) return '–';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function PurgeSection() {
  const [table, setTable] = useState(PURGE_TABLES[0].value);
  const [olderThanDays, setOlderThanDays] = useState(90);
  const [preview, setPreview] = useState(null); // { matchingRows } once previewed for the current table/days
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { data } = await api.post('/admin/data/purge', { table, olderThanDays, confirm: false });
      setPreview({ table, olderThanDays, matchingRows: data.matchingRows });
    } catch (err) {
      setError(err.response?.data?.message || 'Preview failed');
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    if (!preview || preview.table !== table || preview.olderThanDays !== olderThanDays) return;
    if (!window.confirm(
      `Permanently delete ${preview.matchingRows} row(s) from ${table} older than ${olderThanDays} day(s)? This cannot be undone.`
    )) return;

    setBusy(true);
    setError(null);
    try {
      const { data } = await api.post('/admin/data/purge', { table, olderThanDays, confirm: true });
      setResult(data);
      setPreview(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Purge failed');
    } finally {
      setBusy(false);
    }
  };

  const previewStale = !preview || preview.table !== table || preview.olderThanDays !== olderThanDays;

  return (
    <div className="glass-card space-y-3 p-4">
      <h3 className="font-semibold text-slate-900">Purge Old Data</h3>
      <p className="text-xs text-gray-500">
        Deletes rows older than the chosen window. Always preview the count first — nothing is deleted until you confirm.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Table</p>
          <select
            value={table}
            onChange={(e) => { setTable(e.target.value); setPreview(null); setResult(null); }}
            className="rounded-lg border border-vega-border bg-vega-panel px-2.5 py-1.5 text-xs text-gray-200"
          >
            {PURGE_TABLES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wider text-gray-500">Older than (days)</p>
          <input
            type="number" min={1} value={olderThanDays}
            onChange={(e) => { setOlderThanDays(Number(e.target.value)); setPreview(null); setResult(null); }}
            className="w-24 rounded-lg border border-vega-border bg-vega-panel px-2.5 py-1.5 text-xs text-gray-200"
          />
        </div>
        <button onClick={runPreview} disabled={busy} className="btn-primary text-xs disabled:opacity-50">
          Preview Count
        </button>
        <button
          onClick={runDelete}
          disabled={busy || previewStale}
          className="rounded-lg bg-vega-red/90 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-vega-red disabled:opacity-30"
        >
          Delete Now
        </button>
      </div>

      {error && <p className="text-xs text-vega-red">{error}</p>}
      {preview && !previewStale && (
        <p className="text-xs text-gray-400">
          <span className="font-semibold text-gray-200">{preview.matchingRows}</span> row(s) match — click Delete Now to permanently remove them.
        </p>
      )}
      {result && (
        <p className="text-xs text-vega-green">Deleted {result.affectedRows} row(s) from {result.table}.</p>
      )}
    </div>
  );
}

function BackupSection() {
  const [backups, setBackups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [downloading, setDownloading] = useState(null);
  const [error, setError] = useState(null);

  const loadBackups = useCallback(async () => {
    try {
      const { data } = await api.get('/admin/data/backups');
      setBackups(data.backups);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to list backups');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadBackups(); }, [loadBackups]);

  const createBackup = async () => {
    setCreating(true);
    setError(null);
    try {
      await api.post('/admin/data/backup');
      await loadBackups();
    } catch (err) {
      setError(err.response?.data?.message || 'Backup failed');
    } finally {
      setCreating(false);
    }
  };

  const download = async (filename) => {
    setDownloading(filename);
    try {
      const { data } = await api.get(`/admin/data/backups/${filename}/download`, { responseType: 'blob' });
      downloadBlob(data, filename);
    } catch (err) {
      setError(err.response?.data?.message || 'Download failed');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="glass-card space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-slate-900">Database Backup</h3>
        <button onClick={createBackup} disabled={creating} className="btn-primary text-xs disabled:opacity-50">
          {creating ? 'Creating…' : 'Create Backup Now'}
        </button>
      </div>
      <p className="text-xs text-gray-500">
        Runs <code>mysqldump</code> on the server and stores the result under <code>server/backups/</code>.
        Requires <code>MYSQLDUMP_PATH</code> to be set in <code>server/.env</code> if mysqldump isn't on the server's PATH.
      </p>

      {error && <p className="text-xs text-vega-red">{error}</p>}
      {loading ? (
        <p className="text-xs text-gray-500">Loading backups…</p>
      ) : backups.length === 0 ? (
        <p className="text-xs text-gray-500">No backups yet.</p>
      ) : (
        <div className="scroll-thin max-h-64 overflow-auto rounded-lg border border-vega-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-vega-panel">
              <tr className="border-b border-vega-border text-gray-500">
                <th className="px-3 py-2 text-left font-medium uppercase tracking-wide">File</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-wide">Size</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-wide">Created</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-wide">Action</th>
              </tr>
            </thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.filename} className="border-b border-vega-border/50">
                  <td className="px-3 py-1.5 text-gray-300">{b.filename}</td>
                  <td className="num px-3 py-1.5 text-right text-gray-400">{formatBytes(b.size)}</td>
                  <td className="num px-3 py-1.5 text-right text-gray-400">{formatDateTime(b.createdAt)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <button
                      onClick={() => download(b.filename)}
                      disabled={downloading === b.filename}
                      className="text-vega-blue-light hover:underline disabled:opacity-50"
                    >
                      {downloading === b.filename ? 'Downloading…' : 'Download'}
                    </button>
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

export default function PurgeBackupPanel() {
  return (
    <div className="space-y-4">
      <PurgeSection />
      <BackupSection />
    </div>
  );
}
