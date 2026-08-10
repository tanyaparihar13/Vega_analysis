# Vega Analysis — Complete Implementation Report

Covers everything delivered across the stock-universe restriction, the two-step
onboarding flow, the Alpha Edge layout rework, and the live-data fixes.

**Totals:** 20 files modified, 6 new source files, 2 new database tables.
`+1,430 / −388` lines on tracked files.

**Unchanged, as instructed:** `utils/vegaMath.js`, `utils/blackScholes.js`,
`utils/impliedVolatility.js`, `utils/vegaTrend.js`, `services/optionChainService.js`,
`services/kiteTickerService.js`, `services/subscriptionManager.js`, the sampler's
arithmetic and cadence, index delta floors, and the Zerodha tick path.

---

# 1 · BACKEND

## 1.1 Stock universe

### `server/src/constants/nifty50.js` — NEW (127 lines)
Single source of truth for the supported equity universe.

- `NIFTY50_CORE` — the 26 tradingsymbols, grouped by sector.
- `readUniverseEnv()` — parses `VEGA_STOCK_UNIVERSE`; accepts a comma list or
  the literal `ALL`, falls back to the 26.
- `UNIVERSE_SET` — uppercased `Set` for O(1) membership on the indexing hot path.
- `isInUniverse(symbol)` — the gate predicate. Always true in `ALL` mode.
- `stockTokenCost(window, expiries)` — used by the boot-time budget report.

**`TATAMOTORS` → `TMPV`.** Verified against the live instrument dump: Tata Motors
has demerged and `TATAMOTORS` no longer exists in Kite's master at all.

| Symbol | Name | Option contracts |
|---|---|---|
| `TMCV` | TATA MOTORS (commercial vehicles) | **0 — cash only** |
| `TMPV` | TATA MOTORS PASS VEH | 131 |

`TMPV` is the only Tata Motors entity that can produce a Vega series. Left as
`TATAMOTORS` the universe would silently have run 25 stocks against a budget
sized for 26.

### `server/src/services/instrumentService.js` — MODIFIED (+88)
- Imports `nifty50`.
- **The gate**, inside `buildIndexes()`, one line before `bucketFor()`:
  `if (!curatedByName.has(key) && !nifty50.isInUniverse(key)) continue;`
  Placed before the bucket is created so `byUnderlying` never holds the
  per-expiry strike Maps of ~175 unsupported stocks.
- **`reportUniverse()`** — new. Runs at the end of every `buildIndexes()` and
  logs: how many universe names resolved, which have no live chain, which have
  no spot token, and the projected standing token cost against the budget.

**Why one gate is enough:** everything downstream resolves symbols through
`resolveUnderlying()` — the `/vega/instruments` catalogue, the WebSocket
subscribe handler, all `/api/vega/:symbol` routes, `recordedSymbols()` in the
recorder, and `getTokensForExpiry()`. An off-universe name does not exist to any
of them, rather than being filtered in five places that can drift apart.

**The instruments table keeps the full master** (60,429 rows verified). Hard
filtering the download would break `cashByExchangeSymbol`, which needs the EQ
rows to resolve stock spot tokens at all.

### `server/src/config/vegaConfig.js` — MODIFIED (+41)
- New `envSymbolList(name)` helper — dedupes, uppercases, drops the `ALL` flag.
- `RECORDED_STOCKS` now **defaults to the whole universe** instead of `[]`, so
  all 26 are enrolled in the headless recorder and have history.
- New exports `STOCK_UNIVERSE`, `STOCK_UNIVERSE_MODE`.

## 1.2 Registration

### `server/src/controllers/authController.js` — MODIFIED (+360)
`register()` rewritten:
- Accepts and **requires `broker`**, whitelisted against `BROKERS` before it
  reaches SQL (an unknown value would hit the ENUM and 500 opaquely).
- Validates `confirmPassword` server-side (only when sent, so existing API
  callers keep working).
- Creates the `users` row **and** the `user_onboarding` row in **one
  transaction** — a user without a funnel row would be invisible to the admin.
