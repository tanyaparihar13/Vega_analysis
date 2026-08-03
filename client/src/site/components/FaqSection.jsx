import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { HiOutlinePlus } from 'react-icons/hi';
import { FAQS } from '../content';

/**
 * FAQ accordion.
 *
 * Built on real buttons and `aria-expanded`/`aria-controls` rather than
 * <details>/<summary>, because the height of a <details> body cannot be
 * animated — it snaps. Framer Motion animating `height: auto` is what gives the
 * panels the smooth open used everywhere else on this page.
 *
 * One panel open at a time: the list is short, and letting all six stand open
 * turns a scannable list into a wall of text.
 */

export default function FaqSection() {
  const [open, setOpen] = useState(0);

  return (
    <section id="faq" className="relative px-5 py-20 sm:px-8 sm:py-28">
      <div className="mx-auto max-w-3xl">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.3 }}
          transition={{ duration: 0.55 }}
          className="mb-12 text-center"
        >
          <span className="site-eyebrow">FAQ</span>
          <h2 className="mt-4 font-display text-3xl font-bold leading-tight tracking-tight text-text sm:text-4xl lg:text-5xl">
            Common questions
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-muted">
            Straight answers about the data, the delay and how access works.
          </p>
        </motion.div>

        <div className="space-y-3">
          {FAQS.map((f, i) => {
            const isOpen = open === i;
            return (
              <motion.div
                key={f.q}
                initial={{ opacity: 0, y: 16 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.35, delay: i * 0.05 }}
                className={`site-card overflow-hidden transition-colors ${
                  isOpen ? '!border-primary/25' : ''
                }`}
              >
                <button
                  type="button"
                  // Clicking the open item closes it, which is what a visitor
                  // expects from a toggle even when only one may be open.
                  onClick={() => setOpen(isOpen ? -1 : i)}
                  aria-expanded={isOpen}
                  aria-controls={`faq-panel-${i}`}
                  className="flex w-full items-center justify-between gap-5 px-6 py-5 text-left"
                >
                  <span className="font-body text-[15px] font-semibold text-text">
                    {f.q}
                  </span>
                  <span
                    className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border transition-all duration-300 ${
                      isOpen
                        ? 'rotate-45 border-primary/40 bg-primary/15 text-primary'
                        : 'border-white/10 text-muted'
                    }`}
                  >
                    <HiOutlinePlus size={15} />
                  </span>
                </button>

                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      id={`faq-panel-${i}`}
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                      className="overflow-hidden"
                    >
                      <p className="border-t border-white/[0.07] px-6 py-5 text-sm leading-relaxed text-muted">
                        {f.a}
                      </p>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
