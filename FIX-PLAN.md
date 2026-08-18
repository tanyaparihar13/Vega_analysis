# Vega Analysis — Fix Plan

Derived from the end-to-end audit. Every entry is a **confirmed** defect: reproduced
numerically, traced in source, or observed live in production.

Legend for **Financial impact**:
- `none` — no stored or displayed financial value changes
- `display` — a displayed value changes but no stored value does
- `MATERIAL` — changes stored financial results; **ships disabled behind a flag**, requires
  explicit sign-off before activation

---

## Group A — Production availability (502)

### A-01 · Backend not listening; port bound too late in boot
| | |
|---|---|
| **File** | `server/src/index.js` |
| **Function** | `boot()` IIFE |
| **Current** | Migrations and `seedAdmin` run *before* `server.listen()`. After listen, `restoreSession()`, `verifySession()`, `optionStreamService.init()` and `vegaTimeseriesService.start()` are **unguarded**; any throw rejects `boot()` and the terminal `.catch` calls `process.exit(1)` — killing a server that was already listening and healthy. |
| **Expected** | The port binds first and stays bound. A failure in any optional subsystem degrades that subsystem, never the process. |
| **Fix** | Move `server.listen()` to the first step. Wrap every subsequent step in its own try/catch. Replace the terminal `process.exit(1)` with a log that keeps serving once listening. |
| **Risk** | Low. Strictly increases availability. Route behaviour unchanged. |
| **Test** | `boot.test.mjs` — asserts listen precedes DB work and that a thrown subsystem does not exit. Manual: stop MySQL, start server, `GET /api/health` → 200. |
| **Financial impact** | none |

### A-02 · No unhandled-rejection / uncaught-exception handlers
| | |
|---|---|
| **File** | `server/src/index.js` |
| **Current** | None registered. On Node ≥15 an unhandled promise rejection **terminates the process**. In a long-running app holding a broker socket, five crons and a 1 Hz push loop, this is the most likely cause of an unexplained death behind a 502. |
| **Expected** | Log loudly, keep serving. Only a genuinely fatal condition exits. |
| **Fix** | Register `unhandledRejection` and `uncaughtException` handlers that log and continue. |
| **Risk** | Low. |
| **Test** | `boot.test.mjs` asserts both handlers are registered. |
| **Financial impact** | none |

### A-03 · `trust proxy` unset behind nginx → rate limiter buckets all users together
| | |
|---|---|
| **File** | `server/src/app.js` |
| **Current** | `req.ip` is `127.0.0.1` for every request behind the proxy, so `express-rate-limit` counts the entire internet in one bucket: 50 auth requests / 15 min **globally**, and the public limiter's 120/min becomes a global cap. Presents as intermittent 429s / apparent outage. |
| **Expected** | Per-client-IP limiting via `X-Forwarded-For`. |
| **Fix** | `app.set('trust proxy', 1)` immediately after `express()`. |
| **Risk** | Low. Must be `1` (not `true`) so only the first hop is trusted. |
| **Test** | `app.test.mjs` asserts the setting; manual `curl` with differing `X-Forwarded-For`. |
| **Financial impact** | none |

### A-04 · `morgan('dev')` in production; unused `esbuild` production dependency
| | |
|---|---|
| **File** | `server/src/app.js`, `server/package.json` |
| **Current** | Colour-coded per-request logging in production; a ~10 MB `esbuild` binary installed on every deploy but imported nowhere in `server/src`. |
| **Fix** | Gate morgan on `NODE_ENV` (`combined` in production). Move `esbuild` out of `dependencies`. |
| **Risk** | Low. |
| **Test** | `grep -r esbuild server/src` → no match (verified). |
| **Financial impact** | none |

### A-05 · No deployment artifacts under version control
| | |
|---|---|
| **File** | repo root (new) |
| **Current** | No nginx vhost, PM2 ecosystem file or systemd unit is version-controlled, though correctness depends on `TZ`, MySQL session timezone and ~20 env vars. A rebuilt server is a manual reconstruction. |
| **Fix** | Add `deploy/nginx-vega.conf`, `deploy/ecosystem.config.js`, `deploy/vega-api.service`, `deploy/diagnose-502.sh`. |
| **Risk** | None — additive files, not executed by the app. |
| **Test** | `nginx -t` on the VPS. |
| **Financial impact** | none |

