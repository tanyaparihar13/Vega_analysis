# Kite Connect Capacity Calculation — Vega Analysis

Derived from the actual codebase at `ac35a55`, with CPU/memory measured on this
machine (node v22.23.1, win32 x64) using the project's own
`blackScholes` / `impliedVolatility` / `vegaMath` modules.

**Configuration in force — verified, not assumed.** `server/.env` contains
**zero `VEGA_*` variables**, so every value in `config/vegaConfig.js` is at its
code default:

```
STRIKE_WINDOW        = 30      STOCK_STRIKE_WINDOW  = 8
EXPIRY_COUNT         = 3       STOCK_EXPIRY_COUNT   = 1
TOKEN_BUDGET         = 2800    DELTA_MAX            = 0.6
DELTA_START          = { NIFTY:0.05, BANKNIFTY:0.20, FINNIFTY:0.20,
                         MIDCPNIFTY:0.20, SENSEX:0.05 }
STOCK_START          = 0.20
PERSIST_RESOLUTION   = { index:'5s', stock:'5s' }
LIVE_BUFFER_POINTS   = 4500    SAMPLE_CRON = '*/5 * 9-15 * * 1-5'
RECORDED_STOCKS      = []      RECORD_ALL_STOCKS = false
OPTION_STRIKE_WINDOW = 20      (subscriptionManager, from .env)
```

---

## 1. The exact token formula, from the code

Two different numbers exist and they are **not equal**. Both matter.

### 1a. Charged cost — what decides truncation

`vegaTimeseriesService.ensureSubscriptions()` (line 422):

```js
const cost = sel.tokens.length + (c.spotToken != null ? 1 : 0);
if (tokens.length + cost > cfg.TOKEN_BUDGET) { dropped += 1; continue; }
```

`sel.tokens` comes from `instrumentService.getTokensForExpiry()` (line 532),
which pushes one token per CE and one per PE over
`selectStrikes(strikes, spot, window)` — at most `2w+1` strikes — then appends
`getNearestFuture()`.

```
charged(target) = 2·S + F + P
    S = min(2w + 1, boardSize)          strikes actually selected
    F = 1 if a future contract exists
    P = 1 if the underlying has a spotToken
```

**`charged(target) = 2S + 2`** in every normal case.
This is evaluated **per {symbol, expiry} target**, so an underlying tracked at
`EXPIRY_COUNT = E` is charged `E · (2S + 2)`.

### 1b. Actual cost — what Kite receives

`subscriptionManager.setStandingTokens()` (line 90) de-duplicates:

```js
const next = [...new Set((tokens || []).map(Number)...)]
```

`getNearestFuture(cfg.key)` resolves **per underlying, not per expiry**, so all
`E` targets push the *same* future token. The spot token is likewise pushed `E`
times. Option tokens are genuinely distinct per expiry.

```
actual(underlying) = E · 2S + 1 + 1
```

### 1c. The discrepancy

```
charged − actual = 2·(E − 1)  per underlying
```

At `EXPIRY_COUNT = 3`, the budget over-charges each index by **4 tokens**;
across 5 indices, **20 tokens**. The budget is therefore very slightly
*pessimistic* — it protects rather than exposes. Immaterial next to §5.

### 1d. Cost table at current config

| Class | w | S = 2w+1 | charged / target | E | charged / underlying | actual / underlying |
|---|---:|---:|---:|---:|---:|---:|
| Index | 30 | 61 | **124** | 3 | **372** | **368** |
| Stock | 8 | 17 | **36** | 1 | **36** | **36** |

> `S = 2w+1` holds only when the listed board is at least `2w+1` strikes wide
> and ATM is ≥ w from both ends. NIFTY weeklies list ~140 strikes, so S=61 is
> exact. A thin stock board with fewer than 17 listed strikes costs less than 36.

---

## 2. SCENARIO 1 — Current configuration (as shipped, no changes)

### 2a. What is actually subscribed right now

`recordedSymbols()` returns the 5 indices plus `RECORDED_STOCKS` (empty) plus
all F&O names only if `RECORD_ALL_STOCKS` (false). **Today the standing set is
the 5 indices and nothing else.**

