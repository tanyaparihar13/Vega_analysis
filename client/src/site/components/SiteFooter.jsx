import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FaWhatsapp, FaYoutube, FaFacebookF, FaInstagram } from 'react-icons/fa';
import { HiOutlineArrowRight, HiOutlineMail } from 'react-icons/hi';
import logo from '../../assets/images/vega-analysis-logo.png';
import useSiteConfig from '../hooks/useSiteConfig';
import { SOCIAL_LINKS, YOUTUBE } from '../content';

/**
 * Public site footer.
 *
 * EVERY LINK GOES SOMEWHERE REAL. The original template's footer was a
 * five-column sitemap for a full-service broker — Crypto, Copy Trading, Mutual
 * Funds, Careers, app-store badges — roughly thirty <button>s that did nothing.
 * What is here maps to routes and anchors that exist, plus the disclaimer a
 * market analytics tool has to carry.
 *
 * THE NEWSLETTER FIELD IS HONEST ABOUT ITSELF. There is no mailing-list
 * backend, and inventing a "Subscribed!" confirmation for a request that was
 * never sent is the same lie the old contact form told. So the field composes a
 * subscribe message and hands it to WhatsApp — the mechanism this product
 * already uses for signup and support — and says so in the helper text. If no
 * WhatsApp number is configured, the block does not render at all.
 */

const YEAR = new Date().getFullYear();

const PRODUCT_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Features', to: '/features' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Vega Dashboard', to: '/dashboard' },
];

const LEARN_LINKS = [
  { label: 'Learning', hash: 'learning' },
  { label: 'YouTube Channel', href: YOUTUBE.channelUrl },
  { label: 'Analytics', hash: 'analytics' },
  { label: 'FAQ', hash: 'faq' },
];

const ACCOUNT_LINKS = [
  { label: 'Login', to: '/login' },
  { label: 'Open Account', to: '/register' },
  { label: 'Contact & Support', to: '/contact' },
];

