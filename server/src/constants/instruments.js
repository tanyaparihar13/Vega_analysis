/**
 * Single source of truth for the indices we stream and build chains for.
 *
 * NOTE ON SPOT TOKENS: these are Kite's index instrument tokens. They are
 * stable, but verify them once against `kc.getInstruments('NSE')` /
 * `('BSE')` on your own account rather than trusting them blindly — a wrong
 * token here means the chain renders with a silently wrong spot, which
 * poisons every Greek and the ATM highlight.
 *
 * NOTE ON SENSEX: it trades on BSE, so its options live in the BFO segment,
 * not NFO. Anything that fetches instruments must branch on `optionExchange`.
 */

const UNDERLYINGS = {
  NIFTY: {
    key: 'NIFTY',
    label: 'NIFTY',
    // `name` as it appears in the instrument master for its option contracts
    instrumentName: 'NIFTY',
    spotToken: 256265,
    spotSymbol: 'NIFTY 50',
    spotExchange: 'NSE',
    optionExchange: 'NFO',
    strikeStep: 50,
    lotSize: 75,
  },
  BANKNIFTY: {
    key: 'BANKNIFTY',
    label: 'BANKNIFTY',
    instrumentName: 'BANKNIFTY',
    spotToken: 260105,
    spotSymbol: 'NIFTY BANK',
    spotExchange: 'NSE',
    optionExchange: 'NFO',
    strikeStep: 100,
    lotSize: 30,
  },
  FINNIFTY: {
    key: 'FINNIFTY',
    label: 'FINNIFTY',
    instrumentName: 'FINNIFTY',
    spotToken: 257801,
    spotSymbol: 'NIFTY FIN SERVICE',
    spotExchange: 'NSE',
    optionExchange: 'NFO',
    strikeStep: 50,
    lotSize: 65,
  },
  MIDCPNIFTY: {
    key: 'MIDCPNIFTY',
    label: 'MIDCPNIFTY',
    instrumentName: 'MIDCPNIFTY',
    spotToken: 288009,
    spotSymbol: 'NIFTY MID SELECT',
    spotExchange: 'NSE',
    optionExchange: 'NFO',
    strikeStep: 25,
    lotSize: 120,
  },
  SENSEX: {
    key: 'SENSEX',
    label: 'SENSEX',
    instrumentName: 'SENSEX',
    spotToken: 265,
    spotSymbol: 'SENSEX',
    spotExchange: 'BSE',
    optionExchange: 'BFO',
    strikeStep: 100,
    lotSize: 20,
  },
};

// Lot sizes change by exchange circular. They are used only for display; the
// chain itself never trades, so a stale value is cosmetic.

const INDEX_TOKENS = Object.fromEntries(
  Object.values(UNDERLYINGS).map((u) => [u.spotSymbol, u.spotToken])
);

const TOKEN_TO_SYMBOL = Object.fromEntries(
  Object.values(UNDERLYINGS).map((u) => [u.spotToken, u.spotSymbol])
);

// Spot tokens are always subscribed — the chain needs a live spot at all times.
const SUBSCRIBED_TOKENS = Object.values(UNDERLYINGS).map((u) => u.spotToken);

const OPTION_EXCHANGES = [...new Set(Object.values(UNDERLYINGS).map((u) => u.optionExchange))];

function getUnderlying(symbol) {
  if (!symbol) return null;
  return UNDERLYINGS[String(symbol).toUpperCase()] || null;
}

function listUnderlyings() {
  return Object.values(UNDERLYINGS).map(({ key, label, strikeStep, lotSize, spotSymbol }) => ({
    key, label, strikeStep, lotSize, spotSymbol,
  }));
}

module.exports = {
  UNDERLYINGS,
  INDEX_TOKENS,
  TOKEN_TO_SYMBOL,
  SUBSCRIBED_TOKENS,
  OPTION_EXCHANGES,
  getUnderlying,
  listUnderlyings,
};
