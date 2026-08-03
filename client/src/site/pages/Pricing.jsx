import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiCheck, HiOutlineX, HiOutlineSparkles, HiOutlineShieldCheck,
  HiOutlineClock, HiOutlineChatAlt2,
} from 'react-icons/hi';
import { PREMIUM_PLAN, VISITOR_LIMITS } from '../content';

/**
 * Pricing.
 *
 * ONE plan, because one plan is what exists. The template shipped a
 * Starter / Pro / Enterprise ladder with a monthly-yearly toggle, a "Save 20%"
 * badge and a comparison table — all invented, and every tier but one was
 * unbuyable. A fake ladder next to a real price makes the real price look
 * negotiable.
 *
 * The visitor column is not a "free plan"; it is an honest statement of what a
 * signed-out visitor can already see on this site.
 */

const TRUST = [
  { icon: HiOutlineShieldCheck, text: 'Admin-approved access', tone: 'text-success' },
  { icon: HiOutlineClock, text: 'Data recorded every market minute', tone: 'text-primary' },
  { icon: HiOutlineChatAlt2, text: 'Direct WhatsApp support', tone: 'text-gold' },
];

const FAQS = [
  {
    q: 'What happens after I register?',
    a: 'Your account is created with a pending status and WhatsApp opens with your details prefilled. You press Send, and once an administrator approves the account you can sign in to the full terminal.',
  },
  {
    q: 'Why can I only see a delayed chart?',
    a: 'The chart on the home page is the real NIFTY Vega series held back by 30 minutes. Live data, historical sessions, the option chain and the Greeks are what the subscription is for.',
  },
  {
    q: 'Where does the market data come from?',
    a: 'Directly from Zerodha Kite Connect. Nothing is bought from a data reseller and no historical data is imported — the history you see was recorded minute by minute from that live feed.',
  },
  {
    q: 'Which underlyings are covered?',
    a: 'NIFTY, BANKNIFTY, FINNIFTY and MIDCPNIFTY on NSE, and SENSEX on BSE.',
  },
  {
    q: 'How far back does the history go?',
    a: 'Ninety days of per-minute history is retained, and every trading day is added automatically as it happens.',
  },
];

export default function Pricing() {
  return (
    <>
      <section className="px-5 pb-12 pt-20 text-center sm:px-6">
        <div className="mx-auto max-w-2xl">
          <span className="site-eyebrow">Pricing</span>
          <h1 className="mt-3 font-display text-4xl font-bold text-text sm:text-5xl">
            One plan, everything included
          </h1>
          <p className="mt-4 text-base leading-relaxed text-text/60 sm:text-lg">
            No tiers to compare and no features held back. Full access to the Vega
            Analysis terminal for a year.
          </p>
        </div>
      </section>

      <section className="px-5 pb-20 sm:px-6">
        <div className="mx-auto grid max-w-4xl grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] md:items-start">
          {/* ---------- what a visitor already gets ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.4 }}
            className="site-card p-7"
          >
            <h2 className="font-display text-lg font-bold text-text">Visitor</h2>
            <p className="mt-1.5 text-sm text-text/50">What you can see without an account</p>

            <div className="mt-6 flex items-baseline gap-1">
              <span className="font-display text-3xl font-bold text-text">₹0</span>
            </div>
            <p className="mt-1 text-xs text-text/40">No account required</p>

            <Link to="/" className="site-btn-outline mt-7 w-full">
              View the delayed chart
            </Link>

            <ul className="mt-8 space-y-3 border-t border-border pt-6">
              {VISITOR_LIMITS.map((f) => (
                <li key={f.label} className="flex items-start gap-2.5 text-sm">
                  {f.included ? (
                    <HiCheck className="mt-0.5 shrink-0 text-success" size={16} />
                  ) : (
                    <HiOutlineX className="mt-0.5 shrink-0 text-text/25" size={16} />
                  )}
                  <span className={f.included ? 'text-text/75' : 'text-text/35'}>{f.label}</span>
                </li>
              ))}
            </ul>
          </motion.div>

          {/* ---------- the plan ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.4, delay: 0.1 }}
            className="relative rounded-2xl border-2 border-primary/50 bg-gradient-to-b from-primary/[0.09] via-white to-white p-7 shadow-glow sm:p-8"
          >
            <span className="absolute -top-3.5 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full bg-primary-gradient px-4 py-1.5 text-xs font-semibold text-white shadow-glow">
              <HiOutlineSparkles size={13} /> Full Access
            </span>

            <h2 className="font-display text-xl font-bold text-text">{PREMIUM_PLAN.name}</h2>
            <p className="mt-1.5 text-sm text-text/50">{PREMIUM_PLAN.tagline}</p>

            <div className="mt-6 flex items-baseline gap-1.5">
              <span className="font-display text-4xl font-bold text-text sm:text-5xl">
                ₹{PREMIUM_PLAN.price.toLocaleString('en-IN')}
              </span>
              <span className="text-base text-text/40">/{PREMIUM_PLAN.period}</span>
            </div>
            <p className="mt-1 text-xs font-medium text-primary">{PREMIUM_PLAN.duration}</p>

            <Link to="/register" className="site-btn-primary mt-7 w-full">
              Register Now
            </Link>
            <p className="mt-2.5 text-center text-xs text-text/45">
              Accounts are activated after administrator approval.
            </p>

            <ul className="mt-8 space-y-3.5 border-t border-border pt-6">
              {PREMIUM_PLAN.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm">
                  <HiCheck className="mt-0.5 shrink-0 text-success" size={17} />
                  <span className="font-medium text-text/85">{f}</span>
                </li>
              ))}
            </ul>
          </motion.div>
        </div>
      </section>

      <section className="px-5 pb-20 sm:px-6">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-8 gap-y-4 rounded-2xl border border-border bg-slate-100 px-8 py-6">
          {TRUST.map((t) => (
            <div key={t.text} className="flex items-center gap-2 text-sm text-text/60">
              <t.icon className={t.tone} size={18} /> {t.text}
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-white px-5 py-20 sm:px-6">
        <div className="mx-auto max-w-3xl">
          <div className="mb-10 text-center">
            <span className="site-eyebrow">FAQ</span>
            <h2 className="mt-3 font-display text-3xl font-bold text-text sm:text-4xl">
              Common questions
            </h2>
          </div>

          <div className="space-y-3">
            {FAQS.map((f) => (
              <details key={f.q} className="site-card group p-5 open:shadow-card-hover">
                <summary className="cursor-pointer list-none font-display text-sm font-semibold text-text marker:hidden">
                  <span className="flex items-center justify-between gap-4">
                    {f.q}
                    <span className="shrink-0 text-lg font-normal text-primary transition-transform group-open:rotate-45">
                      +
                    </span>
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-text/60">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
