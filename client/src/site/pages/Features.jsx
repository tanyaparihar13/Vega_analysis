import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { HiOutlineArrowRight } from 'react-icons/hi';
import { FEATURES, PLATFORM_FACTS } from '../content';

/**
 * Features.
 *
 * The methodology block is the part that separates this from a generic
 * screener, and the part a serious user will ask about — so it gets equal
 * weight to the feature grid rather than being buried in a FAQ.
 */

const EASE = [0.22, 1, 0.36, 1];

const METHOD = [
  {
    t: 'A day-open baseline is frozen each morning',
    d: 'The first usable option chain of the session is stored per strike and held immutable for the rest of the day. Every number on the chart is a change from that reference, not an absolute.',
  },
  {
    t: 'Implied volatility is solved from the traded price',
    d: 'IV is backed out of each contract\'s LTP, then Delta, Gamma, Theta and Vega are computed with Black-76 against the futures forward.',
  },
  {
    t: 'Strikes are re-selected every minute by delta',
    d: 'Each minute the eligible Call and Put strikes are recomputed from the current chain within a |delta| band, then summed against the frozen morning chain.',
  },
  {
    t: 'The three series are the differences',
    d: 'Call Vega is current call vega minus its day-open value, Put Vega the same for puts, and Difference is put minus call. Their signs give the Bullish / Bearish / Sideways read.',
  },
  {
    t: 'Every minute is written to disk',
    d: 'Samples persist as they are taken, so history accumulates on its own and any past session can be replayed exactly as it happened.',
  },
];

export default function Features() {
  return (
    <>
      <section className="relative px-5 pb-14 pt-20 text-center sm:px-8 sm:pt-28">
        <motion.div
          initial={{ opacity: 0, y: 26 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
          className="mx-auto max-w-3xl"
        >
          <span className="site-eyebrow">Features</span>
          <h1 className="mt-4 font-display text-4xl font-bold leading-tight tracking-tight text-text sm:text-5xl lg:text-6xl">
            Everything in the{' '}
            <span className="site-gradient-text">terminal</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted sm:text-lg">
            One focused tool for Indian index option analytics, running on your own
            Zerodha Kite session.
          </p>
        </motion.div>
      </section>

      <section className="relative px-5 pb-20 sm:px-8">
        <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 26 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
              transition={{ duration: 0.45, delay: (i % 3) * 0.08 }}
              className="site-card-hover group p-7"
            >
              <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl border border-primary/20 bg-primary/10 text-primary transition-all duration-300 group-hover:border-primary/50 group-hover:shadow-glow-emerald">
                <f.icon size={25} />
              </div>
              <h3 className="font-display text-lg font-bold text-text">{f.title}</h3>
              <p className="mt-2.5 text-sm leading-relaxed text-muted">{f.body}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ---------- methodology ---------- */}
      <section className="relative border-y border-white/[0.07] px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-4xl">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.55 }}
            className="mb-12 text-center"
          >
            <span className="site-eyebrow">Methodology</span>
            <h2 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
              How the Vega numbers are built
            </h2>
          </motion.div>

          <ol className="space-y-4">
            {METHOD.map((s, i) => (
              <motion.li
                key={s.t}
                initial={{ opacity: 0, x: -16 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.35 }}
                transition={{ duration: 0.4, delay: i * 0.06 }}
                className="site-card flex gap-5 p-6"
              >
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary-gradient font-body text-sm font-bold text-[#04120a] shadow-glow-emerald">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-display text-base font-bold text-text">{s.t}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{s.d}</p>
                </div>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      <section className="relative px-5 py-20 sm:px-8 sm:py-28">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-2 gap-5 sm:grid-cols-4">
            {PLATFORM_FACTS.map((f, i) => (
              <motion.div
                key={f.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.4, delay: i * 0.07 }}
                className="site-card p-6 text-center"
              >
                <div className="font-display text-2xl font-bold text-text sm:text-3xl">
                  {f.value}
                </div>
                <div className="mt-2 text-xs leading-snug text-muted">{f.label}</div>
              </motion.div>
            ))}
          </div>

          <div className="mt-16 text-center">
            <h2 className="font-display text-3xl font-bold tracking-tight text-text sm:text-4xl">
              Ready to see it live?
            </h2>
            <p className="mx-auto mt-4 max-w-md text-base leading-relaxed text-muted">
              Register for an account and an administrator will review it. The public
              chart on the home page is delayed by 30 minutes.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <Link to="/register" className="site-cta">
                Open Account <HiOutlineArrowRight size={18} />
              </Link>
              <Link to="/pricing" className="site-btn-outline !py-4 !text-base">
                View Pricing
              </Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
