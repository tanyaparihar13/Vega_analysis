'use strict';

/**
 * vegaMath — the ONE place the Call/Put/Difference Vega numbers are computed.
 *
 * This is a faithful port of the arithmetic in AlphaEdge/Upstox `addvega.php`,
 * kept completely dependency-free (no db, no cron, no config) so it can be
 * unit-tested in isolation and reused by every caller. vegaTimeseriesService
 * builds the chains and persists the results; the actual sums live here.
 *
 * ---------------------------------------------------------------------------
 * addvega.php, reproduced:
 *   1. Walk the CURRENT chain. Keep a strike's CALL side if
 *        abs(callDelta) in [start, deltaMax];  independently keep its PUT side
 *        if abs(putDelta) in [start, deltaMax]. Two independent strike lists.
 *   2. currentCallVega = sum of call vega over the call list (current chain)
 *      currentPutVega  = sum of put  vega over the put  list (current chain)
 *   3. openCallVega / openPutVega = sum of the DAY-OPEN chain's vega over the
 *      SAME two lists (PHP's in_array on strikeprice1/strikeprice2).
 *   4. diff1 = currentCallVega - openCallVega   (Call Vega)
 *      diff2 = currentPutVega  - openPutVega    (Put  Vega)
 *      diff3 = diff2 - diff1                     (Difference)
 * ---------------------------------------------------------------------------
 *
 * Difference from PHP, deliberate and documented:
 *   PHP always had Upstox's FULL chain at both open and now, so every current
 *   strike also existed in the open chain. Our chain is a finite window around
 *   ATM, so a strike selected now might not exist in the open snapshot. To keep
 *   the difference measured on the SAME contracts at both times, a strike
 *   contributes to the sums only if it is present in BOTH the current and the
 *   open chain. With a wide enough STRIKE_WINDOW this guard almost never fires;
 *   when it does, it prevents a spurious diff spike from a baseline-less strike.
 *
 * ---------------------------------------------------------------------------
 * FIX 1 (strike-key type mismatch):
 *   PHP's in_array() does loose ('==') comparison, so "23500" and 23500 always
 *   matched. JS Map keys use strict (===) equality. If the current chain and
 *   the day-open chain ever disagree on the strike's type (fresh build vs a
 *   DB round-trip through JSON, or an upstream API that isn't 100% consistent
 *   about number vs string), every single lookup silently misses and every
 *   diff comes out as 0.00. indexByStrike/pickStrikes now normalize every
 *   strike through Number() so the keys always compare equal regardless of
 *   how they arrived.
 *
 * FIX 2 (null greeks silently treated as 0):
 *   utils/impliedVolatility.js deliberately returns null (not 0) when IV can't
 *   be solved with confidence (thin liquidity, near-intrinsic price, vega too
 *   small to be identifiable) — this happens disproportionately often right
 *   at 09:16 when the day-open baseline is captured, since liquidity hasn't
 *   built up yet. Previously, `num()` coerced any such null straight to 0
 *   before summing, which silently told the calculation "this strike's vega
 *   was 0 at day-open" when the truth was "we don't know". Since current-day
 *   vega for the same strike solves fine once the market matures, that turned
 *   into current(full) - open(fabricated 0) = artificially POSITIVE, when
 *   vega decaying through the day should make the diff negative. Now, a
 *   strike is only included in a side's sum if BOTH the current AND the
 *   open-chain vega for that side are real numbers; if either is null, that
 *   strike is skipped entirely for that side (not zero-filled), matching what
 *   PHP always had implicitly (Upstox never returned null greeks).
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** True only for a genuine, usable number — used to gate sums (FIX 2). */
function isReal(v) {
  return v != null && Number.isFinite(Number(v));
}

function round(v) {
  return Number(num(v).toFixed(4));
}

/** Normalize a strike to a consistent Number key (FIX 1). */
function strikeKey(v) {
  return Number(v);
}

/** PHP: abs(delta) >= start && abs(delta) <= deltaMax */
function passes(delta, start, deltaMax) {
  if (delta == null) return false;
  const d = Math.abs(Number(delta));
  return Number.isFinite(d) && d >= start && d <= deltaMax;
}

/**
 * Build the two independent strike lists from a chain, using abs(delta).
 * Strikes are normalized to Number so downstream Map lookups always match,
 * regardless of what type the source chain used (FIX 1).
 * @returns {{callStrikes:number[], putStrikes:number[]}}
 */
function pickStrikes(chain, start, deltaMax) {
  const callStrikes = [];
  const putStrikes = [];
  for (const row of chain) {
    const strike = strikeKey(row.strike);
    if (passes(row.call?.delta, start, deltaMax)) callStrikes.push(strike);
    if (passes(row.put?.delta, start, deltaMax)) putStrikes.push(strike);
  }
  return { callStrikes, putStrikes };
}

/** Keys are normalized through strikeKey() so current/open chains always align (FIX 1). */
function indexByStrike(chain) {
  const m = new Map();
  for (const row of chain) m.set(strikeKey(row.strike), row);
  return m;
}