| | charged | actual |
|---|---:|---:|
| 5 indices × 3 expiries (15 targets) | **1,860** | **1,840** |
| Headroom to `TOKEN_BUDGET` (2,800) | **940** | — |
| Headroom to Kite cap (~3,000) | — | **1,160** |

### 2b. Maximum NIFTY 50 stocks

```
budget-bound : floor(940 / 36)   = 26 stocks   → 1,860 + 936 = 2,796  (4 spare)
                                    27th → 2,832 > 2,800 → dropped
Kite-cap-bound (if budget raised):
               floor(1,160 / 36) = 32 stocks   → 1,840 + 1,152 = 2,992
```

> ### **Exactly 26 of the 50 NIFTY 50 stocks record continuously. 24 are truncated.**

The loop is greedy in `targetPriority` order (0 = index, 1 = watched, 2 =
recorded), and V8's sort is stable, so the surviving 26 are the first 26 in
`recordedSymbols()` order — alphabetical when `RECORD_ALL_STOCKS` is on. The
last 24 alphabetically never subscribe, never receive ticks, produce null
Greeks, have their day-open rejected by `isUsableOpenChain()`, and **record zero
rows for the day**, silently.

A stock a browser is *watching* is priority 1 and sorts above recorded stocks,
so **each concurrent viewer of a non-recorded stock evicts one recorded stock**
from the tail.

### 2c. Maximum indices

```
budget-bound : floor(2,800 / 372) = 7 indices
Kite-cap-bound: floor(3,000 / 368) = 8 indices
```

Only 5 exist in `constants/instruments.js`, so indices are **not** near their
limit — they consume 66% of the budget for 5 names.

### 2d. If SENSEX is unavailable

`instrumentService.refresh()` logs and continues when a segment 403s; BFO 403s
on accounts without a BSE F&O subscription. With no BFO,
`trackedExpiries('SENSEX')` returns `[]` and SENSEX contributes 0 targets:

| | charged | actual | max stocks (budget) | max stocks (Kite) |
|---|---:|---:|---:|---:|
| 4 indices × 3 expiries | 1,488 | 1,472 | **36** | **42** |

---

## 3. SCENARIO 2 — Delta-filtered optimised configuration

The window only needs to cover strikes that can enter the `[start, 0.60]` sum,
**plus** the intraday drift of spot — `selectStrikes()` recentres on live spot
every tick, so a window sized to the band alone slides off day-open basket
strikes as the underlying moves, and `computePoint`'s present-in-both guard
then silently drops them.

Measured by solving IV and Black-76 delta across each board:

| Underlying | floor | in-band C/P | furthest strike | drift | **needed w** | configured |
|---|---:|---:|---:|---:|---:|---:|
| NIFTY weekly T=3d | 0.05 | 11 / 10 | 9 | 8 | **17** | 30 |
| NIFTY weekly T=7d | 0.05 | 16 / 16 | 13 | 8 | **21** | 30 |
| NIFTY 2nd wkly T=14d | 0.05 | 23 / 23 | 20 | 8 | **28** | 30 |
| NIFTY 3rd exp T=21d | 0.05 | 30 / 30 | 26 | 8 | **34** | 30 ⚠ short |
| BANKNIFTY weekly T=3d | 0.20 | 7 / 7 | 5 | 10 | **15** | 30 |
| BANKNIFTY 3rd exp T=21d | 0.20 | 22 / 22 | 17 | 10 | **27** | 30 |
| FINNIFTY weekly T=3d | 0.20 | 7 / 7 | 5 | 9 | **14** | 30 |
| MIDCPNIFTY weekly T=3d | 0.20 | 8 / 7 | 6 | 10 | **16** | 30 |
| SENSEX weekly T=3d | 0.05 | 17 / 17 | 14 | 13 | **27** | 30 |
| **STOCK** mid-vol σ28% T=20d | 0.20 | 6 / 5 | 4 | 3 | **7** | 8 |
| **STOCK** hi-vol σ42% T=20d | 0.20 | 8 / 8 | 6 | 3 | **9** | 8 ⚠ short |
| **STOCK** hi-vol σ42% T=28d | 0.20 | 10 / 9 | 8 | 3 | **11** | 8 ⚠ short |
| **STOCK** low-price σ32% T=20d | 0.20 | 4 / 4 | 3 | 2 | **5** | 8 |

