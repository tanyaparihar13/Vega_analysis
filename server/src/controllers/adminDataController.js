'use strict';

const db = require('../config/db');
const dataExportService = require('../services/dataExportService');
const dataRetentionService = require('../services/dataRetentionService');
const backupService = require('../services/backupService');
const auditLogService = require('../services/auditLogService');
const { isExpired } = require('../utils/kiteSessionTime');

/**
 * GET /api/admin/system-status
 *
 * One call that answers "is the platform actually working right now?" —
 * Zerodha session, market feed, WebSocket, instrument master, the Vega
 * recorder and what it has stored today.
 *
 * Aggregated server-side on purpose: the admin panel polls this on an
 * interval, and fanning out to five endpoints every few seconds would be five
 * times the requests for a view that is always read as a whole.
 *
 * Every section is individually guarded. A subsystem that has not started yet
 * (no ticker, no WebSocket server) must report itself as down, not 500 the
 * whole panel — which is the failure mode that makes a status page useless
 * exactly when you need it.
 */
async function systemStatus(req, res) {
  const out = {
    timestamp: new Date().toISOString(),
    zerodha: null,
    feed: null,
    websocket: null,
    instruments: null,
    vegaRecorder: null,
    recording: null,
  };

  // ---- Zerodha session ---------------------------------------------------
  try {
    const [rows] = await db.query(
      `SELECT kite_user_id, generated_at, expires_at, last_verified_at
         FROM zerodha_sessions
        WHERE is_active = 1
        ORDER BY generated_at DESC
        LIMIT 1`
    );
    const row = rows[0] || null;
    const expired = row ? isExpired(row.expires_at) : true;
    out.zerodha = {
      connected: !!row && !expired,
      reason: !row ? 'never_connected' : expired ? 'expired' : 'ok',
      kiteUserId: row?.kite_user_id ?? null,
      generatedAt: row?.generated_at ?? null,
      expiresAt: row?.expires_at ?? null,
      lastVerifiedAt: row?.last_verified_at ?? null,
      // Surfaced so a redirect-URL mismatch on developers.kite.trade is
      // visible in the UI instead of only in the boot log.
      redirectUrl: process.env.KITE_REDIRECT_URL || null,
    };
  } catch (err) {
    out.zerodha = { connected: false, error: err.message };
  }

  // ---- Market feed (KiteTicker) -----------------------------------------
  try {
    out.feed = require('../services/kiteTickerService').getTickerHealth();
  } catch (err) {
    out.feed = { connected: false, error: err.message };
  }

  // ---- WebSocket server + subscription reconciliation -------------------
  try {
    const wss = require('../services/websocketService').getWss();
    const subs = require('../services/subscriptionManager').getStats();
    out.websocket = {
      running: !!wss,
      clients: wss ? wss.clients.size : 0,
      ...subs, // clients, distinctTokens, clientTokens, standing, strikeWindow
    };
  } catch (err) {
    out.websocket = { running: false, error: err.message };
  }

  // ---- Instrument master -------------------------------------------------
  try {
    out.instruments = require('../services/instrumentService').getStats();
  } catch (err) {
    out.instruments = { ready: false, error: err.message };
  }

  // ---- Vega recorder -----------------------------------------------------
  try {
    out.vegaRecorder = require('../services/vegaTimeseriesService').getStats();
  } catch (err) {
    out.vegaRecorder = { sampling: false, error: err.message };
  }

  // ---- What has actually been recorded ----------------------------------
  try {
    // IST calendar date — the recorder keys rows by IST trading date, so
    // comparing against the MySQL server's own CURDATE() could be a day off.
    const todayIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const [[today]] = await db.query(
      `SELECT COUNT(*) AS rows_today, COUNT(DISTINCT symbol) AS symbols_today
         FROM vega_timeseries WHERE snapshot_date = :today`,
      { today: todayIst }
    );
    const [[totals]] = await db.query(
      `SELECT COUNT(*) AS total_rows, COUNT(DISTINCT snapshot_date) AS total_days,
              MIN(snapshot_date) AS first_day, MAX(snapshot_date) AS last_day
         FROM vega_timeseries`
    );
    const [[baselines]] = await db.query(
      'SELECT COUNT(*) AS baselines_today FROM vega_day_open WHERE snapshot_date = :today',
      { today: todayIst }
    );
    const [latest] = await db.query(
      `SELECT symbol, MAX(sampled_at) AS last_sample
         FROM vega_timeseries WHERE snapshot_date = :today GROUP BY symbol`,
      { today: todayIst }
    );

    out.recording = {
      tradingDate: todayIst,
      rowsToday: Number(today.rows_today || 0),
      symbolsToday: Number(today.symbols_today || 0),
      baselinesToday: Number(baselines.baselines_today || 0),
      totalRows: Number(totals.total_rows || 0),
      totalDays: Number(totals.total_days || 0),
      firstDay: totals.first_day ?? null,
      lastDay: totals.last_day ?? null,
      perSymbol: latest,
    };
  } catch (err) {
    out.recording = { error: err.message };
  }

  res.json(out);
}

