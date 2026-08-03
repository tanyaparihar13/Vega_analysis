import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { HiOutlineArrowRight } from 'react-icons/hi';
import { FEATURES, PLATFORM_FACTS } from '../content';

export default function Features() {
  return (
    <>
      <section className="px-5 pb-12 pt-20 text-center sm:px-6">
        <div className="mx-auto max-w-2xl">
          <span className="site-eyebrow">Features</span>
          <h1 className="mt-3 font-display text-4xl font-bold text-text sm:text-5xl">
            Everything in the terminal
          </h1>
          <p className="mt-4 text-base leading-relaxed text-text/60 sm:text-lg">
            One focused tool for Indian index option analytics, running on your own
            Zerodha Kite session.
          </p>
        </div>
      </section>

      <section className="px-5 pb-16 sm:px-6">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.2 }}
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
      </section>

      {/* How the numbers are produced — the part that separates this from a
          generic screener, and the part a serious user will ask about. */}
      <section className="border-y border-border bg-white px-5 py-20 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <div className="mb-10 text-center">
            <span className="site-eyebrow">Methodology</span>
            <h2 className="mt-3 font-display text-3xl font-bold text-text sm:text-4xl">
              How the Vega numbers are built
            </h2>
          </div>

          <ol className="space-y-4">
            {[
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
            ].map((s, i) => (
              <motion.li
                key={s.t}
                initial={{ opacity: 0, x: -12 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
                className="site-surface-soft flex gap-4 rounded-2xl p-5"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary-gradient text-sm font-bold text-white">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-display text-sm font-semibold text-text">{s.t}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-text/55">{s.d}</p>
                </div>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      <section className="px-5 py-20 sm:px-6">
        <div className="mx-auto max-w-5xl">
          <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            {PLATFORM_FACTS.map((f) => (
              <div key={f.label} className="site-card p-5 text-center">
                <div className="font-display text-xl font-bold text-text sm:text-2xl">{f.value}</div>
                <div className="mt-1 text-xs leading-snug text-text/50">{f.label}</div>
              </div>
            ))}
          </div>

          <div className="mt-12 text-center">
            <h2 className="font-display text-2xl font-bold text-text sm:text-3xl">
              Ready to see it live?
            </h2>
            <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-text/55">
              Register for an account and an administrator will review it. The public
              chart on the home page is delayed by 30 minutes.
            </p>
            <div className="mt-7 flex flex-wrap justify-center gap-3">
              <Link to="/register" className="site-btn-primary">
                Register Now <HiOutlineArrowRight size={18} />
              </Link>
              <Link to="/pricing" className="site-btn-outline">View Pricing</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