- Returns a scoped `onboardingToken` and `nextStep`, and **no** `whatsappUrl`.

New in this file:
- `ONBOARDING_OPTIONS` — the three options, their prices and their consequences.
- `signOnboardingToken(userId)` — 30-minute JWT carrying `{id, scope:'onboarding'}`.
- `buildOnboardingWhatsAppUrl()` — Name, Mobile, Email, **Demat Broker**, User ID,
  registration timestamp (IST), Selected Option, Status. Never the password.
- `onboardingOptions()` — `GET`, public, serves the price list.
- `selectOnboardingOption()` — records the choice, raises the notification.
- `markWhatsappOpened()` — funnel telemetry.

**`users.broker` is never overwritten by onboarding.** Two columns, two
questions: `users.broker` = the broker they already trade through;
`user_onboarding.broker_choice` = the account they are willing to open.

### `server/src/routes/authRoutes.js` — MODIFIED (+18)
```
GET  /api/auth/onboarding/options            public
POST /api/auth/onboarding/select             onboarding token
POST /api/auth/onboarding/whatsapp-opened    onboarding token
```

## 1.3 Onboarding + admin

### `server/src/controllers/onboardingController.js` — NEW (265 lines)
- `ACTIONS` — the whitelist: `contacted`, `payment_received`, `reset_payment`,
  `dhan_completed`, `angel_completed`, `reset_broker`, `whatsapp_confirmed`,
  `activate`. Each carries its own SQL fragment (a constant, never user input).
- `listOnboarding()` — filters on option / payment / broker / user status /
  `pending=1` ("needs action"), all whitelisted and bound; returns rows, total
  and the badge counts in one round trip.
- `updateOnboarding()` — one PATCH endpoint for every transition; guards admin
  accounts; writes `admin_audit_log` on every change.
- `listNotifications()`, `readNotification()`, `readAllNotifications()`.

**Only `activate` touches `users.status`.** Marking a payment received is
bookkeeping and must not grant access.

### `server/src/services/notificationService.js` — NEW (87 lines)
`create()` deliberately swallows its own errors and returns null — a
notification is a convenience, and failing a user's onboarding because a
nice-to-have INSERT hit a lock would be the wrong trade. Reads do **not** swallow
errors: an admin must be able to tell "nothing happened" from "the query broke".

### `server/src/routes/adminRoutes.js` — MODIFIED (+10)
```
GET   /api/admin/onboarding
PATCH /api/admin/onboarding/:userId
GET   /api/admin/notifications
PATCH /api/admin/notifications/:id/read
POST  /api/admin/notifications/read-all
```

## 1.4 WebSocket

### `server/src/services/vegaStreamService.js` — MODIFIED (+54)
- `handleSubscribe` is now **async**; `handleMessage` catches its rejection.
- **Warm start:** when the live ring buffer is empty, falls back to
  `loadByDate()` for today rather than sending `points: []`. Covers a mid-session
  restart and a stock nobody has been watching. Same bucketing and `decorate()`
  as the REST path, so a warm-started chart is identical to a reloaded one.
- **Stale-selection guard:** after the await, re-checks `sessions.get(client)`
  and the socket's `readyState` before sending. Without it a slow MySQL read
  could repaint the chart with an instrument the user already navigated away from.
- Response gains `source: 'memory' | 'database' | 'empty'`.

## 1.5 Historical recorder

No logic change. Its behaviour changed only through configuration:
`RECORDED_STOCKS` now defaults to the 26-name universe, so `recordedSymbols()`
enrols them and they persist at 5s exactly like the indices. Sampling cadence,
day-open capture, `computePoint`, strike mode, hysteresis, retention and the
`decorate()` sign convention are untouched.

---

# 2 · FRONTEND

## 2.1 Hero — `client/src/site/components/DelayedVegaPanel.jsx` (rewritten, +524/−…)

Alpha Edge layout, engineered to a **height budget**:

