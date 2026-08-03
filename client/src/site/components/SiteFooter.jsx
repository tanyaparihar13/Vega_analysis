import { Link } from 'react-router-dom';
import logo from '../../assets/images/vega-analysis-logo.png';

/**
 * Public site footer.
 *
 * Rewritten rather than ported. The original was a five-column sitemap for a
 * full-service broker — "Crypto", "Copy Trading", "Mutual Funds & SIP",
 * "Careers", App Store / Google Play badges, a newsletter signup — none of
 * which exist. Every one was a <button> that did nothing, so the footer was
 * roughly thirty dead links.
 *
 * What is left is what the product actually has, plus the disclaimer a market
 * analytics tool needs to carry.
 */

const YEAR = new Date().getFullYear();

const PRODUCT_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Features', to: '/features' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Contact', to: '/contact' },
];

const ACCOUNT_LINKS = [
  { label: 'Login', to: '/login' },
  { label: 'Register', to: '/register' },
];

export default function SiteFooter() {
  return (
    <footer className="border-t border-border bg-slate-50">
      <div className="mx-auto max-w-7xl px-5 py-14 sm:px-6">
        <div className="grid grid-cols-1 gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="lg:col-span-2">
            <img src={logo} alt="Vega Analysis" className="h-12 w-auto object-contain" />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-text/50">
              A Vega Analysis terminal for NSE and BSE index derivatives. Call and
              Put vega tracked against the day-open baseline, every market minute,
              on a direct Zerodha Kite feed.
            </p>
          </div>

          <FooterColumn title="Product" links={PRODUCT_LINKS} />
          <FooterColumn title="Account" links={ACCOUNT_LINKS} />
        </div>

        <div className="mt-12 space-y-3 border-t border-border pt-6">
          <p className="text-xs leading-relaxed text-text/50">
            Vega Analysis is a research and analytics tool. Nothing on this site is
            investment advice, a recommendation, or an offer to trade. Derivatives
            carry substantial risk of loss. Market data is sourced from Zerodha Kite
            Connect; the public chart on this site is delayed.
          </p>
          <p className="text-xs text-text/40">© {YEAR} Vega Analysis. All rights reserved.</p>
        </div>
      </div>
    </footer>
  );
}

function FooterColumn({ title, links }) {
  return (
    <div>
      <h4 className="mb-4 font-display text-sm font-semibold text-text">{title}</h4>
      <ul className="space-y-2.5">
        {links.map((link) => (
          <li key={link.label}>
            <Link to={link.to} className="text-sm text-text/50 transition-colors hover:text-primary">
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
