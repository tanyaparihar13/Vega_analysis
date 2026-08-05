'use strict';

const { TREND } = require('../config/vegaConfig');

/**
 * Bullish / Bearish / Sideways classification — a faithful port of the PHP
 * `datav1.php` sign rules, driven by the two stored Vega DIFFERENCES:
 *
 *   call = call_vega_diff (PHP diff1)     put = put_vega_diff (PHP diff2)
 *
 * PHP rules:
 *   call > 0 && put < 0            -> Bullish
 *   call < 0 && put > 0            -> Bearish
 *   call < 0 && put < 0            -> Sideways, tilted by the stronger side:
 *                                       call > put -> Sideways Bullish
 *                                       call < put -> Sideways Bearish
 *                                       else       -> Sideways
 *   call > 0 && put > 0           -> *** UNHANDLED in PHP *** (no label emitted)
 *
 * Documented handling for the unhandled both-positive case:
 *   Both sides gaining vega is also an indecision / sideways state, so we
 *   mirror the both-negative rule and tilt by the stronger side. This keeps
 *   the green/red intuition consistent and never leaves a point unlabeled:
 *       call > put -> Sideways Bullish,  call < put -> Sideways Bearish,
 *       else       -> Sideways.
 *   Any case with an exact zero on a side (no directional signal) -> Neutral.
 *
 * Returns a { key, label, color } object from vegaConfig.TREND.
 *
 * ---------------------------------------------------------------------------
 * ALWAYS PASS THE *STORED* DIFFS, NEVER THE DISPLAY-SIGNED ONES.
 *
 * vegaConfig.DISPLAY_SIGN negates the three series on the way out so they match
 * StockMojo / Alpha Edge (see vegaTimeseriesService.decorate). The rules below
 * are stated in the ENGINE's convention, where "calls gaining vega while puts
 * lose it" is a rally and therefore Bullish. Handing this function the flipped
 * pair would relabel every rally as Bearish — the opposite of trend parity.
 *
 * decorate() is the only caller and it classifies before flipping. Keep it that
 * way; a second caller that flips first would silently invert every label.
 * ---------------------------------------------------------------------------
 */
function classifyTrend(callVegaDiff, putVegaDiff) {
  const call = Number(callVegaDiff);
  const put = Number(putVegaDiff);
  if (!Number.isFinite(call) || !Number.isFinite(put)) return TREND.NEUTRAL;

  if (call > 0 && put < 0) return TREND.BULLISH;
  if (call < 0 && put > 0) return TREND.BEARISH;

  if (call < 0 && put < 0) {
    if (call > put) return TREND.SIDEWAYS_BULLISH; // less negative call = bullish tilt
    if (call < put) return TREND.SIDEWAYS_BEARISH;
    return TREND.SIDEWAYS;
  }

  if (call > 0 && put > 0) {
    // PHP's unhandled branch — mirror the both-negative logic.
    if (call > put) return TREND.SIDEWAYS_BULLISH;
    if (call < put) return TREND.SIDEWAYS_BEARISH;
    return TREND.SIDEWAYS;
  }

  return TREND.NEUTRAL; // an exact zero on one side: no directional signal
}

module.exports = { classifyTrend };
