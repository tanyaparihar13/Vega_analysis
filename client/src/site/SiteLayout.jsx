import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import SiteNavbar from './components/SiteNavbar';
import SiteFooter from './components/SiteFooter';
import AuroraBackground from './components/AuroraBackground';
import SocialDock, { MobileSupportButton } from './components/SocialDock';

/**
 * Chrome for every public page.
 *
 * The background is set HERE rather than on <body>, because <body> belongs to
 * the app: index.css paints it `bg-vega-black` (the terminal's off-white) and
 * the dashboard depends on that. Scoping the site's own dark theme to this
 * wrapper lets the two themes coexist in one bundle without either one
 * reaching into the other — `.site-root` carries the dark `color-scheme`,
 * scrollbars, selection colour and focus ring for the marketing pages only.
 *
 * LAYERING. AuroraBackground is `fixed` at z-0 and everything else is `relative
 * z-10`. Without the explicit z-10 the fixed layer would paint over content
 * that has no stacking context of its own.
 */
export default function SiteLayout() {
  const { pathname, hash } = useLocation();

  /**
   * Scroll restoration.
   *
   * React Router preserves scroll position across navigations, so without this
   * a visitor who scrolls to the bottom of Pricing and clicks Contact lands
   * halfway down the new page.
   *
   * The `hash` branch is what makes the Learning / YouTube / FAQ nav entries
   * work: those are anchors on the home page, and a browser will not scroll to
   * an element that did not exist at the moment the URL changed. Deferring to
   * the next frame gives React time to commit the new page first.
   */
  useEffect(() => {
    if (hash) {
      const id = hash.slice(1);
      const raf = requestAnimationFrame(() => {
        document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      return () => cancelAnimationFrame(raf);
    }
    window.scrollTo(0, 0);
    return undefined;
  }, [pathname, hash]);

  return (
    <div className="site-root relative flex min-h-screen flex-col font-body text-text">
      <AuroraBackground />

      <div className="relative z-10 flex min-h-screen flex-col">
        <SiteNavbar />
        <main className="flex-1">
          <Outlet />
        </main>
        <SiteFooter />
      </div>

      <SocialDock />
      <MobileSupportButton />
    </div>
  );
}
