'use strict';

const express = require('express');
const router = express.Router();
const { authenticate, requirePremium } = require('../middleware/auth');
const vegaTimeseriesService = require('../services/vegaTimeseriesService');
const instrumentService = require('../services/instrumentService');
const cfg = require('../config/vegaConfig');

/**
 * Resolve a path symbol to any tradable underlying — index OR F&O stock.
 *
 * Every route below used constants.getUnderlying, which knows five names, so a
 * stock symbol 404'd before it reached the engine. resolveSymbol checks the
 * curated indices first and falls back to the derived equity names from the
 * instrument master, so index behaviour is unchanged and stocks now resolve.
 */
const getUnderlying = (symbol) => vegaTimeseriesService.resolveSymbol(symbol);

/**
 * Vega Analysis time series (PHP addvega.php port).
 *
 * Same paths and auth as before, so nothing on the client breaks. Each point
 * now also carries the derived trend (Bullish/Bearish/Sideways) — datav1.php
 * rules — and the response advertises the active strike mode + delta band.
 *
 * EXPIRY-WISE: `?expiry=YYYY-MM-DD` selects which contract's series to read on
 * /series and /dates, and /expiries lists what is selectable. The parameter is
 * OPTIONAL everywhere — omitting it resolves to the nearest expiry available
 * for the requested day, which is exactly what these endpoints returned before
 * expiries existed, so every existing caller keeps working unchanged.
 *
 * Mounted in app.js as:  app.use('/api/vega', vegaRoutes);
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate an optional YYYY-MM-DD query parameter.
 * @returns {{ ok: true, value: string|null } | { ok: false, message: string }}
 */
function readDateParam(raw, label) {
  if (raw == null || raw === '') return { ok: true, value: null };
  const value = String(raw);
  if (!DATE_RE.test(value)) return { ok: false, message: `${label} must be YYYY-MM-DD` };
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    return { ok: false, message: `Not a real calendar date: ${value}` };
  }
  return { ok: true, value };
}

