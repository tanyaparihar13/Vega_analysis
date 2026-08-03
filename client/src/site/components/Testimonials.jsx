import { motion } from 'framer-motion';
import { HiOutlineBadgeCheck } from 'react-icons/hi';
import { TESTIMONIALS } from '../content';

/**
 * Testimonials.
 *
 * FULLY BUILT, AND OFF UNTIL THERE IS SOMETHING REAL TO PUT IN IT.
 *
 * `TESTIMONIALS` in content.js ships empty, so this returns null and the page
 * flows straight from the analytics showcase into pricing with no gap — nothing
 * on screen looks unfinished. Add entries and the section appears, laid out and
 * animated, with no edit here:
 *
 *   { quote: '…', name: 'Full Name', role: 'Options trader, Pune', since: '2025' }
 *
 * The reason it is not pre-filled with sample quotes is that this page sells a
 * paid financial analytics product. Invented praise from traders who do not
 * exist is the exact class of claim the comment at the top of content.js exists
 * to keep off this site, and a "sample" that ships to production reads as a real
 * endorsement to every visitor who sees it.
 */

export default function Testimonials() {
  if (!TESTIMONIALS.length) return null;

  return (
    <section id="testimonials" className="relative px-5 py-20 sm:px-8 sm:py-28">
      <div className="mx-auto max-w-[1400px]">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.55 }}
          className="mx-auto mb-14 max-w-2xl text-center"
        >
          <span className="site-eyebrow">Traders</span>
          <h2 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
            What traders say
          </h2>
        </motion.div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {TESTIMONIALS.map((t, i) => (
            <motion.figure
              key={`${t.name}-${i}`}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.25 }}
              transition={{ duration: 0.45, delay: (i % 3) * 0.08 }}
              className="site-card-hover flex flex-col p-7"
            >
              <span
                aria-hidden="true"
                className="font-display text-5xl leading-none text-primary/30"
              >
                &ldquo;
              </span>

              <blockquote className="mt-2 flex-1 text-sm leading-relaxed text-muted">
                {t.quote}
              </blockquote>

              <figcaption className="mt-6 flex items-center gap-3 border-t border-white/[0.08] pt-5">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-primary-gradient font-body text-sm font-bold text-[#04120a]">
                  {t.name.trim().charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 font-body text-sm font-semibold text-text">
                    {t.name}
                    <HiOutlineBadgeCheck size={15} className="shrink-0 text-primary" />
                  </span>
                  {(t.role || t.since) && (
                    <span className="mt-0.5 block truncate text-xs text-muted">
                      {[t.role, t.since && `Member since ${t.since}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )}
                </span>
              </figcaption>
            </motion.figure>
          ))}
        </div>
      </div>
    </section>
  );
}