```
header (compact)                    44–61px
row 1  Call | Put | Difference | Trend   62–75px   ← 4 compact tiles
row 2  Unlock Live Vega Analysis         64–113px  ← centred horizontal bar
row 3  [ chart 1fr ][ records 19rem ]    280–480px ← side by side
footer disclosure                    40–55px
```

New in this file:
- **`useTerminal()`** — returns `{ height, compact }` from the viewport. Two
  measured chrome budgets: `CHROME_TALL = 382`, `CHROME_SHORT = 345`, clamped to
  280–480. `compact` triggers below 800px inner height.
- **`RecordsTable`** — new. Time / Call / Put / Difference, sticky header,
  internal scroll, `overscroll-contain`, exact `height` match with the chart.
  Trend rides as the Difference cell's colour (a fifth pill column will not fit
  a 19rem rail) with the label on the row's `title`.
- **`UnlockCard`** — now a horizontal bar: ~250px → ~100px. Keeps the emerald
  ring, live dot, float animation and CTA. Glow reduced from `shadow-glow` to a
  28px ring so it stops washing into the tiles above and the chart below.
- **`Stat` / `TrendStat`** — compact tiles; value type 24px → 16px (14px compact).
- `compact` also drops the header subtitle, the unlock card's description and
  secondary badge, and shortens the footer text. Without it 1366×768 overflowed
  by **83px measured**.

**Data flow untouched** — same `/vega/:symbol/delayed-series` endpoint, same
60-second poll, same delayed/fallback semantics. The hero chart keeps updating
continuously.

## 2.2 Chart

### `client/src/site/components/PublicVegaChart.jsx` — MODIFIED (+33)
- New `heightOverride` prop. Applied at mount, in an effect, **and** inside the
  ResizeObserver's `applySize` via `overrideRef`, so it wins in all three paths.
  This is what makes the chart and the table exactly the same height.
- `heightFor` hero ladder extended for the now-full-width chart:
  `<480 → 340 · <768 → 430 · <1100 → 540 · <1500 → 620 · else 720`.

### `client/src/features/vegaAnalysis/VegaChart.jsx` — MODIFIED (+56)
- `heightFor` rewritten around a **measured** `CHROME_PX = 515` (chart card top
  431 + panel head 40 + padding 44 at 1920×970), clamped 300–480.
- `rightPriceScale.scaleMargins` 0.14 → **0.09** (at 480px tall, 14% was 134px of
  dead space).
- `rightPriceScale.minimumWidth` 60 → **72** so 4-figure vega values never clip.
- `timeScale.barSpacing` **9** (new) and `rightOffset` 4 → **8**.
- Narrow-screen overrides updated to match.

## 2.3 Dashboard — `client/src/features/vegaAnalysis/index.jsx` — MODIFIED (+268/−…)
- **Removed** the entire left `<aside>`: Session card, Delta Filter card, Day-open
  card. With it went the `Row` component, `sessionForDate`, and the
  `TbClockHour4` import.
- **Merged** the page header row, the instrument row and the toolbar into one
  `glass-card` — saves ~120px of vertical space.
- **Δ pill** added to the toolbar: the delta band is *which contracts the sums
  are built from*, so a reader comparing a stock against an index needs to see
  that they differ. Verified switching NIFTY → RELIANCE flips it 0.05 → 0.20.
- **Workspace grid** `xl:grid-cols-[minmax(0,1fr)_20rem]` — chart left, records
  right, side by side from 1280px, stacked below.
- Summary tiles compacted (`py-3` → `py-2`, value `text-2xl` → `text-xl`).
- Records scroll box `xl:max-h-[calc(100vh-32rem)]` to match the chart budget.
- **Split the fetch effect in two** — see §5.2.

## 2.4 Registration form — `client/src/pages/Register.jsx` — MODIFIED (+87)
- **Demat Broker dropdown restored**, `required`, between Email and Password:
  Zerodha · Dhan · Upstox · Groww · Angel One.
- Confirm Password field with a `aria-live="polite"` mismatch hint (polite, not
  assertive — it fires on every keystroke of the second password).
- Broker label carried into the router state for the pending screen.
- Copy updated to explain that the next screen chooses the access route.