// GET /api/vega/:symbol/series?timeframe=1m|3m|5m|15m&date=YYYY-MM-DD&expiry=YYYY-MM-DD
router.get('/:symbol/series', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const timeframe = String(req.query.timeframe || '1m');
    if (!(timeframe in vegaTimeseriesService.TIMEFRAMES)) {
      return res.status(400).json({
        message: `Unsupported timeframe: ${timeframe}`,
        supported: Object.keys(vegaTimeseriesService.TIMEFRAMES),
      });
    }

    const dateParam = readDateParam(req.query.date, 'date');
    if (!dateParam.ok) return res.status(400).json({ message: dateParam.message });
    const date = dateParam.value;
    if (date && date > vegaTimeseriesService.todayIst()) {
      return res.status(400).json({ message: 'date cannot be in the future' });
    }

    const expiryParam = readDateParam(req.query.expiry, 'expiry');
    if (!expiryParam.ok) return res.status(400).json({ message: expiryParam.message });

    // Every request goes through loadByDate now, including the no-date case.
    // Previously the two branches produced subtly different payloads (no
    // baseline metadata on the live path), which is what made "today" and "a
    // stored day" render differently in the UI.
    const resolvedDate = date || vegaTimeseriesService.todayIst();

    // An unrecognised (or absent) expiry falls back to the nearest one that has
    // data for the day rather than 404-ing — a chart that quietly shows the
    // front month beats an error banner when an expiry rolls over mid-session.
    const { expiry, available } =
      await vegaTimeseriesService.resolveExpiry(cfgU.key, resolvedDate, expiryParam.value);

    const { points, dayOpen, live, hasBaseline, fromStore, resolution, storedResolutions, unavailable } =
      await vegaTimeseriesService.loadByDate(cfgU.key, resolvedDate, timeframe, expiry);

    const latest = points.length ? points[points.length - 1] : null;

    res.json({
      symbol: cfgU.key,
      label: cfgU.label || cfgU.key,
      isIndex: vegaTimeseriesService.isIndex(cfgU.key),
      timeframe,
      // What the rows were RECORDED at, plus everything this day could serve —
      // so the timeframe picker can grey out a tier instead of silently
      // returning an empty chart for a 15s view of 1m stock history.
      resolution,
      storedResolutions,
      supportedTimeframes: Object.keys(vegaTimeseriesService.TIMEFRAMES),
      servableTimeframes: storedResolutions?.length
        ? vegaTimeseriesService.servableTimeframes(storedResolutions)
        : Object.keys(vegaTimeseriesService.TIMEFRAMES),
      unavailable,
      date: resolvedDate,
      requestedDate: date,
      /**
       * ONE SELECTED TRADING DATE = ONE DATASET.
       *
       * loadByDate() proves every point below belongs to this session before it
       * returns, so the response states the day it describes rather than
       * leaving a consumer to infer it from the points (which may legitimately
       * be empty) or — the mistake this guards against — from the expiry.
       */
      tradingDate: resolvedDate,
      live,
      source: live && !fromStore ? 'memory' : 'database',
      strikeMode: cfg.STRIKE_MODE,                       // 'stable' | 'frozen' | 'dynamic'
      start: vegaTimeseriesService.startFor(cfgU.key),   // 0.05 (index) or 0.20 (stock)
      deltaMax: cfg.DELTA_MAX,
      // -1 => the points below are the negation of the stored PHP-signed values,
      // i.e. the StockMojo / Alpha Edge convention. Surfaced so a consumer can
      // tell which convention it received rather than having to assume one.
      displaySign: cfg.DISPLAY_SIGN,
      /**
       * B-08. 'series-inverted' means the three plotted series are the NEGATION
       * of the stored values while `trend` is derived from the stored
       * (un-negated) pair. The client uses this to explain why a rising Call
       * Vega line can sit next to a Bearish label.
       */
      trendConvention: cfg.DISPLAY_SIGN === -1 ? 'series-inverted' : 'series-raw',
      // Whether the requested expiry actually exists for this day. False means
      // `points` is legitimately empty — not an error, and not another expiry.
      expiryMatched: expiry ? available.some((e) => e.expiry === expiry) : null,
      hasBaseline,
      // The expiry these points belong to, plus what else was selectable for
      // this day — so the dropdown can stay populated from the same response
      // that filled the chart and can never disagree with it.
      expiry: expiry || (latest?.expiry ?? dayOpen?.expiry ?? null),
      requestedExpiry: expiryParam.value,
      expiries: available,
      dayOpen: dayOpen
        ? { callVega: dayOpen.callVega, putVega: dayOpen.putVega,
            callStrikes: dayOpen.callStrikes, putStrikes: dayOpen.putStrikes,
            capturedAt: dayOpen.capturedAt ? String(dayOpen.capturedAt) : null }
        : null,
      latestTrend: latest ? { label: latest.trend, key: latest.trendKey, color: latest.trendColor } : null,
      count: points.length,
      points,   // each point carries trend / trendKey / trendColor
    });
  } catch (err) {
    console.error('[vega/series] error:', err.message);
    res.status(500).json({ message: 'Failed to read the vega series' });
  }
});

/**
 * GET /api/vega/:symbol/export?timeframe=&date=&expiry=  ->  .xlsx (parity item 10)
 *
 * The data currently on screen, as a spreadsheet.
 *
 * IT READS THE EXACT SAME FUNCTION THE CHART DOES. `loadByDate` is what fills
 * the series endpoint, so the export inherits the timeframe bucketing, the
 * expiry resolution, the display sign convention and the trend label without
 * re-deriving any of them. A second query shaped "close enough" is how an export
 * ends up disagreeing with the table it was taken from — most obviously over the
 * sign, since the raw MySQL columns are stored in the engine's convention and
 * only decorate() turns them into what the user is looking at.
 *
 * Columns are exactly the ones asked for: Time, Instrument, Expiry, Strike,
 * Call Vega, Put Vega, Difference, Trend.
 *
 * Note this serves the STORED/aggregated series for the requested day. For today
 * that is the live buffer, i.e. the same array the open chart is drawing.
 */
