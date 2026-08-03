export function formatPrice(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatChange(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}`;
}

export function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatVolume(value) {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString('en-IN');
}

export function formatTimestamp(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function changeDirection(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return 'flat';
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}
