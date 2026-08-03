import { useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HiOutlineMenu, HiOutlineX, HiOutlineLogout, HiOutlineViewGrid, HiOutlineShieldCheck,
} from 'react-icons/hi';
import logo from '../../assets/images/vega-analysis-logo.png';
import { useAuth } from '../../context/AuthContext';

/**
 * Public site navigation.
 *
 * The links are exactly the six the product brief specifies — Home, Features,
 * Pricing, Contact, Login, Register. The marketing pages that used to sit here
 * (Market / Options / Analysis / Greeks / Blog) were static mock-ups whose
 * content duplicated real dashboard features with invented numbers, so they
 * are gone rather than ported.
 *
 * AUTH IS THE APP'S OWN. The previous version of this navbar linked out to a
 * guessed Admin Panel URL on another origin and expected a token to come back
 * on a query string. Login and the dashboard now live in this same app, so
 * these are plain in-app routes and the session comes from the real
 * AuthContext.
 */

const NAV_LINKS = [
  { label: 'Home', to: '/' },
  { label: 'Features', to: '/features' },
  { label: 'Pricing', to: '/pricing' },
  { label: 'Contact', to: '/contact' },
];

export default function SiteNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const isAdmin = user?.role === 'admin';
  // Where a signed-in user's primary button goes. An admin's home is the
  // console; everyone else lands on the trading dashboard.
  const homePath = isAdmin ? '/admin' : '/dashboard';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A route change must close the drawer, otherwise tapping a link on a phone
  // navigates behind a panel that stays open over the new page.
  const closeMobile = () => setMobileOpen(false);

  const handleLogout = () => {
    logout();
    closeMobile();
    navigate('/');
  };

  const linkClass = ({ isActive }) =>
    `font-body text-sm font-medium transition-colors ${
      isActive ? 'text-primary' : 'text-text/70 hover:text-primary'
    }`;

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-300 ${
        scrolled ? 'site-glass shadow-card' : 'border-b border-transparent bg-white/60 backdrop-blur-md'
      }`}
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-5 py-3 sm:px-6">
        <Link to="/" className="flex shrink-0 items-center" onClick={closeMobile}>
          <img src={logo} alt="Vega Analysis" className="h-11 w-auto object-contain sm:h-12" />
        </Link>

        <nav className="hidden items-center gap-7 lg:flex">
          {NAV_LINKS.map((link) => (
            <NavLink key={link.label} to={link.to} end={link.to === '/'} className={linkClass}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="hidden items-center gap-2 lg:flex">
          {user ? (
            <>
              {isAdmin && (
                <Link to="/admin" className="site-btn-outline !px-4 !py-2.5 text-sm">
                  <HiOutlineShieldCheck size={16} /> Admin
                </Link>
              )}
              <Link to={homePath} className="site-btn-primary !px-5 !py-2.5 text-sm">
                <HiOutlineViewGrid size={16} /> Dashboard
              </Link>
              <button
                onClick={handleLogout}
                className="site-btn-ghost !px-3 !py-2.5 text-sm"
                title={`Sign out ${user.name || ''}`.trim()}
              >
                <HiOutlineLogout size={16} />
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="site-btn-outline !px-5 !py-2.5 text-sm">Login</Link>
              <Link to="/register" className="site-btn-primary !px-5 !py-2.5 text-sm">Register</Link>
            </>
          )}
        </div>

        <button
          className="text-text lg:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
        >
          <HiOutlineMenu size={26} />
        </button>
      </div>

      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.25 }}
            className="fixed inset-0 z-50 flex flex-col bg-white/98 backdrop-blur-xl lg:hidden"
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-4">
              <img src={logo} alt="Vega Analysis" className="h-10 w-auto object-contain" />
              <button onClick={closeMobile} className="text-text" aria-label="Close menu">
                <HiOutlineX size={26} />
              </button>
            </div>

            <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-5 py-4">
              {NAV_LINKS.map((link) => (
                <NavLink
                  key={link.label}
                  to={link.to}
                  end={link.to === '/'}
                  onClick={closeMobile}
                  className={({ isActive }) =>
                    `border-b border-border py-3.5 font-display text-base font-medium ${
                      isActive ? 'text-primary' : 'text-text'
                    }`
                  }
                >
                  {link.label}
                </NavLink>
              ))}

              <div className="mt-6 flex flex-col gap-3">
                {user ? (
                  <>
                    {isAdmin && (
                      <Link to="/admin" onClick={closeMobile} className="site-btn-outline w-full">
                        Admin Console
                      </Link>
                    )}
                    <Link to={homePath} onClick={closeMobile} className="site-btn-primary w-full">
                      Go to Dashboard
                    </Link>
                    <button onClick={handleLogout} className="site-btn-outline w-full">
                      Logout
                    </button>
                  </>
                ) : (
                  <>
                    <Link to="/login" onClick={closeMobile} className="site-btn-outline w-full">
                      Login
                    </Link>
                    <Link to="/register" onClick={closeMobile} className="site-btn-primary w-full">
                      Register
                    </Link>
                  </>
                )}
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