// GET /api/admin/data/vega-history?symbol=&dateFrom=&dateTo=&page=&pageSize=
async function vegaHistory(req, res) {
  try {
    const { symbol, dateFrom, dateTo, page, pageSize } = req.query;
    const result = await dataExportService.queryVegaHistory({ symbol, dateFrom, dateTo, page, pageSize });
    res.json(result);
  } catch (err) {
    console.error('[admin/data/vega-history] error:', err.message);
    res.status(500).json({ message: 'Failed to load vega history' });
  }
}

// GET /api/admin/data/export/csv?symbol=&dateFrom=&dateTo=
async function exportCsv(req, res) {
  try {
    const { symbol, dateFrom, dateTo } = req.query;
    const rows = await dataExportService.queryAllVegaHistory({ symbol, dateFrom, dateTo });
    const csv = dataExportService.toCSV(rows);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="vega-history-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error('[admin/data/export/csv] error:', err.message);
    res.status(500).json({ message: 'Failed to export CSV' });
  }
}

// GET /api/admin/data/export/excel?symbol=&dateFrom=&dateTo=
async function exportExcel(req, res) {
  try {
    const { symbol, dateFrom, dateTo } = req.query;
    const rows = await dataExportService.queryAllVegaHistory({ symbol, dateFrom, dateTo });
    const buffer = await dataExportService.toExcelBuffer(rows);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="vega-history-${Date.now()}.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('[admin/data/export/excel] error:', err.message);
    res.status(500).json({ message: 'Failed to export Excel' });
  }
}

// POST /api/admin/data/purge  { table, olderThanDays, confirm }
// Without confirm:true this ONLY returns the dry-run count — nothing is deleted.
async function purgeData(req, res) {
  try {
    const { table, olderThanDays, confirm } = req.body;
    if (!table || olderThanDays == null) {
      return res.status(400).json({ message: 'table and olderThanDays are required' });
    }
    if (!(table in dataRetentionService.PURGE_TARGETS)) {
      return res.status(400).json({
        message: `Unsupported table: ${table}`,
        allowed: Object.keys(dataRetentionService.PURGE_TARGETS),
      });
    }

    const count = await dataRetentionService.countPurgeCandidates({ table, olderThanDays });

    if (!confirm) {
      return res.json({ dryRun: true, table, olderThanDays, matchingRows: count });
    }

    const affectedRows = await dataRetentionService.purge({ table, olderThanDays });
    await auditLogService.record({
      adminUserId: req.user.id,
      action: 'data.purge',
      targetType: 'table',
      targetId: table,
      details: { olderThanDays, affectedRows },
      ip: req.ip,
    });

    res.json({ dryRun: false, table, olderThanDays, affectedRows });
  } catch (err) {
    console.error('[admin/data/purge] error:', err.message);
    res.status(500).json({ message: err.message || 'Purge failed' });
  }
}

// POST /api/admin/data/backup
async function createBackup(req, res) {
  try {
    const result = await backupService.createBackup();
    await auditLogService.record({
      adminUserId: req.user.id,
      action: 'data.backup',
      targetType: 'database',
      targetId: result.filename,
      details: { size: result.size },
      ip: req.ip,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[admin/data/backup] error:', err.message);
    res.status(500).json({ message: err.message || 'Backup failed' });
  }
}

// GET /api/admin/data/backups
async function listBackups(req, res) {
  try {
    res.json({ backups: backupService.listBackups() });
  } catch (err) {
    console.error('[admin/data/backups] error:', err.message);
    res.status(500).json({ message: 'Failed to list backups' });
  }
}

// GET /api/admin/data/backups/:filename/download
async function downloadBackup(req, res) {
  try {
    const fullPath = backupService.resolveBackupPath(req.params.filename);
    res.download(fullPath);
  } catch (err) {
    res.status(404).json({ message: err.message || 'Backup not found' });
  }
}

// GET /api/admin/audit-log?page=&pageSize=
async function auditLog(req, res) {
  try {
    const { page, pageSize } = req.query;
    const result = await auditLogService.list({ page, pageSize });
    res.json(result);
  } catch (err) {
    console.error('[admin/audit-log] error:', err.message);
    res.status(500).json({ message: 'Failed to load audit log' });
  }
}

module.exports = {
  systemStatus,
  vegaHistory,
  exportCsv,
  exportExcel,
  purgeData,
  createBackup,
  listBackups,
  downloadBackup,
  auditLog,
};
