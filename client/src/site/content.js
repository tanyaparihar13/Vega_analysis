import {
  TbChartHistogram, TbListDetails, TbMathFunction, TbClockHour4,
  TbBolt, TbShieldCheck, TbCalendarStats, TbDeviceAnalytics,
} from 'react-icons/tb';

/**
 * Copy and configuration for the public site, in one place so Home, Features
 * and Pricing cannot drift.
 *
 * EVERY CLAIM HERE IS SOMETHING THE CODEBASE ACTUALLY DOES. The original
 * template this site was built from advertised sub-10ms execution, copy
 * trading, forex, crypto, 2.4M users and a 99.98% uptime figure — none of
 * which exist in this product, and most of which would be regulated claims.
 * If a line below stops being true, delete it rather than soften it.
 *
 * The same rule governs the two blocks a marketing redesign is most tempted to
 * fake: TESTIMONIALS ships empty (see its comment), and the market ticker is
 * driven by the real delayed-vega endpoint rather than invented spot prices.
 */

/* ==========================================================================
   NAVIGATION
   ========================================================================== */

/**
 * `to` is a router path; `hash` is an in-page anchor on the home page.
 *
 * Anchors, not routes, for Learning / YouTube / FAQ on purpose: adding routes
 * would mean touching App.jsx, and the brief is explicit that routing stays
 * exactly as it is. SiteNavbar resolves a `hash` entry to `/#id`, which works
 * from any page.
 *
 * "Vega Dashboard" points at the REAL /dashboard route. A signed-out visitor
 * who clicks it is sent to /login by the existing ProtectedRoute — that is the
 * intended funnel, not a bug.
 */
export const NAV_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Vega Dashboard', to: '/dashboard' },
  { label: 'Features', to: '/features' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Learning', hash: 'learning' },
  { label: 'YouTube', hash: 'youtube' },
  { label: 'FAQ', hash: 'faq' },
  { label: 'Contact', to: '/contact' },
];

/* ==========================================================================
   YOUTUBE
   ========================================================================== */

/**
 * The official channel.
 *
 * `channelId` and `uploadsPlaylistId` were read from the channel's own page and
 * feed. The uploads playlist of any channel is its channel id with the `UC`
 * prefix swapped for `UU` — which is why the featured player can always show
 * the newest upload with NO API key, NO server call and nothing to keep in
 * sync. That matters here: fetching youtube.com/feeds from the browser is
 * blocked by CORS, and the alternative (a Data API key) would mean a backend
 * change, which this work is not allowed to make.
 *
 * LATEST_VIDEOS is therefore the only part that ages. It is a snapshot of the
 * channel feed taken on 2026-08-03 and is used for the thumbnail grid only.
 * The videos are real and their links keep working; to refresh the list, open
 *   https://www.youtube.com/feeds/videos.xml?channel_id=UCJ1M4PYKe1d9Yp6GeUqsG1Q
 * and copy the newest <yt:videoId> / <title> / <published> values in.
 * Thumbnails come straight from i.ytimg.com, so nothing needs downloading.
 */
export const YOUTUBE = {
  handle: '@AlphaEdge567',
  channelName: 'AlphaEdge',
  channelUrl: 'https://www.youtube.com/@AlphaEdge567',
  channelId: 'UCJ1M4PYKe1d9Yp6GeUqsG1Q',
  uploadsPlaylistId: 'UUJ1M4PYKe1d9Yp6GeUqsG1Q',
  subscribeUrl: 'https://www.youtube.com/@AlphaEdge567?sub_confirmation=1',
  videosUrl: 'https://www.youtube.com/@AlphaEdge567/videos',
};

export const LATEST_VIDEOS = [
  { id: '0O6LvFTUWOo', title: 'Learn How to use Vega-Algo Software in Option Trading', date: '2026-02-18' },
  { id: 'wXFk54I3CkU', title: 'Learn How to use Vega-Algo Software in Option Trading', date: '2026-02-17' },
  { id: '09mklW8Ophk', title: 'Vega Traders — Session Walkthrough', date: '2026-02-11' },
  { id: '299cOP4HEB0', title: 'Learn How to use Vega-Algo Software in Option Trading', date: '2026-02-09' },
  { id: 'K_CuEdST-Gw', title: 'Learn How to use Vega-Algo Software in Option Trading', date: '2026-02-07' },
  { id: 'KC30do9FYvM', title: 'How To Use Vega in Options Trading', date: '2026-01-22' },
];

/* ==========================================================================
   SOCIAL
   ========================================================================== */

/**
 * Floating social dock.
 *
 * WhatsApp is not listed here — its number comes from the server at runtime
 * (`/api/public/site-config` -> ADMIN_WHATSAPP_NUMBER), the same source the
 * signup handoff and the contact form already use, so there is exactly one
 * place to change it.
 *
 * Facebook and Instagram are null because no accounts have been supplied. The
 * dock renders only what is set, so putting a URL here is all that is needed
 * to switch either one on — no component edit.
 */
export const SOCIAL_LINKS = {
  facebook: null,   // e.g. 'https://www.facebook.com/yourpage'
  instagram: null,  // e.g. 'https://www.instagram.com/yourhandle'
  youtube: YOUTUBE.channelUrl,
};