---

## Group B — Data correctness

### B-01 · Live push emits the FIRST sample of a bucket; history stores the LAST
| | |
|---|---|
| **File** | `server/src/services/vegaStreamService.js`, `server/src/services/vegaTimeseriesService.js` |
| **Function** | `handleSamplerTick()` / `bucketByTimeframe()` |
| **Current** | `if (session.lastBucket === bucket) continue;` suppresses every sample after the first in a bucket. `bucketByTimeframe` keeps the last. Measured divergence on a 1m bar: **111 (history) vs 100 (live)**. The in-progress bar never updates — frozen for up to the full timeframe. |
| **Expected** | Identical bucketing and final-value semantics. The in-progress bucket updates as data arrives; the closed bucket equals the persisted value; a reload matches. |
| **Fix** | Emit on **every** sampler tick, stamped with the bucket start (shared `bucketStartFor()`), and let the client replace in place. Extend `VegaChart`'s append heuristic to handle same-time replacement so the axis does not re-fit every 5 s. |
| **Risk** | Low. Message rate rises to 1 per 5 s per client (~40 B/s). The client's replace-in-place branch already exists. |
| **Test** | `bucketing.test.mjs` — replays 5 s samples through the history aggregator and through the live emit + client reducer, asserts equality for 5s/10s/15s/30s/1m/5m/15m/30m/1h. |
| **Financial impact** | display (converges live onto the already-correct stored value) |

### B-04 · WebSocket silently substitutes a different expiry
| | |
|---|---|
| **File** | `server/src/services/vegaStreamService.js`, `client/src/features/vegaAnalysis/useVegaStream.js` |
| **Function** | `handleSubscribe()` / the `vega_subscribed` handler |
| **Current** | Server: `const chosen = expiry && expiries.includes(...) ? ... : expiries[0]`. Client accepts the reply comparing `symbol` and `timeframe` but **not `expiry`**. The fallback expiry's series is painted under the selected expiry's label and then freezes permanently, because `vega_point` *is* expiry-filtered. |
| **Expected** | Selecting 11 Aug returns 11 Aug or an honest empty state. Never a substitute. |
| **Fix** | Server refuses with a new non-alarming `vega_unavailable` message naming what *is* tracked. Client validates `symbol` **and** `expiry` **and** `timeframe` on every inbound message, and on `vega_unavailable` clears the stream so the REST path (which already filters correctly) takes over. |
| **Risk** | Very low — strictly a tightening. |
| **Test** | `expiry.test.mjs` — subscribe to an untracked expiry asserts no `vega_subscribed` with a differing expiry; A→B→A switch asserts no contamination. |
| **Financial impact** | none (removes wrong data) |

### B-06 · Delta band implemented twice; the two disagree for stocks
| | |
|---|---|
| **File** | `client/src/features/optionChain/OptionChainTable.jsx`, `server/src/config/vegaConfig.js` |
| **Current** | Client `DEFAULT_BAND` floor for stocks is **0.05**; server `STOCK_START` is **0.20**. Client ceiling hardcoded 0.60; server `DELTA_MAX` is env-tunable. Client uses signed ranges with a 1e-6 epsilon; server uses `Math.abs` with none — so a strike at 0.600000004 is included by the table and excluded from the Vega sum. |
| **Expected** | One rule, defined server-side, applied identically everywhere. |
| **Fix** | `buildChain()` emits `deltaBand: {start, max}`. The table filters on the payload using the server's exact `Math.abs(d) >= start && <= max` semantics. Delete `DELTA_BANDS`/`DEFAULT_BAND`/`EPS`. |
| **Risk** | Low — display only; `snapshot.chain` is never mutated. Stock chains will correctly show fewer rows. |
| **Test** | `deltaFilter.test.mjs` — boundary table at 0.05/0.06/0.20/0.59/0.60/0.61 for CE and PE, asserting inclusive-both-ends and `>=`/`<=` (not `>`/`<`). |
| **Financial impact** | display (option-chain row visibility only; Vega sums already used the server rule) |