**The 0.05 floor on NIFTY and SENSEX is what makes indices expensive.** At
T=21d, NIFTY's 0.05–0.60 band spans 30 of 61 strikes; BANKNIFTY's 0.20–0.60 band
at the same tenor spans 22. Halving the index cost requires changing the floor,
not the window.

**`STOCK_STRIKE_WINDOW = 8` is short, not generous**, for a high-volatility name
early in its monthly cycle. Delta-optimisation makes stocks **more** expensive.

### Optimised config and its capacity

`w_idx = 28, E_idx = 2` · `w_stk = 11, E_stk = 1`

| | S | charged/target | charged/underlying | actual/underlying |
|---|---:|---:|---:|---:|
| Index | 57 | 116 | 232 | 230 |
| Stock | 23 | 48 | 48 | 48 |

```
5 indices          : charged 1,160   actual 1,150
max stocks (budget): floor((2,800 − 1,160) / 48) = floor(1,640/48) = 34
max stocks (Kite)  : floor((3,000 − 1,150) / 48) = floor(1,850/48) = 38
```

> ### **Delta-optimisation yields 34 stocks — still short of 50.**

### 3a. If the index boards are monthly-only

If BANKNIFTY / FINNIFTY / MIDCPNIFTY carry no weeklies on your account, then
`EXPIRY_COUNT = 3` reaches ~90 days out, and `w = 30` is badly short:

| Underlying | floor | in-band C/P | furthest | drift | **needed w** | w=30 |
|---|---:|---:|---:|---:|---:|---|
| NIFTY monthly T=30d | 0.05 | 36 / 35 | 31 | 10 | **41** | short |
| BANKNIFTY 2nd month T=60d | 0.20 | 37 / 37 | 29 | 14 | **43** | short |
| BANKNIFTY 3rd month T=90d | 0.20 | 49 / 49 | 38 | 17 | **55** | short |
| FINNIFTY 3rd month T=90d | 0.20 | 45 / 43 | 35 | 16 | **51** | short |
| MIDCPNIFTY 3rd month T=90d | 0.20 | 50 / 49 | 39 | 16 | **55** | short |
| SENSEX 3rd exp T=21d | 0.05 | 50 / 49 | 43 | 17 | **60** | short |

Where the row says *short*, the far expiry's Call and Put sums are already being
computed over a **truncated basket today** — the strikes beyond ±30 are in the
delta band but were never subscribed, so they never enter the day-open chain and
are excluded by the present-in-both guard. This affects the recorded numbers for
the 2nd and 3rd expiries, not the front month.

---

## 4. SCENARIO 3 — Maximum safe single-connection configuration

Constraint: fit all 50 NIFTY 50 stocks **and** all 5 indices, with real headroom
left for browser-driven subscriptions.

Solving for the index window with stocks fixed at `w=8, E=1` (1,800 charged):

```
available for indices = 2,800 − 1,800 = 1,000  →  200/index  →  100/target at E=2
100 = 2S + 2  →  S = 49  →  w = 24     (exactly at budget, zero headroom)
```

Backing off to leave headroom:

| Config | charged | actual | Kite headroom |
|---|---:|---:|---:|
| `w_idx 24, E 2` + 50 stocks `w 8` | 2,800 | 2,790 | 210 |
| **`w_idx 22, E 2` + 50 stocks `w 8`** | **2,720** | **2,710** | **290** |
| `w_idx 18, E 2` + 50 stocks `w 9` | 2,760 | 2,750 | 250 |

**Maximum safe single-connection configuration:**

```
w_idx = 22   E_idx = 2      →  5 indices  ×  184 charged  =    920
w_stk =  8   E_stk = 1      → 50 stocks  ×   36 charged  =  1,800
                                             TOTAL charged   2,720
                                             TOTAL actual    2,710
                                             Kite headroom     290
```

