import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import SiteNavbar from './components/SiteNavbar';
import SiteFooter from './components/SiteFooter';

/**
 * Chrome for every public page.
 *
 * The background is set HERE rather than on <body>, because <body> belongs to
 * the app: index.css paints it `bg-vega-black` (the terminal's off-white) and
 * the dashboard depends on that. Scoping the site's own background to this
 * wrapper lets the two themes coexist in one bundle without either one
 * reaching into the other.
 */
export default function SiteLayout() {
  const { pathname } = useLocation();

  // React Router preserves scroll position across navigations, so without this
  // a visitor who scrolls to the bottom of Pricing and clicks Contact lands
  // halfway down the new page.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  return (
    <div className="flex min-h-screen flex-col bg-background bg-grid-glow bg-fixed font-body text-text">
      <SiteNavbar />
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}