const EXPORT_COLUMNS = [
  { header: 'Time', key: 'time', width: 12 },
  { header: 'Instrument', key: 'instrument', width: 14 },
  { header: 'Expiry', key: 'expiry', width: 13 },
  { header: 'Strike', key: 'strike', width: 12 },
  { header: 'Call Vega', key: 'call', width: 14 },
  { header: 'Put Vega', key: 'put', width: 14 },
  { header: 'Difference', key: 'diff', width: 14 },
  { header: 'Trend', key: 'trend', width: 18 },
];

/** UNIX seconds -> HH:MM:SS in IST. Seconds are always shown: a 5s export whose
 *  rows all read "09:15" would be indistinguishable garbage. */
const IST_CLOCK = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false, timeZone: 'Asia/Kolkata',
});

router.get('/:symbol/export', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const timeframe = String(req.query.timeframe || '1m');
    if (!(timeframe in vegaTimeseriesService.TIMEFRAMES)) {
      return res.status(400).json({
        message: `Unsupported timeframe: ${timeframe}`,
        supported: Object.keys(vegaTimeseriesService.TIMEFRAMES),
      });
    }

    const dateParam = readDateParam(req.query.date, 'date');
    if (!dateParam.ok) return res.status(400).json({ message: dateParam.message });
    if (dateParam.value && dateParam.value > vegaTimeseriesService.todayIst()) {
      return res.status(400).json({ message: 'date cannot be in the future' });
    }

    const expiryParam = readDateParam(req.query.expiry, 'expiry');
    if (!expiryParam.ok) return res.status(400).json({ message: expiryParam.message });

    const date = dateParam.value || vegaTimeseriesService.todayIst();
    const { expiry } = await vegaTimeseriesService.resolveExpiry(cfgU.key, date, expiryParam.value);
    const { points } = await vegaTimeseriesService.loadByDate(cfgU.key, date, timeframe, expiry);

    // Required lazily — exceljs is a heavy dependency and nothing else on this
    // router needs it, so it should not be loaded on a server that never exports.
    const ExcelJS = require('exceljs');
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Vega Analysis';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet(`${cfgU.key} ${timeframe}`.slice(0, 31));
    sheet.columns = EXPORT_COLUMNS;
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: 'frozen', ySplit: 1 }];

    for (const p of points) {
      sheet.addRow({
        time: IST_CLOCK.format(new Date(p.time * 1000)),
        instrument: cfgU.key,
        expiry: p.expiry || expiry || '',
        strike: p.atmStrike ?? '',
        call: p.callVegaDiff,
        put: p.putVegaDiff,
        diff: p.vegaDiff,
        trend: p.trend || '',
      });
    }

    for (const key of ['call', 'put', 'diff']) sheet.getColumn(key).numFmt = '0.00';

    // Which selection produced the file, so a downloaded sheet is still
    // self-describing a week later.
    const meta = sheet.addRow([]);
    meta.getCell(1).value = `Instrument ${cfgU.key} · Expiry ${expiry || '—'} · Timeframe ${timeframe} `
      + `· Date ${date} · ${points.length} rows · IST`;
    meta.font = { italic: true, size: 9 };

    const filename = `vega_${cfgU.key}_${expiry || 'all'}_${timeframe}_${date}.xlsx`;
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(await workbook.xlsx.writeBuffer()));
  } catch (err) {
    console.error('[vega/export] error:', err.message);
    res.status(500).json({ message: 'Failed to build the Excel export' });
  }
});

/**
 * GET /api/vega/:symbol/expiries?date=YYYY-MM-DD
 *
 * What the expiry dropdown offers for one trading day. For TODAY this is the
 * contracts the recorder is actively sampling (flagged `recording: true`) plus
 * anything already written; for a past day it is strictly what was recorded,
 * because an expired contract is no longer in the instrument master.
 */