/* ==========================================================================
   FEATURES
   ========================================================================== */

export const FEATURES = [
  {
    icon: TbChartHistogram,
    title: 'Real-Time Vega Analytics',
    body:
      'Call Vega, Put Vega and their Difference recomputed every market minute against a '
      + 'frozen day-open baseline, with a Bullish / Bearish / Sideways read on every point.',
  },
  {
    icon: TbClockHour4,
    title: 'Historical Vega Analysis',
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
    title: 'Option Chain Intelligence',
    body:
      'The full CE/PE board streamed over WebSocket — LTP, open interest and OI change, '
      + 'volume, bid/ask and five-level market depth.',
  },
  {
    icon: TbMathFunction,
    title: 'Institutional Data View',
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
    title: 'Professional Trading Dashboard',
    body:
      'NIFTY, BANKNIFTY, FINNIFTY and MIDCPNIFTY on NSE, plus SENSEX on BSE — each with its '
      + 'own delta band and strike step, in one workspace.',
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

/* ==========================================================================
   WHY VEGA ANALYSIS
   ========================================================================== */

/** Each line answers "why this and not a generic screener", with a real reason. */
export const WHY_POINTS = [
  {
    title: 'A baseline that does not move',
    body:
      'The first usable option chain of the session is frozen per strike and held for the '
      + 'rest of the day. Every number you see is a change from that reference, so the '
      + 'curve means the same thing at 10:00 as it does at 15:00.',
  },
  {
    title: 'Greeks solved, not scraped',
    body:
      'Implied volatility is backed out of each contract\'s traded price, then Delta, Gamma, '
      + 'Theta and Vega are computed with Black-76 against the futures forward.',
  },
  {
    title: 'Strikes re-selected every minute',
    body:
      'Eligible Call and Put strikes are recomputed each minute from the live chain within a '
      + '|delta| band, then summed against the frozen morning chain — so a drifting spot '
      + 'never quietly changes what is being measured.',
  },
  {
    title: 'Your own recorded history',
    body:
      'Samples persist as they are taken. The history is built from the feed you are already '
      + 'paying for, which means any past session replays exactly as it happened.',
  },
];

/* ==========================================================================
   ANALYTICS SHOWCASE
   ========================================================================== */

export const ANALYTICS_HIGHLIGHTS = [
  {
    label: 'Vega Trend Engine',
    body: 'Signed Call and Put vega deltas resolve to a Bullish, Bearish or Sideways read on every sampled minute.',
  },
  {
    label: 'Five-Level Market Depth',
    body: 'Full bid/ask ladders on every contract in the chain, streamed rather than polled.',
  },
  {
    label: 'Time-wise Records Table',
    body: 'The same series as a sortable, exportable table at 1, 3, 5 or 15 minute resolution.',
  },
  {
    label: 'Open Interest Analytics',
    body: 'OI and OI-change tracked per strike alongside the vega series, on the same clock.',
  },
];

/* ==========================================================================
   ACCESS + PRICING
   ========================================================================== */

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

/* ==========================================================================
   TESTIMONIALS
   ========================================================================== */

/**
 * DELIBERATELY EMPTY — this is not an oversight.
 *
 * The section that renders these is built, styled and responsive; it simply
 * returns null while the array has no entries, so the page flows straight from
 * the analytics showcase to pricing and nothing looks unfinished.
 *
 * Inventing quotes from traders who do not exist, on a page selling a paid
 * financial analytics product, is the kind of claim this file exists to keep
 * out. Add real ones and the section switches itself on:
 *
 *   { quote: '…', name: 'Full Name', role: 'Options trader, Pune', since: '2025' }
 *
 * `role` and `since` are optional.
 */
export const TESTIMONIALS = [];

/* ==========================================================================
   FAQ
   ========================================================================== */

export const FAQS = [
  {
    q: 'Why is the chart on this page delayed by 30 minutes?',
    a: 'It is the real NIFTY Vega series, held back by 30 minutes by the server before it is '
      + 'published publicly. Live data, historical sessions, the option chain and the full '
      + 'Greeks are what the subscription is for.',
  },
  {
    q: 'What happens after I register?',
    a: 'Your account is created with a pending status and WhatsApp opens with your details '
      + 'prefilled. You press Send, and once an administrator approves the account you can '
      + 'sign in to the full terminal.',
  },
  {
    q: 'Where does the market data come from?',
    a: 'Directly from Zerodha Kite Connect. Nothing is bought from a data reseller and no '
      + 'historical data is imported — the history you see was recorded minute by minute '
      + 'from that live feed.',
  },
  {
    q: 'Which underlyings are covered?',
    a: 'NIFTY, BANKNIFTY, FINNIFTY and MIDCPNIFTY on NSE, and SENSEX on BSE. Each has its own '
      + 'delta band and strike step.',
  },
  {
    q: 'How far back does the history go?',
    a: 'Ninety days of per-minute history is retained, and every trading day is added '
      + 'automatically as it happens.',
  },
  {
    q: 'Is Vega Analysis giving me trade recommendations?',
    a: 'No. It is a research and analytics tool. It shows you where option writers are '
      + 'positioned in vega terms; what you do with that is your decision. Nothing on this '
      + 'site is investment advice.',
  },
];
