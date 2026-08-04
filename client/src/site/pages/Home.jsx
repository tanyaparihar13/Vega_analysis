import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiOutlineArrowRight, HiCheck, HiOutlinePlay, HiOutlineChartSquareBar,
  HiOutlineSparkles,
} from 'react-icons/hi';
import DelayedVegaPanel from '../components/DelayedVegaPanel';
import MarketTicker from '../components/MarketTicker';
import YouTubeSection from '../components/YouTubeSection';
import Testimonials from '../components/Testimonials';
import FaqSection from '../components/FaqSection';
import {
  FEATURES, PLATFORM_FACTS, PREMIUM_PLAN, WHY_POINTS, ANALYTICS_HIGHLIGHTS, ACCESS_STEPS,
} from '../content';
import { useAuth } from '../../context/AuthContext';

/**
 * Public landing page.
 *
 * ELEVEN SECTIONS, IN ORDER: the full-width Vega chart, the hero, the live
 * market strip, features, why Vega Analysis, the YouTube learning section, the
 * analytics showcase, testimonials, the pricing call to action, FAQ, footer
 * (the footer itself lives in SiteLayout, which every public page shares).
 *
 * THE CHART IS THE ARGUMENT, and it now leads the page. It is real recorded
 * data and it is the single most persuasive thing this product has, so a
 * visitor meets it before any copy asks them to believe anything; the hero
 * directly beneath then names what they have just been looking at and points
 * them at "Watch Live Vega". That is also why the chart is full-bleed and
 * 640px tall rather than a decorative card beside the headline.
 *
 * Only the ORDER of those two sections changed — both are byte-for-byte the
 * markup they had when the hero came first, apart from the vertical padding
 * that each one's new neighbour requires.
 *
 * All destinations are EXISTING routes. Nothing here adds, removes or changes
 * routing, auth or any API call.
 */

/* Shared motion presets, so every section enters with the same character. */
const fadeUp = {
  hidden: { opacity: 0, y: 26 },
  show: { opacity: 1, y: 0 },
};

const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const EASE = [0.22, 1, 0.36, 1];