### B-07 · `yearsToExpiry` returns `NaN` for a `Date` input
| | |
|---|---|
| **File** | `server/src/utils/blackScholes.js` |
| **Current** | `String(new Date(...)).slice(0,10)` → `"Mon Aug 25"` → `Invalid Date` → `NaN`. `NaN > 0` is false, so IV → null, every Greek → null, the day-open baseline is rejected and the instrument records **nothing for the whole day**. Only `dateStrings: true` in `db.js` keeps this latent. |
| **Expected** | Accept `Date`, `YYYY-MM-DD`, DATETIME and ISO identically; throw loudly on anything unparseable. |
| **Fix** | Normalise a `Date` through the IST shift; `throw new TypeError` on an unparseable value. Comment `db.js` that `dateStrings` is load-bearing. |
| **Risk** | Very low — no current caller passes a `Date`. |
| **Test** | `timeToExpiry.test.mjs` — all four input forms agree; `Date` no longer returns NaN; expiry-day T; past expiry clamps to 0. |
| **Financial impact** | none |

### B-09 · Delayed public series drops its resolution filter
| | |
|---|---|
| **File** | `server/src/services/vegaTimeseriesService.js` · `loadDelayed()` |
| **Current** | When `pickResolution()` returns null the `(:resolution IS NULL OR ...)` predicate becomes a no-op and **all** resolutions are read together — two rows per boundary, the exact doubling the surrounding comment warns about. |
| **Fix** | Return an empty series with `unavailable: {reason:'resolution'}` instead of dropping the filter. Same guard on the fallback-day branch. |
| **Risk** | Low. |
| **Test** | `bucketing.test.mjs` mixed-resolution case. |
| **Financial impact** | none |

### B-10 · Single-point series keeps its raw timestamp
| | |
|---|---|
| **File** | `server/src/services/vegaTimeseriesService.js` · `bucketByTimeframe()` |
| **Current** | `if (points.length < 2) return points;` — the session's first point lands off-grid, then jumps to the boundary when the second arrives, forcing a full `setData` and axis re-fit. |
| **Fix** | Remove the early return; the loop already handles one element correctly. |
| **Risk** | Very low. |
| **Test** | `bucketing.test.mjs` single-point case. |
| **Financial impact** | none |

### B-11 · OI baseline / IV history use the UTC date, not the IST trading date
| | |
|---|---|
| **File** | `server/src/services/oiBaselineService.js` |
| **Current** | `new Date().toISOString().slice(0,10)` while every other date in the system is `istParts().date`. Correct only because the crons happen to fire at 15:35/15:40 IST. |
| **Fix** | Use the shared IST helper. |
| **Risk** | Very low. |
| **Test** | `dateTime.test.mjs` IST-vs-UTC boundary cases. |
| **Financial impact** | none |

### B-12 · Two retention paths on two different clocks
| | |
|---|---|
| **File** | `server/src/services/dataRetentionService.js` |
| **Current** | Compares `snapshot_date` (IST trading day) against MySQL `NOW()` (server-local) while `purgeOldHistory()` uses `CURDATE()`. |
| **Fix** | Use `CURDATE() - INTERVAL :days DAY` in both. |
| **Risk** | Low — narrows what is deleted at the boundary, never widens it. |
| **Test** | Reviewed; no destructive test run. |
| **Financial impact** | none |

### B-14 · `normalizeTick.timestamp` is `Date | string`
| | |
|---|---|
| **File** | `server/src/utils/normalizeTick.js` |
| **Fix** | Normalise to epoch milliseconds. |
| **Risk** | Low — consumed only by `/api/market/indices` and the dashboard. |
| **Test** | `normalizeTick.test.mjs`. |
| **Financial impact** | none |

