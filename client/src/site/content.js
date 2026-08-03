import {
  TbChartHistogram, TbListDetails, TbMathFunction, TbClockHour4,
  TbBolt, TbShieldCheck, TbCalendarStats, TbDeviceAnalytics,
} from 'react-icons/tb';

/**
 * Copy for the public site, in one place so Home and Features cannot drift.
 *
 * EVERY CLAIM HERE IS SOMETHING THE CODEBASE ACTUALLY DOES. The original
 * template this site was built from advertised sub-10ms execution, copy
 * trading, forex, crypto, 2.4M users and a 99.98% uptime figure — none of
 * which exist in this product, and most of which would be regulated claims.
 * If a line below stops being true, delete it rather than soften it.
 */

export const FEATURES = [
  {
    icon: TbChartHistogram,
    title: 'Live Vega Analysis',
    body:
      'Call Vega, Put Vega and their Difference recomputed every market minute against a '
      + 'frozen day-open baseline, with a Bullish / Bearish / Sideways read on every point.',
  },
  {
    icon: TbClockHour4,
    title: 'Automatic Historical Recording',
    body:
      'Every trading minute between 09:15 and 15:30 IST is sampled and stored automatically. '
      + 'History builds itself from your own live feed — nothing is imported.',
  },
  {
    icon: TbCalendarStats,
    title: 'Replay Any Past Session',
    body:
      'Pick a stored trading day and the chart and the time-wise table replay it exactly, '
      + 'at 1, 3, 5 or 15 minute resolution.',
  },
  {
    icon: TbListDetails,
    title: 'Real-time Option Chain',
    body:
      'The full CE/PE board streamed over WebSocket — LTP, open interest and OI change, '
      + 'volume, bid/ask and five-level market depth.',
  },
  {
    icon: TbMathFunction,
    title: 'Accurate Greeks',
    body:
      'Delta, Gamma, Theta, Vega and implied volatility solved with Black-76 against the '
      + 'futures forward — the way Indian index options are actually priced.',
  },
  {
    icon: TbBolt,
    title: 'Direct Zerodha Feed',
    body:
      'Powered by a Zerodha Kite Connect session. No third-party data resellers and no '
      + 'delayed vendor snapshots inside the terminal.',
  },
  {
    icon: TbDeviceAnalytics,
    title: 'Five Index Underlyings',
    body:
      'NIFTY, BANKNIFTY, FINNIFTY and MIDCPNIFTY on NSE, plus SENSEX on BSE — each with its '
      + 'own delta band and strike step.',
  },
  {
    icon: TbShieldCheck,
    title: 'Approved Access Only',
    body:
      'Every account is reviewed by an administrator before it can sign in, so access to the '
      + 'terminal stays with people you know.',
  },
];

/** Facts about how the platform runs. Each maps to a real setting in the server. */
export const PLATFORM_FACTS = [
  { value: '5', label: 'Index underlyings' },
  { value: '1 min', label: 'Recording interval' },
  { value: '09:15–15:30', label: 'IST trading window' },
  { value: '90 days', label: 'History retained' },
];

/** The steps a new user actually goes through. Mirrors the real approval flow. */
export const ACCESS_STEPS = [
  {
    n: 1,
    title: 'Register',
    body: 'Create your account with your name, email, mobile number and demat broker.',
  },
  {
    n: 2,
    title: 'Send the request',
    body: 'WhatsApp opens with your details prefilled. Press Send to reach the administrator.',
  },
  {
    n: 3,
    title: 'Get approved',
    body: 'Once an administrator approves your account, you can sign in to the full terminal.',
  },
];

export const PREMIUM_PLAN = {
  name: 'Vega Analysis Premium',
  tagline: 'Full access to the terminal for one year',
  price: 4999,
  period: 'year',
  duration: '1 Year Access',
  features: [
    'Live Vega Analysis',
    'Historical Vega Charts',
    'Vega Dashboard',
    'Option Chain',
    'Advanced Analytics',
  ],
};

/** What a visitor gets without an account — the honest version of "free tier". */
export const VISITOR_LIMITS = [
  { label: 'Delayed NIFTY Vega chart (30 minutes)', included: true },
  { label: 'Live Vega Analysis', included: false },
  { label: 'Historical sessions', included: false },
  { label: 'Option chain & Greeks', included: false },
  { label: 'Vega dashboard', included: false },
];