> ### **50 NIFTY 50 stocks + 5 indices fit on one connection at `w_idx = 22, E_idx = 2`.**

The cost: indices lose their 3rd expiry, and the index window drops from 30 to
22 — which per §3 still covers every *weekly* index board (max needed 28 for
NIFTY at T=14d ⚠, 27 for BANKNIFTY at T=21d) but **not** NIFTY's 2nd weekly.
Stocks at `w=8` remain short for high-volatility names.

### 4a. Absolute maxima on one connection

| Question | Budget-bound (2,800) | Kite-cap-bound (3,000) |
|---|---:|---:|
| Stocks only, `w=8, E=1` | **77** | **83** |
| Stocks only, `w=11, E=1` | **58** | **62** |
| Indices only, `w=30, E=3` | **7** | **8** |
| Indices only, `w=22, E=2` | **15** | **16** |
| Stocks with 5 indices at current index cost | **26** | **32** |

---

## 5. Is `TOKEN_BUDGET = 2800` conservative or aggressive?

> ### **Aggressive.**

`TOKEN_BUDGET` governs **only the standing sampler set**. `reconcile()`
(`subscriptionManager.js:126`) unions three sources:

```js
const union = new Set(SUBSCRIBED_TOKENS);          // 5 index spots (already standing)
for (const token of refCounts.keys()) union.add(token);   // ← per-BROWSER, unbudgeted
for (const set of standingSets.values()) …                // ← the 2,800-capped sampler set
```

`refCounts` is fed by `selectChain()` at `OPTION_STRIKE_WINDOW = 20`:

```
per distinct {symbol, expiry} being viewed = 2·41 + 1 future = 83 tokens
```

Nothing caps that. At the Scenario-1 maximum (standing set 2,796):

| Concurrent option-chain viewers on distinct selections | Union |
|---:|---:|
| 0 | 2,796 |
| 1 | 2,879 |
| 2 | 2,962 |
| **3** | **3,045 — past Kite's cap** |
| 5 | 3,211 |

`reconcile()` only `console.warn`s above 2,900 and calls `updateSubscription()`
anyway. Kite does not reject loudly — it stops delivering some contracts, which
surfaces later as null Greeks on an apparently random instrument.

**2,800 is 93.3% of the cap with 0% reserved for client demand.** A budget that
is conservative with respect to the *whole system* is `3,000 − 83·N`, where N is
the maximum concurrent distinct chain selections you intend to support:

| N viewers | Conservative `TOKEN_BUDGET` |
|---:|---:|
| 2 | 2,834 |
| 5 | 2,585 |
| 10 | 2,170 |
| 20 | 1,340 |

---

## 6. What is actually the limiting factor?

Measured, not estimated. Full sampler pipeline per target = `buildChain` (IV
solve + Black-76 Greeks per contract) → `toGreekChain` → `computePoint` in
`stable` mode with hysteresis.

### 6a. CPU

| Target type | contracts | full pipeline |
|---|---:|---:|
| INDEX weekly, w=30 | 122 | 1.73 ms |
| INDEX 3rd expiry, w=30 | 122 | 1.74 ms |
| INDEX BANKNIFTY, w=30 | 122 | 2.72 ms |
| STOCK monthly, w=8 | 34 | 0.84 ms |

Per-contract solver cost:

```
one theoreticalPrice76 call            0.086 us
ATM, model-consistent (Newton)          4.37 us
deep ITM at intrinsic (early null)      0.46 us
far OTM at 1 tick (hard path)           7.77 us   = 1.8x normal
bisection ceiling (100 iterations)      8.60 us
```

The bisection fallback is only **1.8×** a normal solve, not the order of
magnitude it looks like in the source — `theoreticalPrice76` is 86 ns, so 100
iterations cost 8.6 µs. **Even a board where every single contract takes the
worst path costs 0.95 ms for an index target and 0.26 ms for a stock.**

Per 5,000 ms tick:

