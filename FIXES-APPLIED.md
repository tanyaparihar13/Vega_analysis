# What was broken and what I changed

Diagnosed against the ZIP you uploaded. Your crash was one missing file, but
there were five more problems queued behind it that would have crashed the
server one at a time as you fixed each.

## The crash you reported

`server/src/services/optionChainService.js` did not exist. It is required by
`optionChainController.js`, which is required by `optionRoutes.js`, which is
required by `app.js`. Node stops at the first missing module, so this was the
only error you saw.

## The five problems hiding behind it

1. **`constants/instruments.js` was never replaced.** Still the old 4-index
   version exporting `{ INDEX_TOKENS, TOKEN_TO_SYMBOL, SUBSCRIBED_TOKENS }`.
   `instrumentService`, `optionChainService` and `subscriptionManager` all need
   `getUnderlying`, `UNDERLYINGS` and `OPTION_EXCHANGES`, which did not exist.
   No SENSEX either.

2. **`utils/blackScholes.js` was never replaced.** Still exporting only
   `{ calculateGreeks, normCDF }`. `impliedVolatility.js` requires
   `theoreticalPrice`, `rawVega` and `yearsToExpiry` from it — all absent.
   The IV solver could not have run.

3. **`utils/normalizeTick.js` was never replaced.** Still discarding market
   depth, bid/ask, circuit limits and average price. The chain would have shown
   permanently empty Bid/Ask columns.

4. **Frontend folder split.** You created
   `client/src/features/optionChains/` (plural) holding `OptionChainTable.jsx`
   and `useOptionChain.js`, while `index.jsx` sat in
   `client/src/features/optionChain/` (singular) importing `'./useOptionChain'`
   and `'./OptionChainTable'`. Both imports resolved to nothing.

5. **`client/src/pages/OptionChainPage.jsx` was missing**, so `App.jsx` imported
   a file that did not exist.

## Everything I changed

**Added**
- `server/src/services/optionChainService.js`
- `server/src/schema.options.sql`
- `client/src/pages/OptionChainPage.jsx`
- `.gitignore`

**Replaced**
- `server/src/constants/instruments.js` — 5 underlyings incl. SENSEX on BFO
- `server/src/utils/blackScholes.js` — 15:30 IST expiry time, solver helpers
- `server/src/utils/normalizeTick.js` — keeps depth, bid/ask, circuits
- `server/src/routes/marketRoutes.js` — see below

**Moved**
- `features/optionChains/*` -> `features/optionChain/`, empty folder removed

**Edited**
- `client/src/components/layout/Sidebar.jsx` line 28 —
  `path: null` -> `path: '/option-chain'`
- `server/.env.example` — documented the three new optional variables

**Deleted**
- `server/.env` — it contained live secrets. See "Do this first" below.
- `server/hash.js` — throwaway script hardcoding the password `admin12345`
- `server/src/utils/optionChainEngine.js` — superseded by `optionChainService`

**Removed fake data**
`marketRoutes.js` contained `fetchRawStrikesStub()` returning a hardcoded spot
of 22000 and an empty strike array. Both endpoints now read the live tick cache
through `optionChainService`. `/api/market/option-chain/:underlying` and
`/api/market/vega-analysis/:underlying` still work and still return the same
shape — they just return real numbers now. `/api/market/indices` returns live
index prices instead of a static string array.

## Verification I ran

- All 30 backend modules load with zero `MODULE_NOT_FOUND`
- All 130 client imports across 50 files resolve to real files
- Server boots and serves `/api/health`
- `/api/options` and `/api/options/NIFTY/chain` return 401 unauthenticated
- `/ws/market` returns 401 without a JWT
- Server survives MySQL being completely down — logs and continues, no crash
- IV solver round-trip: injected a volatility smile, priced every contract from
  it, solved IV back out. Worst error 0.11 vol points across 70 cases.
- Put-call parity holds to Rs 0.02; CE delta + |PE delta| = 1.0 at every strike

## Do this first — your secrets are still exposed

`server/.env` was in the ZIP again with live values. I removed it from this
build, but the originals are still valid until you rotate them:

1. Regenerate your Kite API secret in the developer console
2. New secrets:
   ```
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_SECRET
   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # JWT_REFRESH_SECRET
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # TOKEN_ENCRYPTION_KEY
   ```
   `TOKEN_ENCRYPTION_KEY` must be exactly 64 hex characters.
3. Change your MySQL password
4. `cp server/.env.example server/.env` and fill it in

## To run

```
mysql -u root -p vega_analysis < server/src/schema.options.sql

cd server && npm install && npm run dev
cd client && npm install && npm run dev
```

`node_modules` is not in this ZIP — run `npm install` in both folders.

Expected backend output before anyone connects Zerodha:
```
[DB] MySQL pool connected successfully
[Vega Analysis] API + WebSocket server running on port 5000
[Zerodha] No usable stored session: No active Zerodha session.
[Instruments] Waiting for an admin to connect Zerodha.
```
Those last two lines are normal, not errors.

Then log in at `/admin/login`, click Connect Zerodha, and open Option Chain.

**Set your test user to premium** or you will see "premium required" and no data:
```sql
UPDATE users SET role = 'premium' WHERE email = 'your@email.com';
```
Log out and back in afterwards — the role is baked into the JWT.

## Three columns are blank by design

| Column | Fills when | Why |
|---|---|---|
| OI Change | after the first 15:35 IST capture | Kite ticks carry absolute OI, never a delta |
| IV Percentile | ~20 trading days | It is a rank against a stored series |
| IV/Greeks on deep ITM strikes | never | They trade at pure intrinsic; vega is ~0 so IV is not identifiable. Real terminals blank these too. |

I did not fake these. A confident wrong number is worse than an empty cell.

## Verify these yourself against your Kite account

- Index spot tokens in `constants/instruments.js`, especially SENSEX (`265`).
  A wrong spot token silently poisons every Greek and the ATM highlight.
- SENSEX needs BSE F&O entitlement. Without it `getInstruments('BFO')` fails
  and SENSEX shows no expiries — the service logs and keeps NFO working.
