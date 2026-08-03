import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiCheck, HiOutlineX, HiOutlineSparkles, HiOutlineShieldCheck,
  HiOutlineClock, HiOutlineChatAlt2, HiOutlineArrowRight,
} from 'react-icons/hi';
import FaqSection from '../components/FaqSection';
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
 *
 * The FAQ at the bottom is the shared FaqSection component, so this page and
 * the home page can never answer the same question two different ways.
 */

const EASE = [0.22, 1, 0.36, 1];

const TRUST = [
  { icon: HiOutlineShieldCheck, text: 'Admin-approved access', tone: 'text-primary' },
  { icon: HiOutlineClock, text: 'Data recorded every market minute', tone: 'text-accent' },
  { icon: HiOutlineChatAlt2, text: 'Direct WhatsApp support', tone: 'text-gold' },
];

export default function Pricing() {
  return (
    <>
      <section className="relative px-5 pb-14 pt-20 text-center sm:px-8 sm:pt-28">
        <motion.div
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="mx-auto max-w-3xl"
        >
          <span className="site-eyebrow">Pricing</span>
          <h1 className="mt-4 font-display text-4xl font-bold leading-tight tracking-tight text-text sm:text-5xl lg:text-6xl">
            One plan,{' '}
            <span className="site-gradient-text">everything included</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            No tiers to compare and no features held back. Full access to the Vega
            Analysis terminal for a year.
          </p>
        </motion.div>
      </section>

      <section className="relative px-5 pb-20 sm:px-8">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] md:items-start">
          {/* ---------- what a visitor already gets ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.5 }}
            className="site-card p-8"
          >
            <h2 className="font-display text-xl font-bold text-text">Visitor</h2>
            <p className="mt-2 text-sm text-muted">What you can see without an account</p>

            <div className="mt-7 flex items-baseline gap-1">
              <span className="font-display text-4xl font-bold text-text">₹0</span>
            </div>
            <p className="mt-1.5 text-xs text-muted/80">No account required</p>

            <Link to="/" className="site-btn-outline mt-8 w-full !py-3 !text-sm">
              View the delayed chart
            </Link>

            <ul className="mt-9 space-y-3.5 border-t border-white/[0.08] pt-7">
              {VISITOR_LIMITS.map((f) => (
                <li key={f.label} className="flex items-start gap-2.5 text-sm">
                  {f.included ? (
                    <HiCheck className="mt-0.5 shrink-0 text-primary" size={17} />
                  ) : (
                    <HiOutlineX className="mt-0.5 shrink-0 text-muted/35" size={17} />
                  )}
                  <span className={f.included ? 'text-text/85' : 'text-muted/55'}>
                    {f.label}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>

          {/* ---------- the plan ---------- */}
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="site-ring shadow-[0_40px_110px_-45px_rgba(0,230,118,0.55)]"
          >
            <div className="site-ring-inner p-8 sm:p-9">
              {/*
                Sits INSIDE the card rather than straddling its top edge: the
                `.site-ring` wrapper has `overflow-hidden` (it has to, to clip
                the spinning conic border), so anything with a negative offset
                would be cut in half.
              */}
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-primary-gradient px-4 py-1.5 font-body text-xs font-bold text-[#04120a] shadow-glow">
                <HiOutlineSparkles size={14} /> Full Access
              </span>

              <h2 className="mt-5 font-display text-2xl font-bold text-text">
                {PREMIUM_PLAN.name}
              </h2>
              <p className="mt-2 text-sm text-muted">{PREMIUM_PLAN.tagline}</p>

              <div className="mt-7 flex items-baseline gap-2">
                <span className="font-display text-5xl font-bold text-text">
                  ₹{PREMIUM_PLAN.price.toLocaleString('en-IN')}
                </span>
                <span className="text-base text-muted">/{PREMIUM_PLAN.period}</span>
              </div>
              <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-primary">
                {PREMIUM_PLAN.duration}
              </p>

              <Link to="/register" className="site-cta mt-8 w-full !py-3.5">
                Open Account <HiOutlineArrowRight size={17} />
              </Link>
              <p className="mt-3 text-center text-xs text-muted/80">
                Accounts are activated after administrator approval.
              </p>

              <ul className="mt-9 space-y-4 border-t border-white/[0.08] pt-7">
                {PREMIUM_PLAN.features.map((f) => (
                  <li key={f} className="flex items-start gap-3 text-sm">
                    <HiCheck className="mt-0.5 shrink-0 text-primary" size={18} />
                    <span className="font-medium text-text/90">{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        </div>
      </section>

      <section className="relative px-5 pb-4 sm:px-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-center gap-x-9 gap-y-4 rounded-2xl border border-white/[0.07] bg-[rgba(255,255,255,0.025)] px-8 py-6">
          {TRUST.map((t) => (
            <div key={t.text} className="flex items-center gap-2.5 text-sm text-muted">
              <t.icon className={t.tone} size={19} /> {t.text}
            </div>
          ))}
        </div>
      </section>

      <FaqSection />
    </>
  );
}