## 2.5 Onboarding page — `client/src/pages/Onboarding.jsx` — NEW (278 lines)
Three full-width premium option rows (gold / emerald / electric-blue), price
chip on Lifetime, per-row spinner, single-selection guard. Confirmation state
repeats the WhatsApp link for blocked popups. Detects a missing/expired token on
mount and says so instead of failing at submit.

## 2.6 Admin panel — `client/src/features/admin/OnboardingPanel.jsx` — NEW (278 lines)
Filters (Needs action / Lifetime / Dhan / Angel One / Payment pending / All) with
live badge counts. Columns: User (name, email, phone, ID), Source, Selected,
WhatsApp, Payment, Broker, Account, Registered, Actions. **Activate** is styled
and placed apart because it is the only action that grants access.

`client/src/pages/AdminDashboard.jsx` — Onboarding added as the **second** tab.

## 2.7 Other frontend files
- `client/src/App.jsx` (+13) — `/onboarding` route, documented as public by
  necessity (the account it serves cannot log in).
- `client/src/context/AuthContext.jsx` (+74) — `register()` takes `broker` and
  `confirmPassword`; stores the onboarding token in **sessionStorage**; adds
  `selectOnboardingOption()`, `markWhatsappOpened()`, `clearOnboardingToken()`.
- `client/src/pages/PendingApproval.jsx` (+25) — shows Demat Broker and Selected
  Option; fallback WhatsApp message mirrors the server's field for field.
- `client/src/site/pages/Home.jsx` (+12) — hero section padding
  `pt-8/pt-12` → `pt-3/pt-4`, `px-3` → `px-2`.
- `client/src/index.css` (+23) — **not mine**; dark-theme `<select>` styling added
  externally, which complements the restored dropdown. Left in place.

## 2.8 Responsiveness
| Breakpoint | Hero | Dashboard |
|---|---|---|
| `<640` | tiles 2-up, card stacked, chart 320 | chart 300, table below |
| `640–1023` | tiles 2-up, chart 380, table below | chart 340–420, table below |
| `1024–1279` | **chart + table side by side** | chart 420, table below |
| `≥1280` | side by side, chart 280–480 | **side by side**, chart 300–480 |

---

# 3 · DATABASE

## New tables — `server/src/schema.onboarding.sql` (NEW, 120 lines)

**`user_onboarding`** — one row per user (UNIQUE on `user_id`).
`selected_option` ENUM(lifetime, dhan, angel_one) · `payment_intent` ·
`broker_choice` · `price_inr` · `selected_at` · `whatsapp_status` ·
`whatsapp_opened_at` · `payment_status` · `payment_received_at` ·
`broker_status` · `broker_completed_at` · `contacted_at` · `activated_at` ·
`admin_note` · `handled_by` · timestamps.
FK `user_id` → CASCADE; FK `handled_by` → SET NULL (deleting the admin who
handled a lead must not delete the lead). Four indexes for the admin filters.

**`admin_notifications`** — generic `type` + `payload` rather than
onboarding-specific, so future alerts (session expiry, feed down) reuse it.

**Backfill** — `INSERT IGNORE` gives every existing non-admin user a `legacy`
row, and already-approved accounts get `activated_at` set so the admin's "needs
action" filter stays honest. Idempotent; re-runs safely on every boot.

## New columns
**None.** `users.broker` already existed and was already NULLable.

## Migration — `server/src/config/migrate.js` (+11)
`schema.onboarding.sql` appended **last** (it declares FKs onto `users` and
backfills from it). Verified applied: 6/6 files, both tables created, 5 users
backfilled as `legacy`, 2 marked activated.

**Rollback:** `DROP TABLE user_onboarding, admin_notifications;` — nothing in
`users` was altered.

---

# 4 · SECURITY

## Onboarding token
A newly registered account is `status='pending'` and **cannot log in**, so
`/onboarding` has no session. Taking a `userId` from the request body would let
anyone write a selection against any account and spam admin notifications.

