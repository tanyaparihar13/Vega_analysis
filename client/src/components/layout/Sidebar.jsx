import { memo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  TbLayoutDashboard,
  TbChartHistogram,
  TbListDetails,
  TbMathFunction,
  TbChartPie2,
  TbBookmark,
  TbReceipt2,
  TbBriefcase2,
  TbRadar2,
  TbStack2,
  TbBellRinging,
  TbShieldLock,
  TbChevronsLeft,
  TbChevronsRight,
  TbX,
} from 'react-icons/tb';
import { useAuth } from '../../context/AuthContext';

// `path: null` marks a feature that is scaffolded (see client/src/features/*)
// but has no backend yet — shown with a "Soon" tag rather than as a dead link.
//
// Vega Analysis is a PRIMARY item here. It previously had no sidebar entry at
// all, so the only way to reach /vega-analysis was to type the URL.
const NAV_ITEMS = [
  { label: 'Dashboard', icon: TbLayoutDashboard, path: '/dashboard' },
  { label: 'Vega Analysis', icon: TbChartHistogram, path: '/vega-analysis' },
  { label: 'Option Chain', icon: TbListDetails, path: '/option-chain' },
  { label: 'Greeks', icon: TbMathFunction, path: '/greeks' },
  { label: 'Analytics', icon: TbChartPie2, path: '/analytics' },
  { label: 'Watchlist', icon: TbBookmark, path: '/watchlist' },
  { label: 'Orders', icon: TbReceipt2, path: null },
  { label: 'Portfolio', icon: TbBriefcase2, path: null },
  { label: 'Scanner', icon: TbRadar2, path: null },
  { label: 'Strategy Builder', icon: TbStack2, path: null },
  { label: 'Alerts', icon: TbBellRinging, path: null },
];

function Sidebar({ collapsed, onToggleCollapse, mobileOpen, onCloseMobile }) {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isAdmin = user?.role === 'admin';

  const go = (path) => {
    if (!path) return;
    navigate(path);
    onCloseMobile?.();
  };

  const content = (
    <div className="flex h-full flex-col bg-vega-panel">
      <div className={`flex items-center gap-2.5 px-4 py-4 ${collapsed ? 'lg:justify-center lg:px-0' : ''}`}>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-vega-blue to-vega-cyan text-base font-extrabold text-white shadow-sm">
          V
        </div>
        {!collapsed && (
          <span className="text-base font-bold tracking-tight text-ink-900">
            Vega <span className="text-vega-blue">Analysis</span>
          </span>
        )}
        <button
          onClick={onCloseMobile}
          className="btn-icon ml-auto lg:hidden"
          aria-label="Close menu"
        >
          <TbX size={19} />
        </button>
      </div>

      <nav className="scroll-thin flex-1 space-y-0.5 overflow-y-auto px-3 pb-3" aria-label="Main">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = item.path && location.pathname === item.path;
          return (
            <button
              key={item.label}
              onClick={() => go(item.path)}
              disabled={!item.path}
              title={collapsed ? item.label : undefined}
              aria-current={active ? 'page' : undefined}
              className={`nav-item w-full ${active ? 'nav-item-active' : ''} ${
                // Disabled, but still legible: ink-400 measured 3.5:1, under the
                // 4.5:1 floor. "Soon" carries the unavailable state instead.
                !item.path ? 'cursor-not-allowed text-ink-500' : ''
              } ${collapsed ? 'lg:justify-center' : ''}`}
            >
              <Icon size={19} className="shrink-0" />
              {!collapsed && (
                <span className="flex flex-1 items-center justify-between gap-2">
                  <span className="truncate">{item.label}</span>
                  {!item.path && (
                    <span className="shrink-0 rounded-full border border-vega-border bg-vega-panel-muted px-1.5 py-0.5 text-2xs font-bold uppercase tracking-wide text-ink-500">
                      Soon
                    </span>
                  )}
                </span>
              )}
            </button>
          );
        })}

        {isAdmin && (
          <button
            onClick={() => go('/admin')}
            title={collapsed ? 'Admin Panel' : undefined}
            aria-current={location.pathname === '/admin' ? 'page' : undefined}
            className={`nav-item w-full ${location.pathname === '/admin' ? 'nav-item-active' : ''} ${
              collapsed ? 'lg:justify-center' : ''
            }`}
          >
            <TbShieldLock size={19} className="shrink-0" />
            {!collapsed && <span>Admin Panel</span>}
          </button>
        )}
      </nav>

      <button
        onClick={onToggleCollapse}
        className="hidden items-center justify-center gap-2 border-t border-vega-border py-3 text-sm font-medium text-ink-600 transition-colors hover:bg-vega-panel-muted hover:text-ink-900 lg:flex"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? <TbChevronsRight size={17} /> : (
          <>
            <TbChevronsLeft size={17} />
            <span>Collapse</span>
          </>
        )}
      </button>
    </div>
  );

  return (
    <>
      {/* Desktop rail — sticky and self-scrolling so a long page never leaves
          the navigation stranded above the fold. */}
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 border-r border-vega-border bg-vega-panel transition-width duration-200 lg:block ${
          collapsed ? 'w-[76px]' : 'w-[236px]'
        }`}
      >
        {content}
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-ink-900/45 backdrop-blur-[2px] lg:hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={onCloseMobile}
            />
            <motion.aside
              className="fixed inset-y-0 left-0 z-50 w-[min(82vw,272px)] border-r border-vega-border bg-vega-panel shadow-glass-lg lg:hidden"
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'tween', duration: 0.22 }}
            >
              {content}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export default memo(Sidebar);