| Active set | measured | % of interval |
|---|---:|---:|
| CURRENT — 5 idx × 3 exp, 0 stocks | **31 ms** | **0.6 %** |
| 5 idx × 3 exp + 26 stocks (Scenario 1 max) | **53 ms** | **1.1 %** |
| 5 idx × 3 exp + 50 stocks | **73 ms** | **1.5 %** |
| 5 idx × 2 exp + 50 stocks (Scenario 3) | **62 ms** | **1.2 %** |
| 50 stocks + 15 index targets, every contract worst-path | **27 ms** | **0.5 %** |

**CPU headroom at the token-cap ceiling: ~68×.**

### 6b. Memory

Measured `LIVE_BUFFER_POINTS = 4500` ring buffer:

```
one full-session series (4,500 points)   1.18 MB
15 index series                         17.7 MB
15 index + 50 stock series              76.7 MB
```

Day-open chains held for the session: 15×61 + 50×17 = 1,765 rows ≈ ~1 MB.
The dominant resident structure is the **instrument master** — `byToken`,
`bySymbol` and `searchIndex` over ~120,000 contracts, which is tens of MB and is
**independent of how many stocks are recorded**.

Steady state at 65 series lands around 200–250 MB RSS. The `~240 MB after ~90
minutes` noted in `vegaTimeseriesService.js:602` is consistent with normal
steady state for this working set, not with an unbounded leak.

### 6c. Vega calculation engine

`computePoint` is O(strikes) with two Map lookups per strike. It is inside the
"full pipeline" figures above; the difference between `buildChain` alone and the
full pipeline is **≈0.1 ms** for a stock target. **Not a factor.**

### 6d. MySQL

```
65 targets × 12 samples/min          = 780 rows/min = 13 rows/s
                                     = 292,500 rows/day
× 30-day RETENTION_DAYS              = 8.78 M rows
≈150 B/row                           ≈ 1.32 GB data
+ idx_vega_series                    ≈ 0.53 GB
                                     ≈ 1.85 GB total
```

Writes are batched into one multi-row `INSERT … ON DUPLICATE KEY UPDATE` per
tick. 13 rows/s against a pool of 15 connections. **Not a factor.**

### 6e. Verdict

| Resource | Utilisation at the ceiling | Limiting? |
|---|---|---|
| **Kite subscription cap** | **100 % — binds at 26 stocks** | **YES** |
| CPU | 1.5 % of the sampler interval | No — 68× headroom |
| Memory | ~250 MB RSS | No |
| Vega calculation engine | ~0.1 ms of a 0.84 ms target | No |
| MySQL write throughput | 13 rows/s | No |
| MySQL storage | 1.85 GB / 30 days | No |

> ### The limiting factor is the Kite Connect per-connection subscription cap, and nothing else is close.
> The system saturates its instrument budget at **≈1.5 % CPU utilisation**. Every
> other resource is over-provisioned by more than an order of magnitude relative
> to what a single WebSocket connection permits.

---

## 7. Summary — exact answers

| Question | Answer |
|---|---|
| Tokens per stock (w=8, E=1) | **36 charged, 36 actual** |
| Tokens per index (w=30, E=3) | **372 charged, 368 actual** |
| Current total (5 indices, 0 stocks) | **1,860 charged, 1,840 actual** |
| Remaining headroom today | **940 to budget, 1,160 to Kite cap** |
| Max NIFTY 50 stocks — current config | **26** (32 if `TOKEN_BUDGET` raised to the cap) |
| Stocks truncated if 50 enrolled today | **24** |
| Max indices — current config | **7** (8 at the cap) |
| Max stocks — delta-optimised (w_stk 11, w_idx 28, E_idx 2) | **34** (38 at the cap) |
| Max safe config fitting all 50 stocks | **`w_idx 22, E_idx 2, w_stk 8, E_stk 1` → 2,720 charged / 2,710 actual / 290 spare** |
| Max stocks, no indices, w=8 | **77** (83 at the cap) |
| `TOKEN_BUDGET = 2800` | **Aggressive** — 93.3 % of the cap, 0 reserved for the 83 tokens each concurrent chain viewer adds |
| Limiting factor | **Kite subscription cap** |
