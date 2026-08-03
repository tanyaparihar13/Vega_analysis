import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaWhatsapp, FaYoutube, FaFacebookF, FaInstagram } from 'react-icons/fa';
import { HiOutlineArrowUp } from 'react-icons/hi';
import useSiteConfig from '../hooks/useSiteConfig';
import { SOCIAL_LINKS } from '../content';

/**
 * Floating social rail, fixed to the right edge.
 *
 * WHAT RENDERS IS WHAT EXISTS. WhatsApp's number is read at runtime from
 * `/api/public/site-config` (ADMIN_WHATSAPP_NUMBER) — the same source the
 * signup handoff and the contact form already use — so there is one place to
 * change it and no hard-coded number anywhere in the frontend. Facebook and
 * Instagram come from SOCIAL_LINKS, which ships them as null; a button appears
 * the moment a URL is filled in and nothing here needs editing.
 *
 * WhatsApp is the primary support button: it is first, larger, always
 * expanded on desktop, and carries the resting halo.
 *
 * Everything opens in a new tab with `rel="noopener noreferrer"` — these are
 * third-party origins.
 */

const BRAND = {
  whatsapp: { color: '#25D366', label: 'WhatsApp', hint: 'Chat with support' },
  youtube: { color: '#FF0033', label: 'YouTube', hint: 'Watch Vega tutorials' },
  facebook: { color: '#1877F2', label: 'Facebook', hint: 'Follow on Facebook' },
  instagram: { color: '#E1306C', label: 'Instagram', hint: 'Follow on Instagram' },
};

export default function SocialDock() {
  // Shared, cached and failure-tolerant: on error it resolves to nulls and the
  // WhatsApp button simply does not appear. A public page must never surface a
  // request failure to a passer-by.
  const whatsapp = useSiteConfig()?.adminWhatsappNumber;
  const [showTop, setShowTop] = useState(false);

  useEffect(() => {
    const onScroll = () => setShowTop(window.scrollY > 900);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const items = [
    whatsapp && {
      key: 'whatsapp',
      href: `https://wa.me/${whatsapp}`,
      Icon: FaWhatsapp,
      primary: true,
    },
    SOCIAL_LINKS.youtube && { key: 'youtube', href: SOCIAL_LINKS.youtube, Icon: FaYoutube },
    SOCIAL_LINKS.facebook && { key: 'facebook', href: SOCIAL_LINKS.facebook, Icon: FaFacebookF },
    SOCIAL_LINKS.instagram && { key: 'instagram', href: SOCIAL_LINKS.instagram, Icon: FaInstagram },
  ].filter(Boolean);

  if (!items.length) return null;

  return (
    <div className="fixed right-3 top-1/2 z-40 hidden -translate-y-1/2 flex-col items-end gap-3 sm:right-5 sm:flex">
      {items.map((item, i) => {
        const brand = BRAND[item.key];
        return (
          <motion.a
            key={item.key}
            href={item.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={brand.hint}
            initial={{ opacity: 0, x: 26 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.7 + i * 0.09, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            whileHover={{ scale: 1.12 }}
            whileTap={{ scale: 0.94 }}
            className={`site-tap-clean group relative grid place-items-center rounded-full border border-white/10 backdrop-blur-xl transition-shadow duration-300 ${
              item.primary ? 'h-14 w-14 animate-float-sm' : 'h-11 w-11'
            }`}
            style={{
              backgroundColor: 'rgba(10,15,20,0.72)',
              color: brand.color,
              boxShadow: item.primary
                ? `0 0 0 1px ${brand.color}55, 0 8px 28px -6px ${brand.color}70`
                : `0 6px 20px -8px rgba(0,0,0,0.9)`,
            }}
          >
            {/* Resting halo on the primary button only — two of these competing
                for attention would mean neither has it. */}
            {item.primary && (
              <span
                className="pointer-events-none absolute inset-0 animate-halo-pulse rounded-full blur-md"
                style={{ backgroundColor: `${brand.color}55` }}
              />
            )}

            <item.Icon size={item.primary ? 25 : 18} className="relative z-10" />

            {/* Tooltip. `translate-x-2` -> `translate-x-0` gives it a small
                slide-in rather than a hard appear. */}
            <span
              className="pointer-events-none absolute right-[calc(100%+0.7rem)] whitespace-nowrap rounded-lg border border-white/10 bg-[rgba(8,12,16,0.95)] px-3 py-1.5 font-body text-xs font-semibold text-text opacity-0 shadow-card backdrop-blur-md transition-all duration-300 translate-x-2 group-hover:translate-x-0 group-hover:opacity-100"
            >
              {brand.hint}
            </span>
          </motion.a>
        );
      })}

      {/* Back to top. Separated by a hairline so it reads as a utility rather
          than another social channel. */}
      <AnimatePresence>
        {showTop && (
          <motion.button
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ duration: 0.25 }}
            onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
            aria-label="Back to top"
            className="site-tap-clean mt-1 grid h-11 w-11 place-items-center rounded-full border border-white/10 bg-[rgba(10,15,20,0.72)] text-muted backdrop-blur-xl transition-colors hover:border-primary/40 hover:text-primary"
          >
            <HiOutlineArrowUp size={18} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Mobile support button.
 *
 * The rail above is hidden below `sm` — four circles stacked down the edge of a
 * 375px screen sit on top of the content and, worse, under the thumb. On a
 * phone only the primary channel is worth a floating control, so this is
 * WhatsApp alone, bottom-right, out of the way of the CTA flow.
 */
export function MobileSupportButton() {
  const whatsapp = useSiteConfig()?.adminWhatsappNumber;

  if (!whatsapp) return null;

  return (
    <motion.a
      href={`https://wa.me/${whatsapp}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Chat with support on WhatsApp"
      initial={{ opacity: 0, scale: 0.6 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.8, duration: 0.4 }}
      whileTap={{ scale: 0.92 }}
      className="site-tap-clean fixed bottom-5 right-4 z-40 grid h-14 w-14 place-items-center rounded-full text-white sm:hidden"
      style={{
        backgroundColor: '#25D366',
        boxShadow: '0 8px 28px -6px rgba(37,211,102,0.75)',
      }}
    >
      <span className="pointer-events-none absolute inset-0 animate-halo-pulse rounded-full bg-[#25D366]/55 blur-md" />
      <FaWhatsapp size={27} className="relative z-10" />
    </motion.a>
  );
}
