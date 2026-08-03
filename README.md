# Vega Analysis — Stock Market Analytics Platform

## Public website + app (one project)

The public marketing site and the trading terminal are a **single React app** on
a single origin, so the browser session, the JWT and the API are shared with no
cross-origin token handoff.

| Route | Who sees it |
|---|---|
| `/`, `/features`, `/pricing`, `/contact` | anyone — public site, `src/site/**` |
| `/login`, `/register`, `/pending-approval`, `/admin/login` | anyone — auth screens |
| `/dashboard`, `/vega-analysis`, `/option-chain`, `/greeks`, … | approved users |
| `/admin`, `/admin/dashboard` | admins |

Signing in routes by role: an admin lands on `/admin`, everyone else on
`/dashboard`.

**The public site's design system is namespaced.** Everything under
`src/site/**` uses `site-` prefixed classes (`site-btn-primary`, `site-card`,
`site-eyebrow`, …) defined at the end of `src/index.css`. This is not stylistic
— the marketing design and the terminal design both define `btn-primary` and
`btn-ghost`, and mixing them would silently restyle every button in the
dashboard and admin console. Do not use bare `btn-*` inside `src/site/`, and do
not use `site-*` outside it.

### The delayed public chart

The home page hero shows a **real** NIFTY Vega chart built from the recorder's
stored per-minute rows, held back by 30 minutes. It is served by the only
unauthenticated data routes in the app, all in `routes/publicRoutes.js`:

```
GET /api/public/vega/:symbol/delayed-series?timeframe=1m|3m|5m|15m
GET /api/public/vega/symbols
GET /api/public/site-config
```

Only the three vega differences and the derived trend are exposed. Live data,
absolute vega totals, the day-open baseline, spot, expiry, the option chain and
the Greeks are all withheld — see the comments in that file.

Before ~09:45 IST (and at weekends) today has no publishable points yet, so the
endpoint falls back to the most recent completed session and sets
`isFallbackDay: true`. The UI must label that case rather than passing off an
old session as today's.

### Extra environment variables

All optional; sensible defaults apply when unset.

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_VEGA_DELAY_MINUTES` | `30` | Delay applied to the public chart |
| `PUBLIC_CONTACT_EMAIL` | _(unset)_ | Shown on `/contact` if set |
| `PUBLIC_CONTACT_PHONE` | _(unset)_ | Shown on `/contact` if set |
| `VITE_API_TARGET` (client) | `http://localhost:5000` | Dev proxy target |

`ADMIN_WHATSAPP_NUMBER` was already required for the signup handoff; the
contact form uses the same number.

## What's built

**Backend** (`/server`): Express + MySQL
- JWT auth: `/api/auth/register`, `/login`, `/admin-login`, `/me`
- Registration collects name, email, mobile, password and **demat broker**
  (Zerodha / Angel One / Dhan / Upstox / Groww), creates the account as
  `pending`, and returns a prefilled WhatsApp click-to-chat URL carrying those
  details for the admin to approve
- Role-based access control (`free`, `premium`, `admin`) via middleware
- Full MySQL schema: `users`, `plans`, `subscriptions`, `login_history`,
  `watchlists`, `strategies`, `alerts`, `zerodha_sessions`
- Admin API: user management, activate/deactivate, login history, live
  activity, plans, subscriptions
- Zerodha Kite Connect: login URL generation, callback/session exchange,
  **AES-256-GCM encrypted** access token storage, connection status check
- Live market feed, split into focused services:
  - `services/kiteTickerService.js` — owns the KiteTicker connection, with
    exactly **one** `ticks` listener and built-in auto-reconnect
  - `services/websocketService.js` — the `/ws/market` WebSocket server;
    sends a `type: "snapshot"` on connect, then `type: "ticks"` for every
    update, with a ping/pong heartbeat so dead connections are dropped and
    the frontend's reconnect logic kicks in reliably
  - `services/marketDataService.js` — orchestrates the two, keeps the
    latest normalized tick per instrument in memory
  - `utils/normalizeTick.js` / `constants/instruments.js` — one place that
    maps instrument tokens to symbols and shapes ticks for the frontend
