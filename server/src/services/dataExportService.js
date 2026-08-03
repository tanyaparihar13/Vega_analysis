'use strict';

const ExcelJS = require('exceljs');
const db = require('../config/db');

const COLUMNS = [
  { key: 'symbol', header: 'Symbol' },
  { key: 'snapshot_date', header: 'Trading Date' },
  { key: 'sampled_at', header: 'Sampled At' },
  { key: 'expiry', header: 'Expiry' },
  { key: 'call_vega_diff', header: 'Call Vega Diff' },
  { key: 'put_vega_diff', header: 'Put Vega Diff' },
  { key: 'vega_diff', header: 'Difference' },
  { key: 'current_call_vega', header: 'Current Call Vega' },
  { key: 'current_put_vega', header: 'Current Put Vega' },
  { key: 'open_call_vega', header: 'Open Call Vega' },
  { key: 'open_put_vega', header: 'Open Put Vega' },
  { key: 'price', header: 'Price' },
  { key: 'call_strike_count', header: 'Call Strikes' },
  { key: 'put_strike_count', header: 'Put Strikes' },
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Filtered/paginated read of vega_timeseries. Reuses the existing
 * idx_vega_series (symbol, snapshot_date, sampled_at) index — no new index
 * needed. Used by both the admin table view and the CSV/Excel exporters.
 */
async function queryVegaHistory({ symbol, dateFrom, dateTo, page = 1, pageSize = 100 } = {}) {
  const where = [];
  const params = {};

  if (symbol) {
    where.push('symbol = :symbol');
    params.symbol = String(symbol).toUpperCase();
  }
  if (dateFrom && DATE_RE.test(dateFrom)) {
    where.push('snapshot_date >= :dateFrom');
    params.dateFrom = dateFrom;
  }
  if (dateTo && DATE_RE.test(dateTo)) {
    where.push('snapshot_date <= :dateTo');
    params.dateTo = dateTo;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [[{ total }]] = await db.query(
    `SELECT COUNT(*) AS total FROM vega_timeseries ${whereSql}`,
    params
  );

  const limit = Math.min(Math.max(Number(pageSize) || 100, 1), 5000);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

  const [rows] = await db.query(
    `SELECT symbol, snapshot_date, sampled_at, expiry,
            call_vega_diff, put_vega_diff, vega_diff,
            current_call_vega, current_put_vega,
            open_call_vega, open_put_vega,
            price, call_strike_count, put_strike_count
     FROM vega_timeseries ${whereSql}
     ORDER BY snapshot_date DESC, sampled_at DESC
     LIMIT :limit OFFSET :offset`,
    { ...params, limit, offset }
  );

  return { rows, total: Number(total), page: Number(page) || 1, pageSize: limit };
}

/** Every matching row, unpaginated — for export only (caller should bound the date range). */
async function queryAllVegaHistory({ symbol, dateFrom, dateTo } = {}) {
  const { rows } = await queryVegaHistory({ symbol, dateFrom, dateTo, page: 1, pageSize: 5000 });
  return rows;
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV(rows) {
  const header = COLUMNS.map((c) => csvEscape(c.header)).join(',');
  const lines = rows.map((row) => COLUMNS.map((c) => csvEscape(row[c.key])).join(','));
  return [header, ...lines].join('\r\n');
}

async function toExcelBuffer(rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Vega History');
  sheet.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: 18 }));
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(row));
  return workbook.xlsx.writeBuffer();
}

module.exports = { queryVegaHistory, queryAllVegaHistory, toCSV, toExcelBuffer, COLUMNS };
