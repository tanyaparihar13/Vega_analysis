import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { HiOutlineArrowRight, HiCheck } from 'react-icons/hi';
import DelayedVegaPanel from '../components/DelayedVegaPanel';
import { FEATURES, PLATFORM_FACTS, ACCESS_STEPS, PREMIUM_PLAN } from '../content';
import { useAuth } from '../../context/AuthContext';

/**
 * Public landing page.
 *
 * The hero's right-hand side is the real delayed Vega chart rather than the
 * decorative fake portfolio card the template shipped with — it is the single
 * most persuasive thing this product has, and it is genuine data.
 */

const fadeUp = {
  hidden: { opacity: 0, y: 22 },
  show: { opacity: 1, y: 0 },
};

export default function Home() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  return (
    <>
      {/* ================= HERO ================= */}
      <section className="relative overflow-hidden px-5 pb-16 pt-12 sm:px-6 md:pt-20">
        {/*
          `grid-cols-1` is not decorative. Without an explicit single-column
          track below `lg`, the implicit track sizes to its content — and the
          content is a lightweight-charts canvas carrying an inline pixel
          width. The track then locks to the chart's last width, the chart
          measures that track, and the two hold each other wide: on a 375px
          phone the hero laid out at 546px, clipped rather than visible only
          because index.css sets `overflow-x: clip` on the body.

          `min-w-0` on the chart column is the same guard for the `lg` case.
        */}
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <motion.div initial="hidden" animate="show" variants={fadeUp} transition={{ duration: 0.55 }}>
            <span className="site-eyebrow mb-5 inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1 !tracking-wider">
              NSE &amp; BSE index derivatives
            </span>

            <h1 className="font-display text-4xl font-bold leading-[1.12] text-text sm:text-5xl lg:text-[3.4rem]">
              See where option writers are{' '}
              <span className="bg-primary-gradient bg-clip-text text-transparent">
                really positioned
              </span>
            </h1>

            <p className="mt-6 max-w-xl text-base leading-relaxed text-text/60 sm:text-lg">
              A professional Vega Analysis terminal for NIFTY, BANKNIFTY, FINNIFTY,
              MIDCPNIFTY and SENSEX — built directly on a Zerodha Kite feed, recording
              every market minute so you can replay any session.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              {user ? (
                <Link to={isAdmin ? '/admin' : '/dashboard'} className="site-btn-primary">
                  Open {isAdmin ? 'Admin Console' : 'Dashboard'} <HiOutlineArrowRight size={18} />
                </Link>
              ) : (
                <>
                  <Link to="/register" className="site-btn-primary">
                    Register Now <HiOutlineArrowRight size={18} />
                  </Link>
                  <Link to="/login" className="site-btn-outline">Login</Link>
                </>
              )}
            </div>

            {!user && (
              <p className="mt-3.5 text-xs text-text/45">
                New accounts are reviewed by an administrator before access is granted.
              </p>
            )}

            <div className="mt-11 grid grid-cols-2 gap-6 border-t border-border pt-8 sm:grid-cols-4">
              {PLATFORM_FACTS.map((f) => (
                <div key={f.label}>
                  <div className="font-display text-xl font-bold text-text sm:text-2xl">
                    {f.value}
                  </div>
                  <div className="mt-1 text-xs leading-snug text-text/50">{f.label}</div>
                </div>
              ))}
            </div>
          </motion.div>

          <motion.div
            className="min-w-0"
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.6, delay: 0.12 }}
          >
            <DelayedVegaPanel />
          </motion.div>
        </div>
      </section>

      {/* ================= FEATURES ================= */}
      <section className="px-5 py-20 sm:px-6">
        <div className="mx-auto max-w-7xl">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <span className="site-eyebrow">What you get</span>
            <h2 className="mt-3 font-display text-3xl font-bold text-text sm:text-4xl">
              Built for one job, done properly
            </h2>
            <p className="mt-4 text-base leading-relaxed text-text/60">
              Not a general trading platform. A focused Vega Analysis terminal for
              Indian index options.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.slice(0, 6).map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.25 }}
                transition={{ duration: 0.4, delay: (i % 3) * 0.07 }}
                className="site-card group p-6 transition-colors hover:border-primary/30"
              >
                <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary-gradient group-hover:text-white">
                  <f.icon size={22} />
                </div>
                <h3 className="font-display text-base font-semibold text-text">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-text/55">{f.body}</p>
              </motion.div>
            ))}
          </div>

          <div className="mt-10 text-center">
            <Link to="/features" className="site-btn-outline">
              See all features <HiOutlineArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* ================= HOW ACCESS WORKS ================= */}
      <section className="border-y border-border bg-white px-5 py-20 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <span className="site-eyebrow">Getting access</span>
            <h2 className="mt-3 font-display text-3xl font-bold text-text sm:text-4xl">
              Three steps to the terminal
            </h2>
          </div>

          <ol className="grid grid-cols-1 gap-8 sm:grid-cols-3">
            {ACCESS_STEPS.map((s, i) => (
              <motion.li
                key={s.n}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.4, delay: i * 0.1 }}
                className="text-center"
              >
                <div className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-full bg-primary-gradient font-display font-bold text-white shadow-glow">
                  {s.n}
                </div>
                <h3 className="font-display text-base font-semibold text-text">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-text/55">{s.body}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      {/* ================= PRICING TEASER ================= */}
      <section className="px-5 py-20 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <div className="site-card relative overflow-hidden border-2 border-primary/40 bg-gradient-to-b from-primary/[0.07] to-white p-8 sm:p-10">
            <div className="grid grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
              <div>
                <span className="site-eyebrow">Pricing</span>
                <h2 className="mt-3 font-display text-2xl font-bold text-text sm:text-3xl">
                  {PREMIUM_PLAN.name}
                </h2>
                <p className="mt-2 text-sm text-text/55">{PREMIUM_PLAN.tagline}</p>

                <ul className="mt-6 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {PREMIUM_PLAN.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-sm text-text/75">
                      <HiCheck className="mt-0.5 shrink-0 text-success" size={16} />
                      {f}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="shrink-0 text-center md:border-l md:border-border md:pl-8">
                <div className="font-display text-4xl font-bold text-text">
                  ₹{PREMIUM_PLAN.price.toLocaleString('en-IN')}
                </div>
                <div className="mt-1 text-sm text-text/45">per {PREMIUM_PLAN.period}</div>
                <Link to="/pricing" className="site-btn-primary mt-6 w-full">
                  View Pricing
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