- Black-Scholes Greeks engine (Delta, Gamma, Theta, Vega, Rho)
- Option chain builder with ATM/ITM/OTM classification, PCR, Max Pain,
  OI build-up classification (Long/Short Build-up, Short Covering, Long
  Unwinding)
- Vega Analysis engine: rolling Call Vega vs Put Vega history, Bullish/
  Bearish bias, Vega expansion/contraction detection

**Frontend** (`/client`): React + Vite + Tailwind + Zustand
- Dark trading theme (black bg, blue accent, glassmorphism cards),
  premium trading-terminal look, smooth fade/pulse transitions
- Login, Register, Admin Login pages
- Protected routing by role
- `services/marketSocket.js` — a single, app-wide WebSocket client with
  automatic connect + exponential-backoff reconnect
- `store/marketStore.js` — Zustand global store; components subscribe with
  per-symbol selectors so a NIFTY tick never re-renders the BANKNIFTY card
- Live Dashboard: 4 index cards (NIFTY 50 / BANKNIFTY / FINNIFTY /
  MIDCPNIFTY) with LTP, change %, O/H/L, previous close and timestamp;
  a live table; a candlestick/area chart panel (TradingView Lightweight
  Charts) with a symbol + chart-type switcher; connection and market-open/
  closed badges; premium-gated panels (Option Chain, Greeks, Vega Analysis)
  with upgrade prompts for free users
- Admin Dashboard: user list with activate/deactivate, Zerodha connect
  button, connection status
- `features/` — architecture placeholders (not yet implemented) for
  Option Chain, Greeks, Open Interest, Strategy Builder, Scanner, Alerts,
  Watchlist, Orders, Portfolio — each is its own folder ready to grow
  components/hooks/services once the backend endpoints exist

## Important honesty note on "auto refresh session daily"

Zerodha's Kite Connect API **requires an interactive login once per day**
(the access token expires ~7:30 AM IST) — there's no supported way to
silently refresh it in the background, and building around that would
violate Kite's API terms. What's implemented instead: a daily cron job
that checks token validity every morning and cleanly restarts the market
feed if a valid session exists, plus a one-click "Reconnect Zerodha"
button in the admin dashboard for when it's expired.

## Setup

```bash
# 1. Database
mysql -u root -p < server/src/schema.sql

# 2. Backend
cd server
cp .env.example .env   # fill in DB creds, JWT secrets, Kite API key/secret
npm install
npm run dev

# 3. Frontend
cd ../client
npm install
npm run dev
```

Open `http://localhost:5173`. In the Admin console, click **Connect
Zerodha** once per trading day to start the live feed — the dashboard's
connection badge will flip to "Connected" and the cards/table/chart will
start updating automatically.

Create your first admin user directly in MySQL (bcrypt-hash the password),
since registration always creates `free` accounts by design:
```sql
INSERT INTO users (name, email, password_hash, role, is_active)
VALUES ('Admin', 'admin@vega.com', '<bcrypt-hash>', 'admin', 1);
```

## Roadmap (next phases)

| Phase | Scope |
|---|---|
| 4 | Full option chain UI (strike search, expiry selector, ATM/ITM/OTM highlighting) wired to the backend engine already built, in `features/optionChain` |
| 5 | Vega Analysis UI table + trend charting, PCR/Max Pain/OI build-up dashboards, in `features/greeks` and `features/openInterest` |
| 6 | Watchlists CRUD, alerts engine (`features/watchlist`, `features/alerts`), caching (Redis) for option chain, MySQL query tuning, production deployment (Docker/Nginx/PM2) |
| 7 | Strategy Builder, Scanner, Orders, Portfolio (`features/strategyBuilder`, `features/scanner`, `features/orders`, `features/portfolio`) |

Say which phase you want built out next and I'll continue directly in this codebase.

