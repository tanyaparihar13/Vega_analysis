import { Link } from 'react-router-dom';
import {
  TbChartHistogram, TbListDetails, TbMathFunction, TbBolt, TbShieldCheck, TbClockHour4,
} from 'react-icons/tb';
import { useAuth } from '../context/AuthContext';

/**
 * Public landing page — the front door of the merged site + app.
 *
 * Route '/' is public; the dashboard stays behind auth. A already-signed-in
 * visitor gets a "Go to Dashboard" call to action instead of Register, so the
 * page never sends them back through signup.
 */

const FEATURES = [
  {
    icon: TbChartHistogram,
    title: 'Live Vega Analysis',
    body: 'Call Vega, Put Vega and their Difference recomputed every minute against a frozen day-open baseline, with Bullish / Bearish / Sideways classification.',
  },
  {
    icon: TbListDetails,
    title: 'Real-time Option Chain',
    body: 'Full CE/PE board streamed over WebSocket — LTP, OI and OI change, volume, bid/ask and 5-level market depth.',
  },
  {
    icon: TbMathFunction,
    title: 'Accurate Greeks',
    body: 'Delta, Gamma, Theta, Vega and IV solved with Black-76 against the futures forward — the way Indian index options are actually priced.',
  },
  {
    icon: TbClockHour4,
    title: 'Historical Replay',
    body: 'Every trading minute is recorded automatically. Pick any past session and the chart and table replay that day exactly.',
  },
  {
    icon: TbBolt,
    title: 'Direct Zerodha Feed',
    body: 'Powered by your own Kite Connect session. No third-party data resellers, no delayed snapshots.',
  },
  {
    icon: TbShieldCheck,
    title: 'Approved Access',
    body: 'Every account is reviewed by an administrator before it can sign in, so access stays with people you know.',
  },
];

export default function LandingPage() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-vega-black">
      {/* Nav */}
      <header className="sticky top-0 z-30 border-b border-vega-border bg-white/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-vega-blue text-sm font-extrabold text-white">
            V
          </div>
          <span className="text-base font-bold text-slate-900">
            Vega <span className="text-vega-blue">Analysis</span>
          </span>

          <nav className="ml-auto flex items-center gap-2">
            {user ? (
              <Link to="/dashboard" className="btn-primary text-sm">Go to Dashboard</Link>
            ) : (
              <>
                <Link
                  to="/login"
                  className="rounded-lg px-3.5 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                >
                  Sign in
                </Link>
                <Link to="/register" className="btn-primary text-sm">Get Started</Link>
              </>
            )}
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-5 pb-14 pt-16 text-center sm:pt-24">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-vega-border bg-white px-3 py-1 text-xs font-medium text-slate-500">
          <span className="live-dot" />
          Live NSE &amp; BSE index derivatives
        </span>

        <h1 className="mx-auto mt-5 max-w-3xl text-4xl font-bold leading-tight tracking-tight text-slate-900 sm:text-5xl">
          See where option writers are
          <span className="text-vega-blue"> really positioned</span>
        </h1>

        <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-slate-500">
          A professional Vega Analysis terminal for NIFTY, BANKNIFTY, FINNIFTY,
          MIDCPNIFTY and SENSEX — built directly on your own Zerodha Kite feed,
          recording every market minute so you can replay any session.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          {user ? (
            <Link to="/vega-analysis" className="btn-primary px-6 py-2.5">Open Vega Analysis</Link>
          ) : (
            <>
              <Link to="/register" className="btn-primary px-6 py-2.5">Create an account</Link>
              <Link
                to="/login"
                className="rounded-lg border border-vega-border bg-white px-6 py-2.5 font-medium text-slate-700 transition-colors hover:bg-slate-50"
              >
                Sign in
              </Link>
            </>
          )}
        </div>

        <p className="mt-3 text-xs text-slate-400">
          New accounts are reviewed by an administrator before access is granted.
        </p>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-6xl px-5 pb-20">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, body }) => (
            <div key={title} className="glass-card p-5">
              <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-vega-blue/10">
                <Icon size={18} className="text-vega-blue" />
              </div>
              <h3 className="mb-1.5 font-semibold text-slate-900">{title}</h3>
              <p className="text-sm leading-relaxed text-slate-500">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* How it works — mirrors the actual approval flow */}
      <section className="border-t border-vega-border bg-white">
        <div className="mx-auto max-w-4xl px-5 py-14">
          <h2 className="text-center text-xl font-semibold text-slate-900">Getting access</h2>
          <ol className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-3">
            {[
              { n: 1, t: 'Register', d: 'Create your account with your name, email and mobile number.' },
              { n: 2, t: 'Send the request', d: 'WhatsApp opens with a prefilled message — press Send.' },
              { n: 3, t: 'Get approved', d: 'An administrator approves you, and you can sign in.' },
            ].map((s) => (
              <li key={s.n} className="text-center">
                <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-vega-blue font-semibold text-white">
                  {s.n}
                </div>
                <h3 className="font-medium text-slate-900">{s.t}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-500">{s.d}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <footer className="border-t border-vega-border py-7 text-center text-xs text-slate-400">
        <p>Vega Analysis — market data via Zerodha Kite Connect.</p>
        <p className="mt-1">For research and analysis only. Not investment advice.</p>
      </footer>
    </div>
  );
}
