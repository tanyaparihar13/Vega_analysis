import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  HiOutlineMenu, HiOutlineX, HiOutlineLogout, HiOutlineViewGrid, HiOutlineShieldCheck,
  HiOutlineArrowRight,
} from 'react-icons/hi';
import logo from '../../assets/images/vega-analysis-logo.png';
import { useAuth } from '../../context/AuthContext';
import { NAV_LINKS } from '../content';

/**
 * Public site navigation.
 *
 * TRANSPARENT AT REST, GLASS ON SCROLL. At the top of the page the header has
 * no surface at all so the hero reads full-bleed; past 12px it fades in a
 * blurred dark pane, a hairline and a shadow. Both states are the same element
 * with a transition, never a swap, so nothing jumps.
 *
 * AUTH IS THE APP'S OWN. Login and the dashboard live in this same app, so
 * these are plain in-app routes and the session comes from the real
 * AuthContext. Nothing about the auth flow is changed here.
 *
 * TWO KINDS OF LINK. `to` entries are router paths. `hash` entries are
 * anchors on the home page, resolved to `/#id` so they also work from
 * /pricing or /contact — which is what lets Learning / YouTube / FAQ exist in
 * the nav without adding routes to App.jsx.
 */

/**
 * The emerald underline that slides in on hover / active.
 *
 * Hoisted out of the component on purpose: declaring it inside would create a
 * new component type on every render, so React would unmount and remount each
 * underline and the transition would never get a chance to run.
 */
function Underline({ active }) {
  return (
    <span
      className={`absolute -bottom-0.5 left-0 h-px w-full origin-left bg-primary-gradient transition-transform duration-300 ${
        active ? 'scale-x-100' : 'scale-x-0 group-hover:scale-x-100'
      }`}
    />
  );
}