`register()` returns `jwt.sign({ id, scope: 'onboarding' }, JWT_SECRET, { expiresIn: '30m' })`.
It carries **no role and no status**, so it cannot be mistaken for a session.
Stored in **sessionStorage**, never localStorage — it dies with the tab and is
never picked up by anything reading `vega_token`.

## Authentication flow — `server/src/middleware/auth.js` (+64)
- **`authenticate` now rejects ANY token carrying a `scope` claim** — not just
  `'onboarding'`. Without this the onboarding token would be a valid session
  everywhere, letting anyone who registers skip the approval gate entirely.
  Rejecting the whole class makes future scoped tokens safe by default.
- **`authenticateOnboarding`** — new; requires `scope === 'onboarding'` and an
  `id`, attaches `req.onboarding = { userId }`, and returns typed error codes.

### Verified live
| Test | Result |
|---|---|
| Onboarding token → `GET /api/auth/me` | **401** |
| Onboarding token → `GET /api/vega/instruments` | **401** |
| `POST /onboarding/select` with no token | **401** |
| `POST /onboarding/select` invalid option | **400** + whitelist |
| Register without broker | **400** |
| Register with `broker: "robinhood"` | **400** + whitelist |
| Admin PATCH with `action: "drop_table"` | **400** + whitelist |
| 3× identical selection | **1** notification (guarded on change) |
| Delete user | onboarding + notifications CASCADE to 0 |

Unchanged: bcrypt cost 12, JWT secret and expiry, the approval gate, the
WebSocket upgrade check, password reset, and `hasMarketAccess`.

---

# 5 · PERFORMANCE

## 5.1 Chart rendering
Measured on this machine with the project's own pricing modules: the full
sampler pipeline for **5 indices × 3 expiries + 50 stocks costs 73ms per 5,000ms
tick — 1.5% of the interval**; worst case (every contract on the bisection path)
27ms. **CPU is not the constraint**; the Kite token cap is. This corrected an
earlier assumption in the audit that allocation was a Phase-6 blocker.

Chart-side: `scaleMargins` 0.14→0.09, `minimumWidth` 60→72, explicit
`barSpacing: 9`. The append-vs-reset path in the data effect is unchanged, so a
live point is still a single `series.update()`.

## 5.2 Stock switching
`client/src/features/vegaAnalysis/index.jsx` — the series effect depended on
`streamHealthy`, which **always** flips `false → true` once when the socket's
first `vega_subscribed` lands. Every instrument switch therefore fired **two**
identical `/series` requests, the second arriving after the chart had already
repainted from the stream.

Split into two effects: one fetch per selection (`load` identity changes only
with `{symbol, timeframe, date, expiry}`), and a separate poll that runs **only**
while the stream is unhealthy.

## 5.3 Blank chart fix
`client/src/features/vegaAnalysis/useVegaStream.js` (+50) — the subscription
effect cleared `points` and `meta` to `[]`/`null` the instant the selection
changed, guaranteeing at least one empty frame and, on a slow round trip, a
visibly empty chart. Switching between 26 stocks made that the dominant
impression of the page.

Now: a new `switching` flag goes true on selection change, `points`/`meta` are
**not** cleared, and the page renders a loading veil over the outgoing curve
(`loading={(loading && !points.length) || stream.switching}`). Both are replaced
in one commit when the back-fill lands.

Two guards keep the stale curve from being mistaken for the new one:
the message handler drops any `vega_point` not matching `wantRef`, and
`vega_error` **does** clear immediately — no replacement is coming, so leaving
the old curve up would be a lie rather than a transition.

Server-side, the warm start (§1.4) means a client never receives an empty
back-fill for a day that has rows on disk.

---

# 6 · TOKEN BUDGET

## Formula (from `ensureSubscriptions`, line 422)
```
charged(target) = 2·S + future + spot = 2S + 2      per {symbol, expiry}
actual(underlying) = E·2S + 1 + 1                   after Set dedup
```
The future and spot tokens resolve **per underlying**, not per expiry, so the
budget over-charges by `2(E−1)` each — 20 tokens across 5 indices. Pessimistic,
i.e. it protects.