export default function Home() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  // "Watch Live Vega" goes to the live terminal for a signed-in user and into
  // the existing login funnel for everyone else — ProtectedRoute already sends
  // a signed-out visitor from /vega-analysis to /login, so this is the app's
  // own flow with no changes to it.
  const liveTarget = user ? (isAdmin ? '/admin' : '/vega-analysis') : '/login';
  const dashboardTarget = user ? (isAdmin ? '/admin' : '/dashboard') : '/register';

  return (
    <>
      {/* ===================== 1 · FULL-WIDTH VEGA CHART ===================== */}
      {/*
        FADE ONLY — NO TRANSFORM ON THIS WRAPPER.

        Every other section here enters with a `y` / `scale` transform, and this
        one deliberately does not. lightweight-charts sizes its canvas bitmaps
        from `getBoundingClientRect()`, which reports TRANSFORMED geometry: with
        a `scale()` on an ancestor the library reads a box that does not match
        the element's layout size, fails to bind a size, and leaves every canvas
        at the 300x150 HTML default stretched across a 1148px card. The visible
        result is a blurry chart that overflows its container and cannot be
        fixed by any later resize.

        The chart does not need a transform to make an entrance in any case — it
        already draws itself left to right on first paint, which is a better
        one.

        The padding is the only thing this section gained when it moved above
        the hero: it is now the first block under the navbar, so it carries the
        top spacing the hero used to.
      */}
      <section className="relative px-3 pb-10 pt-8 sm:px-6 sm:pb-12 sm:pt-12 lg:px-8">
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.15, ease: EASE }}
          className="mx-auto w-full max-w-[1600px]"
        >
          <DelayedVegaPanel />
        </motion.div>
      </section>

      {/* ===================== 2 · HERO ===================== */}
      <section className="relative overflow-hidden px-5 pb-14 pt-10 sm:px-8 sm:pb-20 sm:pt-14">
        <motion.div
          initial="hidden"
          animate="show"
          variants={stagger}
          className="mx-auto max-w-4xl text-center"
        >
          <motion.div variants={fadeUp} transition={{ duration: 0.6, ease: EASE }}>
            <span className="site-badge !border-primary/25 !text-primary" style={{ backgroundColor: 'rgba(0,230,118,0.09)' }}>
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              NSE &amp; BSE index derivatives · Direct Zerodha Kite feed
            </span>
          </motion.div>

          <motion.h1
            variants={fadeUp}
            transition={{ duration: 0.7, ease: EASE }}
            className="mt-7 font-display text-[2.6rem] font-bold leading-[1.06] tracking-tight text-text sm:text-6xl lg:text-[4.6rem]"
          >
            Trade Smarter with{' '}
            <span className="site-gradient-text">Vega Analysis</span>
          </motion.h1>

          <motion.p
            variants={fadeUp}
            transition={{ duration: 0.7, ease: EASE }}
            className="mx-auto mt-5 max-w-3xl font-display text-xl italic leading-snug text-text/75 sm:text-2xl lg:text-[1.75rem]"
          >
            Professional Options Vega Analytics for Serious Traders
          </motion.p>

          <motion.p
            variants={fadeUp}
            transition={{ duration: 0.7, ease: EASE }}
            className="mx-auto mt-7 max-w-2xl text-base leading-relaxed text-muted sm:text-lg"
          >
            Access advanced Vega analytics, institutional-grade options data, and
            powerful market insights designed for traders who want precision and
            confidence.
          </motion.p>

          {/* ---------- CTAs ---------- */}
          <motion.div
            variants={fadeUp}
            transition={{ duration: 0.7, ease: EASE }}
            className="mt-11 flex flex-col items-center justify-center gap-4 sm:flex-row"
          >
            <Link to={liveTarget} className="site-cta w-full sm:w-auto">
              <HiOutlinePlay size={21} />
              Watch Live Vega
            </Link>
            <Link
              to={dashboardTarget}
              className="site-btn-outline w-full !py-4 !text-base sm:w-auto"
            >
              <HiOutlineChartSquareBar size={19} />
              Explore Vega Dashboard
            </Link>
          </motion.div>

          {!user && (
            <motion.p
              variants={fadeUp}
              transition={{ duration: 0.7, ease: EASE }}
              className="mt-4 text-xs text-muted/80"
            >
              New accounts are reviewed by an administrator before access is granted.
            </motion.p>
          )}

          {/* ---------- platform facts ---------- */}
          <motion.div
            variants={fadeUp}
            transition={{ duration: 0.7, ease: EASE }}
            className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-x-6 gap-y-7 border-t border-white/[0.08] pt-10 sm:grid-cols-4"
          >
            {PLATFORM_FACTS.map((f) => (
              <div key={f.label}>
                <div className="font-display text-2xl font-bold text-text sm:text-3xl">
                  {f.value}
                </div>
                <div className="mt-1.5 text-xs leading-snug text-muted">{f.label}</div>
              </div>
            ))}
          </motion.div>
        </motion.div>
      </section>

      {/* ===================== 3 · LIVE MARKET STRIP ===================== */}
      <MarketTicker />

      {/* ===================== 4 · FEATURES ===================== */}
      <section id="features" className="relative px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-[1400px]">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.55 }}
            className="mx-auto mb-14 max-w-2xl text-center"
          >
            <span className="site-eyebrow">What you get</span>
            <h2 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
              Built for one job, done properly
            </h2>
            <p className="mt-5 text-base leading-relaxed text-muted">
              Not a general trading platform. A focused Vega Analysis terminal for
              Indian index options.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.slice(0, 6).map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 26 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ duration: 0.45, delay: (i % 3) * 0.09 }}
                className="site-card-hover group p-7"
              >
                <div className="relative mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary transition-all duration-300 group-hover:border-primary/50 group-hover:shadow-glow-emerald">
                  <f.icon size={25} />
                </div>
                <h3 className="font-display text-lg font-bold text-text">{f.title}</h3>
                <p className="mt-2.5 text-sm leading-relaxed text-muted">{f.body}</p>
              </motion.div>
            ))}
          </div>

          <div className="mt-12 text-center">
            <Link to="/features" className="site-btn-outline">
              See all features <HiOutlineArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* ===================== 5 · WHY VEGA ANALYSIS ===================== */}
      <section id="why" className="relative px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-[1400px]">
          <div className="grid grid-cols-1 gap-14 lg:grid-cols-2 lg:items-center lg:gap-20">
            <motion.div
              initial={{ opacity: 0, x: -26 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.6, ease: EASE }}
            >
              <span className="site-eyebrow">Why Vega Analysis</span>
              <h2 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
                See where option writers are{' '}
                <span className="site-gradient-text">really positioned</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted">
                Vega is where an option writer's risk actually sits. Tracking how Call and
                Put vega move away from the morning baseline shows you who is being forced
                to adjust — not just where price has already been.
              </p>

              <div className="mt-9 flex flex-wrap gap-3">
                <Link to={liveTarget} className="site-btn-primary">
                  Watch Live Vega <HiOutlineArrowRight size={17} />
                </Link>
                <Link to="/features" className="site-btn-outline">
                  How it works
                </Link>
              </div>
            </motion.div>

            <motion.ol
              initial="hidden"
              whileInView="show"
              viewport={{ once: true, amount: 0.2 }}
              variants={stagger}
              className="space-y-4"
            >
              {WHY_POINTS.map((p, i) => (
                <motion.li
                  key={p.title}
                  variants={fadeUp}
                  transition={{ duration: 0.45, ease: EASE }}
                  className="site-card flex gap-5 p-6"
                >
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-gradient font-body text-sm font-bold text-[#04120a] shadow-glow-emerald">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-display text-base font-bold text-text">{p.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-muted">{p.body}</p>
                  </div>
                </motion.li>
              ))}
            </motion.ol>
          </div>
        </div>
      </section>

      {/* ===================== 6 · YOUTUBE / LEARNING ===================== */}
      <YouTubeSection />

      {/* ===================== 7 · ANALYTICS SHOWCASE ===================== */}
      <section id="analytics" className="relative px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-[1400px]">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.55 }}
            className="mx-auto mb-14 max-w-2xl text-center"
          >
            <span className="site-eyebrow">Inside the terminal</span>
            <h2 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
              Analytics that go past the chart
            </h2>
            <p className="mt-5 text-base leading-relaxed text-muted">
              The public page shows one delayed series. The terminal shows the whole
              instrument.
            </p>
          </motion.div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {ANALYTICS_HIGHLIGHTS.map((a, i) => (
              <motion.div
                key={a.label}
                initial={{ opacity: 0, y: 26 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.2 }}
                transition={{ duration: 0.45, delay: i * 0.08 }}
                className="site-card-hover p-7"
              >
                <span className="font-mono text-xs font-bold tracking-widest text-primary">
                  0{i + 1}
                </span>
                <h3 className="mt-4 font-display text-lg font-bold leading-snug text-text">
                  {a.label}
                </h3>
                <p className="mt-2.5 text-sm leading-relaxed text-muted">{a.body}</p>
              </motion.div>
            ))}
          </div>

          {/* How access works — three real steps of the existing approval flow. */}
          <div className="mt-20">
            <motion.h3
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.4 }}
              transition={{ duration: 0.45 }}
              className="text-center font-display text-2xl font-bold text-text sm:text-3xl"
            >
              Three steps to the terminal
            </motion.h3>

            <ol className="mt-10 grid grid-cols-1 gap-8 sm:grid-cols-3">
              {ACCESS_STEPS.map((s, i) => (
                <motion.li
                  key={s.n}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.3 }}
                  transition={{ duration: 0.45, delay: i * 0.1 }}
                  className="text-center"
                >
                  <div className="mx-auto mb-5 grid h-12 w-12 place-items-center rounded-full bg-primary-gradient font-body text-base font-bold text-[#04120a] shadow-glow">
                    {s.n}
                  </div>
                  <h4 className="font-display text-lg font-bold text-text">{s.title}</h4>
                  <p className="mx-auto mt-2.5 max-w-xs text-sm leading-relaxed text-muted">
                    {s.body}
                  </p>
                </motion.li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      {/* ===================== 8 · TESTIMONIALS ===================== */}
      <Testimonials />

      {/* ===================== 9 · PRICING CTA ===================== */}
      <section id="pricing" className="relative px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.25 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="site-ring shadow-[0_40px_120px_-45px_rgba(0,230,118,0.5)]"
          >
            <div className="site-ring-inner overflow-hidden p-8 sm:p-12">
              <div className="grid grid-cols-1 items-center gap-10 md:grid-cols-[minmax(0,1fr)_auto]">
                <div>
                  <span className="site-badge !border-primary/25 !text-primary" style={{ backgroundColor: 'rgba(0,230,118,0.09)' }}>
                    <HiOutlineSparkles size={14} /> Full Access
                  </span>

                  <h2 className="mt-5 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl">
                    {PREMIUM_PLAN.name}
                  </h2>
                  <p className="mt-3 text-base text-muted">{PREMIUM_PLAN.tagline}</p>

                  <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {PREMIUM_PLAN.features.map((f) => (
                      <li key={f} className="flex items-start gap-2.5 text-sm text-text/85">
                        <HiCheck className="mt-0.5 shrink-0 text-primary" size={17} />
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="shrink-0 text-center md:border-l md:border-white/[0.08] md:pl-12">
                  <div className="font-display text-5xl font-bold text-text">
                    ₹{PREMIUM_PLAN.price.toLocaleString('en-IN')}
                  </div>
                  <div className="mt-2 text-sm text-muted">
                    per {PREMIUM_PLAN.period}
                  </div>
                  <Link to="/pricing" className="site-cta mt-8 w-full !py-3.5">
                    View Pricing <HiOutlineArrowRight size={17} />
                  </Link>
                  <p className="mt-3 text-xs text-muted/80">
                    {PREMIUM_PLAN.duration}
                  </p>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* ===================== 10 · FAQ ===================== */}
      <FaqSection />

      {/* Section 11 (footer) is rendered by SiteLayout for every public page. */}
    </>
  );
}