export default function SiteFooter() {
  const config = useSiteConfig();
  const whatsapp = config?.adminWhatsappNumber;
  const [email, setEmail] = useState('');

  const socials = [
    whatsapp && { key: 'wa', href: `https://wa.me/${whatsapp}`, Icon: FaWhatsapp, label: 'WhatsApp', color: '#25D366' },
    SOCIAL_LINKS.youtube && { key: 'yt', href: SOCIAL_LINKS.youtube, Icon: FaYoutube, label: 'YouTube', color: '#FF0033' },
    SOCIAL_LINKS.facebook && { key: 'fb', href: SOCIAL_LINKS.facebook, Icon: FaFacebookF, label: 'Facebook', color: '#1877F2' },
    SOCIAL_LINKS.instagram && { key: 'ig', href: SOCIAL_LINKS.instagram, Icon: FaInstagram, label: 'Instagram', color: '#E1306C' },
  ].filter(Boolean);

  const subscribe = (e) => {
    e.preventDefault();
    if (!whatsapp || !email.trim()) return;
    const text = `Vega Analysis — please add me to updates.\n\nEmail: ${email.trim()}`;
    window.open(`https://wa.me/${whatsapp}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  };

  return (
    <footer className="relative z-10 border-t border-white/10 bg-[rgba(5,7,9,0.72)] backdrop-blur-xl">
      <div className="mx-auto max-w-[1400px] px-5 pb-10 pt-16 sm:px-8">
        <div className="grid grid-cols-1 gap-10 lg:grid-cols-[1.5fr_1fr_1fr_1fr] lg:gap-8">
          {/* ---------- brand ---------- */}
          <div>
            <div className="flex items-center gap-2.5">
              <img src={logo} alt="" className="h-11 w-auto object-contain" />
              <span className="font-display text-xl font-bold tracking-tight text-text">
                Vega <span className="site-gradient-text">Analysis</span>
              </span>
            </div>
            <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted">
              A professional Vega analytics terminal for NSE and BSE index derivatives.
              Call and Put vega tracked against the day-open baseline, every market
              minute, on a direct Zerodha Kite feed.
            </p>

            {socials.length > 0 && (
              <div className="mt-6 flex items-center gap-2.5">
                {socials.map((s) => (
                  <a
                    key={s.key}
                    href={s.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={s.label}
                    className="site-tap-clean grid h-10 w-10 place-items-center rounded-xl border border-white/10 text-muted transition-all duration-300 hover:-translate-y-0.5"
                    style={{ backgroundColor: 'rgba(255,255,255,0.04)' }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = s.color;
                      e.currentTarget.style.boxShadow = `0 8px 24px -8px ${s.color}90`;
                      e.currentTarget.style.borderColor = `${s.color}66`;
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = '';
                      e.currentTarget.style.boxShadow = '';
                      e.currentTarget.style.borderColor = '';
                    }}
                  >
                    <s.Icon size={17} />
                  </a>
                ))}
              </div>
            )}
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Learn" links={LEARN_LINKS} />
          <FooterColumn title="Account" links={ACCOUNT_LINKS} />
        </div>

        {/* ---------- newsletter ---------- */}
        {whatsapp && (
          <div className="mt-14 rounded-2xl border border-white/[0.08] bg-glass-sheen p-6 sm:p-8">
            <div className="grid grid-cols-1 items-center gap-6 md:grid-cols-[1.1fr_1fr]">
              <div>
                <h3 className="font-display text-xl font-bold text-text">
                  Get Vega updates
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">
                  Product changes, new analytics and market notes. Your address is sent
                  to us over WhatsApp — you press Send, nothing goes on your behalf.
                </p>
              </div>

              <form onSubmit={subscribe} className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <HiOutlineMail
                    size={17}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@email.com"
                    aria-label="Email address"
                    className="site-input !pl-10"
                  />
                </div>
                <button type="submit" className="site-btn-primary shrink-0 !px-6">
                  Subscribe <HiOutlineArrowRight size={16} />
                </button>
              </form>
            </div>
          </div>
        )}

        {/* ---------- legal ---------- */}
        <div className="mt-12 space-y-4 border-t border-white/[0.08] pt-7">
          <p className="text-xs leading-relaxed text-muted/80">
            Vega Analysis is a research and analytics tool. Nothing on this site is
            investment advice, a recommendation, or an offer to trade. Derivatives carry
            substantial risk of loss and you may lose more than your initial capital.
            Market data is sourced from Zerodha Kite Connect; the chart shown publicly on
            this site is delayed by 30 minutes. Past market behaviour does not predict
            future results.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
            <p className="text-xs text-muted/70">
              © {YEAR} Vega Analysis. All rights reserved.
            </p>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted/70">
              <Link to="/contact" className="transition-colors hover:text-primary">
                Privacy
              </Link>
              <Link to="/contact" className="transition-colors hover:text-primary">
                Terms
              </Link>
              <Link to="/contact" className="transition-colors hover:text-primary">
                Risk Disclosure
              </Link>
              <Link to="/contact" className="transition-colors hover:text-primary">
                Support
              </Link>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

/**
 * A column of links.
 *
 * Three link shapes, because the footer legitimately points at three kinds of
 * destination: `to` for in-app routes, `hash` for anchors on the home page
 * (which is how Learning / Analytics / FAQ are reachable without adding routes),
 * and `href` for external sites.
 */
function FooterColumn({ title, links }) {
  return (
    <div>
      <h4 className="mb-4 font-body text-xs font-bold uppercase tracking-[0.18em] text-text">
        {title}
      </h4>
      <ul className="space-y-2.5">
        {links.map((link) => (
          <li key={link.label}>
            {link.href ? (
              <a
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-muted transition-colors hover:text-primary"
              >
                {link.label}
              </a>
            ) : link.hash ? (
              <a
                href={`/#${link.hash}`}
                className="text-sm text-muted transition-colors hover:text-primary"
              >
                {link.label}
              </a>
            ) : (
              <Link
                to={link.to}
                className="text-sm text-muted transition-colors hover:text-primary"
              >
                {link.label}
              </Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