router.get('/:symbol/expiries', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const dateParam = readDateParam(req.query.date, 'date');
    if (!dateParam.ok) return res.status(400).json({ message: dateParam.message });

    const today = vegaTimeseriesService.todayIst();
    const date = dateParam.value || today;
    if (date > today) return res.status(400).json({ message: 'date cannot be in the future' });

    const expiries = await vegaTimeseriesService.listExpiries(cfgU.key, date);

    res.json({
      symbol: cfgU.key,
      label: cfgU.label,
      date,
      today,
      // Nearest first, so [0] is the current expiry — the client's default.
      default: expiries.length ? expiries[0].expiry : null,
      count: expiries.length,
      expiries,
    });
  } catch (err) {
    console.error('[vega/expiries] error:', err.message);
    res.status(500).json({ message: 'Failed to list expiries' });
  }
});

// GET /api/vega/:symbol/dates?expiry=YYYY-MM-DD — which past days have stored
// data, for the picker. `expiry` narrows it to days that recorded THAT contract.
router.get('/:symbol/dates', authenticate, requirePremium, async (req, res) => {
  try {
    const cfgU = getUnderlying(req.params.symbol);
    if (!cfgU) return res.status(404).json({ message: `Unknown symbol: ${req.params.symbol}` });

    const expiryParam = readDateParam(req.query.expiry, 'expiry');
    if (!expiryParam.ok) return res.status(400).json({ message: expiryParam.message });

    const dates = await vegaTimeseriesService.listAvailableDates(cfgU.key, 120, expiryParam.value);
    // `today` is the server's IST date. The client anchors its picker to this
    // rather than to the browser clock, so a user in another timezone still
    // sees the correct trading day.
    res.json({
      symbol: cfgU.key,
      today: vegaTimeseriesService.todayIst(),
      expiry: expiryParam.value,
      count: dates.length,
      dates,
    });
  } catch (err) {
    console.error('[vega/dates] error:', err.message);
    res.status(500).json({ message: 'Failed to list available dates' });
  }
});

/**
 * GET /api/vega/instruments?q=&limit=
 *
 * The searchable instrument catalogue behind the selector: the five curated
 * indices, plus every F&O name the instrument master turned up that has a live
 * chain and a resolved spot token.
 *
 * Grouped server-side because the grouping is a property of the data, not of the
 * UI — `derived: false` is what makes something an index, and the client should
 * not be re-deriving that from a hardcoded list of five names.
 *
 * `recorded` marks the instruments the headless sampler follows continuously.
 * Anything else works fully in live mode but only has history from its first
 * viewing, and the selector says so rather than letting a user discover it by
 * finding an empty chart.
 */
router.get('/instruments', authenticate, requirePremium, (req, res) => {
  try {
    if (!instrumentService.isReady()) {
      return res.status(503).json({
        message: 'Instrument master not loaded yet. An admin must connect Zerodha.',
        ready: false, indices: [], stocks: [],
      });
    }

    const q = String(req.query.q || '').trim().toUpperCase();
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 500, 1000));
    const recorded = new Set(cfg.RECORDED_STOCKS);

    const all = instrumentService.listTradableUnderlyings().map((u) => ({
      symbol: u.key,
      label: u.label || u.key,
      category: u.derived ? 'stock' : 'index',
      exchange: u.optionExchange,
      lotSize: u.lotSize || null,
      strikeStep: u.strikeStep || null,
      recorded: !u.derived || recorded.has(u.key),
      resolution: vegaTimeseriesService.persistResolutionFor(u.key),
    }));

    const matched = q ? all.filter((i) => i.symbol.includes(q) || i.label.toUpperCase().includes(q)) : all;

    const indices = matched.filter((i) => i.category === 'index');
    const stocks = matched.filter((i) => i.category === 'stock').slice(0, limit);

    res.json({
      ready: true,
      query: q || null,
      // Indices are never truncated — there are five, and losing one to a limit
      // meant for a 200-name stock list would be a bug nobody would notice.
      counts: { indices: indices.length, stocks: stocks.length, stocksTotal: matched.length - indices.length },
      indices,
      stocks,
    });
  } catch (err) {
    console.error('[vega/instruments] error:', err.message);
    res.status(500).json({ message: 'Failed to list instruments' });
  }
});

// GET /api/vega/status — sampler health, for the admin panel
router.get('/status', authenticate, requirePremium, (req, res) => {
  res.json(vegaTimeseriesService.getStats());
});

module.exports = router;
