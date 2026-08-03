/**
 * Triggers a browser download for an axios blob response.
 *
 * The JWT lives in localStorage and is attached via an axios request
 * interceptor (api/axios.js), so a plain `<a href="/api/...">` would not
 * carry auth — every export/download goes through axios with
 * `responseType: 'blob'`, then gets turned into an object URL and clicked via
 * a temporary anchor.
 */
export function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
}

export function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