### B-16 · Subscription union warns but never truncates
| | |
|---|---|
| **File** | `server/src/services/subscriptionManager.js` · `reconcile()` |
| **Current** | `ensureSubscriptions()` caps its own standing set at `TOKEN_BUDGET`, but browser chain selections are added on top uncapped. Past Kite's ~3,000 limit the broker silently stops delivering some contracts — surfacing much later as null Greeks on an apparently random instrument. |
| **Fix** | Enforce a hard cap in `reconcile()`, dropping lowest-priority tokens (index spots always retained), and report `dropped` in `getStats()`. |
| **Risk** | Low — replaces silent broker-side corruption with deterministic, observable truncation. |
| **Test** | `subscriptionCap.test.mjs`. |
| **Financial impact** | none |

### B-17 · Option-chain push rebuilds the chain per client
| | |
|---|---|
| **File** | `server/src/services/optionStreamService.js` · `startPushLoop()` |
| **Current** | N browsers on one `{symbol, expiry}` = N identical `buildChain` calls per second (~82 IV solves each). |
| **Fix** | Build once per distinct selection per tick, then fan out. |
| **Risk** | Low — identical payload. |
| **Test** | Reviewed; covered by chain equality assertions. |
| **Financial impact** | none |

### B-05 · Option-chain WebSocket and REST cannot serve a stock
| | |
|---|---|
| **File** | `server/src/services/optionStreamService.js`, `controllers/optionChainController.js`, `routes/marketRoutes.js` |
| **Current** | These resolve through `getUnderlying()` (the curated five) while `optionChainService` beneath them handles all 31 underlyings — so every stock 404s at the entry point. |
| **Fix** | `resolveUnderlying() || getUnderlying()`. Filter a null `spotToken` out of `client.subscribedTokens`. |
| **Risk** | Low — purely widening; index behaviour is bit-for-bit unchanged. |
| **Test** | `symbolResolution.test.mjs`. |
| **Financial impact** | none |

### NEW-01 · Missing 30m / 1h timeframes
| | |
|---|---|
| **File** | `server/src/config/vegaConfig.js`, `client/src/features/vegaAnalysis/index.jsx` |
| **Current** | `TIMEFRAMES` stops at 15m, so the 30m tier requested for verification does not exist. 5 s rows can serve both (`1800 % 5 === 0`). |
| **Fix** | Add `30m` and `1h`; add a "Hours" group to the picker. |
| **Risk** | Low — additive. |
| **Test** | `bucketing.test.mjs` covers both. |
| **Financial impact** | none |

---

## Group C — MATERIAL: ships disabled, requires sign-off

### B-02 · Weekly index options priced against the monthly future
| | |
|---|---|
| **File** | `server/src/services/instrumentService.js`, `server/src/services/optionChainService.js` |
| **Function** | `getNearestFuture()` / `buildChain()` |
| **Current** | The front-month future is used as the forward for **every** option expiry. NIFTY futures are monthly; NIFTY options are weekly. Measured at spot 24 000: forward error **+90 points**, delta bias **+0.06 to +0.07** (~13 % relative at ATM) — the exact bias Black-76 was adopted to eliminate, and delta selects which strikes enter the Vega sums. |
| **Expected** | The forward must mature with the option being priced. |
| **Fix** | `getFutureForExpiry()`; exact-expiry future used directly, otherwise discounted to the option's maturity: `F_opt = F_fut · e^(−r(T_fut − T_opt))`. New `forwardSource` values `future-discounted` / `carry`. |
| **Risk** | **Medium.** Every delta, IV and vega on weekly index expiries shifts; the Vega series shows a level change on the day it activates. Stocks unaffected (options and futures share monthly expiries). |
| **Test** | `forward.test.mjs` — before/after delta and vega tables for weekly and monthly contracts. |
| **Financial impact** | **MATERIAL** — gated on `VEGA_FORWARD_MODE=matched`, default `nearest` (current behaviour) |

