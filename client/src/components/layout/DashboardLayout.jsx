import { useEffect, useState } from 'react';
import { MotionConfig } from 'framer-motion';
import Sidebar from './Sidebar';
import TopBar from './TopBar';

/**
 * App shell.
 *
 * Two things the previous version got wrong on small screens:
 *   1. the mobile drawer left the page behind it scrollable, so swiping the
 *      overlay scrolled the dashboard underneath;
 *   2. `min-w-0` was on the column but not on <main>, so any wide child (the
 *      option chain and vega tables) stretched the flex column and pushed the
 *      whole layout sideways instead of scrolling inside its own card.
 */
export default function DashboardLayout({ children, onJumpToSymbol }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Lock background scroll + allow Escape to dismiss while the drawer is open.
  useEffect(() => {
    if (!mobileOpen) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e) => { if (e.key === 'Escape') setMobileOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener('keydown', onKey);
    };
  }, [mobileOpen]);

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex min-h-screen bg-vega-black">
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          mobileOpen={mobileOpen}
          onCloseMobile={() => setMobileOpen(false)}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar onOpenMobileSidebar={() => setMobileOpen(true)} onJumpToSymbol={onJumpToSymbol} />
          <main className="mx-auto w-full min-w-0 max-w-[1700px] flex-1 space-y-4 px-3 py-4 sm:px-4 sm:py-5 lg:px-6 lg:py-6">
            {children}
          </main>
        </div>
      </div>
    </MotionConfig>
  );
}