## Final usage — measured on the running server
```
GET /api/vega/status  →  subscription.standing['vega-sampler'] = 2,746
                         TOKEN_BUDGET                          = 2,800
                         Kite per-connection cap               ≈ 3,000
                         headroom to budget                    =    54
                         skippedTicks                          =     0
                         sampleInFlight                        = false
```
Below the 2,796 arithmetic maximum because several stock boards list fewer than
17 strikes near expiry.

| Class | Window | Expiries | Per underlying | Count | Total |
|---|---:|---:|---:|---:|---:|
| Index | 30 | 3 | 372 | 5 | 1,860 |
| Stock | 8 | 1 | 36 | 26 | 936 |
| | | | | | **2,796 max** |

## Supported indices — 5
NIFTY · BANKNIFTY · FINNIFTY · MIDCPNIFTY · SENSEX
Delta floors unchanged: NIFTY 0.05, SENSEX 0.05, others 0.20. Ceiling 0.60.

## Supported stocks — 26, all recorded at 5s, delta band 0.20–0.60
ADANIENT · ADANIPORTS · AXISBANK · BAJAJFINSV · BAJFINANCE · BHARTIARTL ·
HCLTECH · HDFCBANK · HINDUNILVR · ICICIBANK · INFY · ITC · KOTAKBANK · LT ·
M&M · MARUTI · NTPC · POWERGRID · RELIANCE · SBIN · SUNPHARMA · TATASTEEL ·
TCS · **TMPV** · ULTRACEMCO · WIPRO

Verified: `GET /api/vega/instruments` → `{ indices: 5, stocks: 26 }`, every
stock `recorded: true`, `resolution: '5s'`; instruments table still 60,429 rows.

---

# 7 · LAYOUT VERIFICATION (measured in-browser)

## Hero — 1920×1080 (inner 970)
```
panel bottom 917 ≤ 970   ENTIRE PANEL ABOVE FOLD ✓   overflow 0
chart 1250×480 · table 304×480 · side by side ✓ · same height ✓
all seven elements present: Call, Put, Difference, Trend, Unlock, chart, table ✓
```

## Hero — 1366×768 (inner 658, compact mode)
```
panel bottom 658 ≤ 658   ENTIRE PANEL ABOVE FOLD ✓   overflow 0
chart 953×313 · table 304×313 · side by side ✓ · same height ✓
242 rows · first row "15:30  -1.13  +14.13  +15.26" matches the chart's latest ✓
```

## Dashboard — 1920×1080
```
chart 455px · chart card and records card BOTH end at 961 ≤ 970 ✓
side by side ✓ · 242 rows · Δ pill 0.05–0.60 (NIFTY) → 0.20–0.60 (RELIANCE) ✓
Session / Delta Filter / Day-open cards: absent ✓
```

Client build clean (546 modules). Zero console errors in a fresh tab.

---

# 8 · NOTES

1. **The 26 stocks have no history yet.** They were enrolled after the 6 Aug
   close, so `RELIANCE` correctly shows *"Waiting for the day-open baseline"*.
   Recording begins at the next 09:15 open — that session is also the first real
   test of 26 concurrent stock subscriptions. Watch `skippedTicks` in
   Admin → System Status (measured cost ~1.5% of the tick, so no movement
   expected).

2. **One existing account has a derived broker.** User 17
   (`sunitaparihar505@gmail.com`) registered during the window when the dropdown
   was absent, and their `users.broker` was set to `dhan` from their onboarding
   choice by the mirroring logic that has since been removed. Their actual demat
   broker is unrecorded. Worth confirming with them.

3. **`VEGA_STOCK_UNIVERSE`** overrides the list without a code change;
   `=ALL` restores every F&O name (and will exceed the budget, with truncation
   logged).

4. **NIFTY 50 reconstitutes each March and September.** `reportUniverse()` logs
   any name that stops resolving, but a name ADDED to the index will not appear
   on its own — `constants/nifty50.js` needs review after each reconstitution.