### B-03 · IV identifiability floor is absolute, not price-relative — **DIAGNOSIS CORRECTED, NOT ACTIVATED**
| | |
|---|---|
| **File** | `server/src/utils/impliedVolatility.js` |
| **Current** | `MIN_IDENTIFIABLE_VEGA = 2.0` on a quantity proportional to the underlying. Measured strikes solvable of 41: NIFTY 41, RELIANCE 16, SBIN 18, TATASTEEL 9, a sub-₹10 name 0. Inside the 0.20–0.60 band a **stock's Vega sum is built from ~3 contracts vs 22 for an index**, and one contract crossing the threshold moves the total ~33 %. |
| **Expected** | Identifiability is relative: reject when one tick of price moves σ by more than a tolerance. |
| **Fix** | `tickSize / rawVega <= MAX_SIGMA_UNCERTAINTY` (default 0.005 = 0.5 vol points per tick), with `tickSize` threaded from the instrument row. `MIN_TIME_VALUE` scaled likewise. |
| **Risk** | **Medium-high.** Widening admission changes the level of every stock Vega series. Day-open baselines are immutable, so full effect only from the next session. |
| **Test** | `ivThreshold.test.mjs` — solvable-strike counts per underlying, absolute vs relative. |
| **Financial impact** | none as shipped — gated on `VEGA_IV_IDENTIFIABILITY=relative`, default `absolute`. **Activation is NOT recommended.** |

> **CORRECTION — the original diagnosis was wrong.** Measurement (`tests/materialChanges.test.js`)
> shows the threshold removes **zero** in-band contracts on every underlying tested:
>
> | underlying | strikes with `|delta|` in [0.20, 0.60] | ...of which IV-solvable | lost |
> |---|---|---|---|
> | NIFTY | 22 | 22 | 0 |
> | RELIANCE | 3 | 3 | 0 |
> | SBIN | 3 | 3 | 0 |
> | TATASTEEL | 3 | 3 | 0 |
>
> The audit conflated *"IV cells blank in the option-chain table"* (true) with
> *"contracts missing from the Vega sums"* (false). Everything the threshold rejects was
> already outside the delta band and never contributed to a sum.
>
> The real reason a stock Vega total uses ~3 contracts while an index uses ~22 is the
> **strike grid** — a stock lists strikes coarsely relative to its 7-day move, so few land
> between delta 0.20 and 0.60. That is market structure, not a defect, and no threshold
> changes it.
>
> Worse, the originally proposed 0.005 tolerance would have made coverage **worse**
> (RELIANCE 16→12 solvable, TATASTEEL 9→0). The default is now calibrated to 0.02, which
> reproduces absolute-mode coverage. The relative rule is retained as an opt-in because it
> is the mathematically defensible form of the test, but there is no measured reason to
> enable it. **Leave `VEGA_IV_IDENTIFIABILITY` unset.**

---

## Group D — Investigate before changing

### B-08 · Trend label moves opposite to the plotted lines
| | |
|---|---|
| **File** | `server/src/services/vegaTimeseriesService.js` · `decorate()`, `utils/vegaTrend.js` |
| **Current** | `DISPLAY_SIGN = −1` negates the three plotted series; `classifyTrend` is deliberately fed the **un-negated** values. A rising green Call Vega line therefore shows a "Bearish" pill. |
| **Why not fixed** | The internal reasoning is sound, but it rests on an unverified assumption about how the reference platform states its rules. **Inverting the trend would relabel every historical point.** This is a parity question, not a maths question, and must be resolved against the reference before any code changes. |
| **Fix applied now** | None to the maths. The API now exposes `trendConvention` and the UI explains the relationship, so the apparent contradiction is legible. |
| **Risk of changing blind** | **High.** |
| **Test** | Manual comparison against the reference platform for one session. |
| **Financial impact** | display, **deferred** |

---

## Not changed (deliberate)

| Item | Reason |
|---|---|
| B-15 recharts removal | Requires rewriting a working marketing-site component. Out of scope for a correctness pass. |
| B-18 drop expiry at T=0 | Would remove the expiring contract from the tracked list after 15:30 IST, breaking the live view of today's own session. The Greeks already blank correctly at T=0. |
| B-20 holiday calendar | Behaviour is already correct (no ticks → no baseline → no rows); only log noise. |
| Theta convention | Analytic θ/365 is the industry standard and matches every retail terminal. The 3.7 % gap versus a 1-day finite difference is convexity, not error. |
| Calendar-day `T` | Standard for quoted IV. Switching to trading days would make this app's IV incomparable with every other screen. |
| Existing DB rows | Nothing is deleted or rewritten. Duplicate detection reports only. |