/**
 * STABLE MODE (parity item 6) — the day-open basket, with a hysteresis exit.
 *
 * The problem with 'dynamic' is not that it is wrong; it is that it changes the
 * QUESTION every sample. Recomputing the [start, deltaMax] band from the current
 * chain means a strike whose delta wanders across a boundary is added to (or
 * removed from) the sum between one tick and the next, and a whole contract's
 * vega enters or leaves the total in one step. Around ATM, where deltas move
 * fastest and vega is largest, that produces a per-tick sawtooth that is an
 * artefact of the selection rather than a move in the market.
 *
 * Stable mode fixes the basket at what was eligible AT DAY-OPEN, so the sums are
 * measured on the SAME contracts all session and the curve reflects vega
 * actually changing. The one thing it still has to handle is a genuine trend: if
 * the underlying runs far enough that a strike is now deep ITM, keeping it makes
 * the total meaningless. So a strike is retained only while its CURRENT delta is
 * inside the band widened by `hysteresis` at both ends, and dropped once it
 * leaves. The margin is what stops a strike sitting on the boundary from
 * flickering — which would reintroduce exactly the noise being removed.
 *
 * Nothing is ever ADMITTED mid-session. Admission is what makes a basket
 * unstable, and the day-open basket is the reference the whole calculation is
 * defined against.
 *
 * @param {Array}    currentChain  rows as built this sample
 * @param {number[]} openStrikes   the day-open eligible list for ONE side
 * @param {'call'|'put'} side
 * @param {number}   start         delta floor
 * @param {number}   deltaMax      delta ceiling
 * @param {number}   hysteresis    margin added to both ends, for RETENTION only
 * @returns {number[]} the surviving strikes, normalized to Number keys
 */
function retainStable(currentChain, openStrikes, side, start, deltaMax, hysteresis = 0) {
  const cur = indexByStrike(currentChain);
  const lo = Math.max(0, start - hysteresis);
  const hi = deltaMax + hysteresis;

  const out = [];
  for (const raw of openStrikes || []) {
    const k = strikeKey(raw);
    const row = cur.get(k);
    // A strike that is not on today's board at all cannot be evaluated here. It
    // is removed by the present-in-both guard in computePoint anyway, so keeping
    // it costs nothing and avoids a second, differently-behaved filter.
    if (!row) { out.push(k); continue; }
    const d = row[side]?.delta;
    // An unsolvable delta is not evidence that the strike has left the band.
    // Keep it — the vega guard in computePoint will skip it for this sample if
    // its vega is unusable too, which is the correct, narrower response.
    if (d == null || !Number.isFinite(Number(d))) { out.push(k); continue; }
    const abs = Math.abs(Number(d));
    if (abs >= lo && abs <= hi) out.push(k);
  }
  return out;
}

/**
 * The whole calculation for one minute.
 *
 * @param {object}   args
 * @param {Array}    args.currentChain  current chain rows [{strike, call:{...}, put:{...}}]
 * @param {Array}    args.openChain      day-open chain rows, same shape
 * @param {number}   args.start          per-underlying delta floor
 * @param {number}   args.deltaMax       delta ceiling (0.6)
 * @param {'stable'|'dynamic'|'frozen'} args.mode
 * @param {{callStrikes:number[], putStrikes:number[]}} [args.frozenStrikes]
 *        required when mode === 'frozen' or 'stable'
 * @param {number} [args.hysteresis] retention margin for 'stable'
 * @returns full point payload (diffs, totals, strike lists + counts)
 */
function computePoint({
  currentChain, openChain, start, deltaMax,
  mode = 'dynamic', frozenStrikes = null, hysteresis = 0,
}) {
  const curMap = indexByStrike(currentChain);
  const openMap = indexByStrike(openChain);

  let callStrikes;
  let putStrikes;
  if (mode === 'frozen' && frozenStrikes) {
    callStrikes = (frozenStrikes.callStrikes || []).map(strikeKey);
    putStrikes = (frozenStrikes.putStrikes || []).map(strikeKey);
  } else if (mode === 'stable' && frozenStrikes) {
    // Day-open basket + hysteresis exit. See retainStable().
    callStrikes = retainStable(currentChain, frozenStrikes.callStrikes, 'call', start, deltaMax, hysteresis);
    putStrikes = retainStable(currentChain, frozenStrikes.putStrikes, 'put', start, deltaMax, hysteresis);
  } else {
    // DYNAMIC: recompute the band from the CURRENT chain each call (addvega.php
    // literal). Also the fallback when a stable/frozen run has no day-open
    // basket yet — better a noisier point than no point at all.
    ({ callStrikes, putStrikes } = pickStrikes(currentChain, start, deltaMax));
  }

  let curCallVega = 0;
  let openCallVega = 0;
  let callCount = 0;
  for (const k of callStrikes) {
    const c = curMap.get(k);
    const o = openMap.get(k);
    if (!c || !o) continue; // present-in-both guard (see header note)
    // FIX 2: skip (don't zero-fill) if either side's vega wasn't solvable.
    if (!isReal(c.call?.vega) || !isReal(o.call?.vega)) continue;
    curCallVega += num(c.call.vega);
    openCallVega += num(o.call.vega);
    callCount += 1;
  }

  let curPutVega = 0;
  let openPutVega = 0;
  let putCount = 0;
  for (const k of putStrikes) {
    const c = curMap.get(k);
    const o = openMap.get(k);
    if (!c || !o) continue;
    // FIX 2: skip (don't zero-fill) if either side's vega wasn't solvable.
    if (!isReal(c.put?.vega) || !isReal(o.put?.vega)) continue;
    curPutVega += num(c.put.vega);
    openPutVega += num(o.put.vega);
    putCount += 1;
  }

  const callVegaDiff = round(curCallVega - openCallVega); // diff1
  const putVegaDiff = round(curPutVega - openPutVega); // diff2
  const vegaDiff = round(putVegaDiff - callVegaDiff); // diff3 = diff2 - diff1

  return {
    callVegaDiff,
    putVegaDiff,
    vegaDiff,
    currentCallVega: round(curCallVega),
    currentPutVega: round(curPutVega),
    openCallVega: round(openCallVega),
    openPutVega: round(openPutVega),
    callStrikeCount: callCount,
    putStrikeCount: putCount,
    callStrikes,
    putStrikes,
  };
}

module.exports = {
  passes, pickStrikes, retainStable, computePoint, indexByStrike, round, num, isReal,
};