export default function SiteNavbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname, hash } = useLocation();

  const isAdmin = user?.role === 'admin';
  // Where a signed-in user's primary button goes. An admin's home is the
  // console; everyone else lands on the trading dashboard.
  const homePath = isAdmin ? '/admin' : '/dashboard';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll(); // a reload part-way down the page must start in the right state
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // A route change must close the drawer, otherwise tapping a link on a phone
  // navigates behind a panel that stays open over the new page.
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // The drawer is a full-screen overlay; leaving the page scrollable behind it
  // means a swipe moves the content the user cannot see.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [mobileOpen]);

  // Escape closes the drawer — expected of anything modal.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeMobile(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mobileOpen, closeMobile]);

  const handleLogout = () => {
    logout();
    closeMobile();
    navigate('/');
  };

  const isHashActive = (id) => pathname === '/' && hash === `#${id}`;

  const desktopLinkClass = (active) =>
    `relative py-1 font-body text-sm font-medium transition-colors duration-200 ${
      active ? 'text-primary' : 'text-muted hover:text-text'
    }`;

  return (
    <header
      className={`sticky top-0 z-50 transition-all duration-500 ${
        scrolled
          ? 'border-b border-white/10 bg-[rgba(5,5,5,0.72)] shadow-[0_8px_32px_-16px_rgba(0,0,0,0.9)] backdrop-blur-xl'
          : 'border-b border-transparent bg-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-5 py-3.5 sm:px-8">
        {/* ---------- logo ---------- */}
        <Link
          to="/"
          className="group flex shrink-0 items-center gap-2.5"
          onClick={closeMobile}
        >
          <img
            src={logo}
            alt=""
            className="h-10 w-auto object-contain transition-transform duration-300 group-hover:scale-105 sm:h-11"
          />
          <span className="hidden font-display text-lg font-bold tracking-tight text-text sm:block">
            Vega <span className="site-gradient-text">Analysis</span>
          </span>
        </Link>

        {/* ---------- desktop nav ---------- */}
        <nav className="hidden items-center gap-6 xl:flex">
          {NAV_LINKS.map((link) =>
            link.hash ? (
              <a
                key={link.label}
                href={`/#${link.hash}`}
                className={`group ${desktopLinkClass(isHashActive(link.hash))}`}
              >
                {link.label}
                <Underline active={isHashActive(link.hash)} />
              </a>
            ) : (
              <NavLink
                key={link.label}
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) => `group ${desktopLinkClass(isActive)}`}
              >
                {({ isActive }) => (
                  <>
                    {link.label}
                    <Underline active={isActive} />
                  </>
                )}
              </NavLink>
            )
          )}
        </nav>

        {/* ---------- desktop actions ---------- */}
        <div className="hidden items-center gap-2.5 xl:flex">
          {user ? (
            <>
              {isAdmin && (
                <Link to="/admin" className="site-btn-outline !px-4 !py-2.5 !text-sm">
                  <HiOutlineShieldCheck size={16} /> Admin
                </Link>
              )}
              <Link to={homePath} className="site-btn-primary !px-5 !py-2.5 !text-sm">
                <HiOutlineViewGrid size={16} /> Dashboard
              </Link>
              <button
                onClick={handleLogout}
                className="site-btn-ghost !px-3 !py-2.5 !text-sm"
                title={`Sign out ${user.name || ''}`.trim()}
                aria-label="Sign out"
              >
                <HiOutlineLogout size={16} />
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                className="px-3 py-2.5 font-body text-sm font-semibold text-muted transition-colors hover:text-text"
              >
                Login
              </Link>
              <Link to="/register" className="site-btn-primary !px-5 !py-2.5 !text-sm">
                Open Account <HiOutlineArrowRight size={15} />
              </Link>
            </>
          )}
        </div>

        {/* ---------- mobile trigger ---------- */}
        <button
          className="site-tap-clean rounded-lg p-1.5 text-text xl:hidden"
          onClick={() => setMobileOpen(true)}
          aria-label="Open menu"
          aria-expanded={mobileOpen}
        >
          <HiOutlineMenu size={26} />
        </button>
      </div>

      {/* ---------- mobile drawer ---------- */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 xl:hidden"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
          >
            <div
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={closeMobile}
            />

            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.34 }}
              className="absolute inset-y-0 right-0 flex w-full max-w-sm flex-col border-l border-white/10 bg-[rgba(6,9,12,0.97)] backdrop-blur-2xl"
            >
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <img src={logo} alt="" className="h-9 w-auto object-contain" />
                  <span className="font-display text-base font-bold text-text">
                    Vega <span className="site-gradient-text">Analysis</span>
                  </span>
                </div>
                <button
                  onClick={closeMobile}
                  className="site-tap-clean rounded-lg p-1 text-muted transition-colors hover:text-text"
                  aria-label="Close menu"
                >
                  <HiOutlineX size={26} />
                </button>
              </div>

              <nav className="flex flex-1 flex-col overflow-y-auto px-5 py-3">
                {NAV_LINKS.map((link, i) => {
                  const label = (
                    <motion.span
                      initial={{ opacity: 0, x: 18 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.06 + i * 0.035, duration: 0.28 }}
                      className="block"
                    >
                      {link.label}
                    </motion.span>
                  );

                  const cls =
                    'border-b border-white/[0.06] py-3.5 font-body text-[15px] font-medium '
                    + 'text-muted transition-colors hover:text-primary';

                  return link.hash ? (
                    <a
                      key={link.label}
                      href={`/#${link.hash}`}
                      onClick={closeMobile}
                      className={cls}
                    >
                      {label}
                    </a>
                  ) : (
                    <NavLink
                      key={link.label}
                      to={link.to}
                      end={link.to === '/'}
                      onClick={closeMobile}
                      className={({ isActive }) =>
                        `${cls} ${isActive ? '!text-primary' : ''}`
                      }
                    >
                      {label}
                    </NavLink>
                  );
                })}

                <div className="mt-7 flex flex-col gap-3 pb-8">
                  {user ? (
                    <>
                      {isAdmin && (
                        <Link to="/admin" onClick={closeMobile} className="site-btn-outline w-full">
                          <HiOutlineShieldCheck size={17} /> Admin Console
                        </Link>
                      )}
                      <Link to={homePath} onClick={closeMobile} className="site-btn-primary w-full">
                        <HiOutlineViewGrid size={17} /> Go to Dashboard
                      </Link>
                      <button onClick={handleLogout} className="site-btn-outline w-full">
                        <HiOutlineLogout size={17} /> Logout
                      </button>
                    </>
                  ) : (
                    <>
                      <Link to="/register" onClick={closeMobile} className="site-btn-primary w-full">
                        Open Account <HiOutlineArrowRight size={16} />
                      </Link>
                      <Link to="/login" onClick={closeMobile} className="site-btn-outline w-full">
                        Login
                      </Link>
                    </>
                  )}
                </div>
              </nav>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
