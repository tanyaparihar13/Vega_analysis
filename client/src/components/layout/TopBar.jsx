import { memo, useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { TbMenu2, TbSearch, TbBellRinging, TbChevronDown, TbLogout2, TbX } from 'react-icons/tb';
import { useAuth } from '../../context/AuthContext';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import ConnectionBadge from '../common/ConnectionBadge';
import MarketStatusBadge from '../common/MarketStatusBadge';
import { INDEX_SYMBOLS } from '../../utils/constants';

/**
 * Application top bar.
 *
 * RESPONSIVE MODEL — the old bar laid every control out in one row at every
 * width, so on a phone the search box, the role chip, the bell and the avatar
 * fought for ~200px and overlapped. Now:
 *
 *   < 640px   menu · logo-less title · search TOGGLE · avatar
 *             (search expands into its own full-width row when opened;
 *              status badges move to a second row so they stay visible)
 *   >= 640px  menu · badges · inline search · role · bell · avatar
 *   >= 1024px sidebar owns navigation, the menu button disappears
 *
 * Status badges were previously `hidden lg:flex`, which meant a tablet user had
 * no idea whether the market was open or the feed was connected. They now show
 * from the smallest width, just on their own line.
 */
function TopBar({ onOpenMobileSidebar, onJumpToSymbol }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const connectionStatus = useConnectionStatus();
  const [query, setQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const menuRef = useRef(null);
  const searchRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus the field when the mobile search row opens, so the toggle is one tap
  // rather than tap-then-tap.
  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  const matches = query
    ? INDEX_SYMBOLS.filter((s) => s.toLowerCase().includes(query.toLowerCase()))
    : [];

  const roleLabel = user?.role === 'admin' ? 'Admin' : user?.role === 'premium' ? 'Premium' : 'Free';
  const roleClass =
    user?.role === 'admin'
      ? 'border-vega-cyan/40 bg-vega-cyan/10 text-vega-cyan'
      : user?.role === 'premium'
      ? 'border-vega-blue/40 bg-vega-blue/10 text-vega-blue'
      : 'border-vega-border bg-vega-panel-muted text-ink-600';

  const pick = (s) => {
    onJumpToSymbol?.(s);
    setQuery('');
    setSearchOpen(false);
  };

  const suggestions = matches.length > 0 && (
    <div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-lg border border-vega-border bg-vega-panel shadow-glass-lg">
      {matches.map((s) => (
        <button
          key={s}
          onClick={() => pick(s)}
          className="block w-full px-3 py-2.5 text-left text-sm font-medium text-ink-700 transition-colors hover:bg-vega-blue/[0.07] hover:text-ink-900"
        >
          {s}
        </button>
      ))}
    </div>
  );

  return (
    <header className="sticky top-0 z-30 border-b border-vega-border bg-vega-panel/90 backdrop-blur-md">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:gap-3 sm:px-4 lg:px-6">
        <button
          onClick={onOpenMobileSidebar}
          className="btn-icon lg:hidden"
          aria-label="Open navigation menu"
        >
          <TbMenu2 size={20} />
        </button>

        {/* Badges inline from `sm`; below that they live on the second row. */}
        <div className="hidden items-center gap-2 sm:flex">
          <MarketStatusBadge />
          <ConnectionBadge status={connectionStatus} />
        </div>

        {/* Symbol quick-jump — inline on tablet+, a toggle on phones. */}
        <div className="relative ml-auto hidden w-full max-w-[260px] sm:block lg:max-w-xs">
          <TbSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-500" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to NIFTY, BANKNIFTY…"
            aria-label="Jump to symbol"
            className="input-dark py-1.5 pl-9 text-xs"
          />
          {suggestions}
        </div>

        <button
          onClick={() => setSearchOpen((v) => !v)}
          className="btn-icon ml-auto sm:hidden"
          aria-label={searchOpen ? 'Close search' : 'Search symbols'}
          aria-expanded={searchOpen}
        >
          {searchOpen ? <TbX size={19} /> : <TbSearch size={19} />}
        </button>

        <span className={`hidden shrink-0 rounded-full border px-2.5 py-1 text-2xs font-bold uppercase tracking-wide md:inline-block ${roleClass}`}>
          {roleLabel}
        </span>

        <button
          className="btn-icon hidden sm:inline-flex"
          aria-label="Notifications"
          title="Alerts land here once Phase 6 wiring is live"
        >
          <TbBellRinging size={19} />
        </button>

        <div className="relative shrink-0" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-1.5 transition-colors hover:bg-vega-panel-muted sm:pr-2"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-vega-blue text-xs font-bold text-white">
              {(user?.name || 'U').charAt(0).toUpperCase()}
            </span>
            <span className="hidden max-w-[120px] truncate text-sm font-semibold text-ink-800 lg:inline">
              {user?.name}
            </span>
            <TbChevronDown size={14} className="hidden text-ink-500 sm:block" />
          </button>

          {menuOpen && (
            <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-vega-border bg-vega-panel shadow-glass-lg">
              <div className="border-b border-vega-border px-3 py-2.5">
                <p className="truncate text-sm font-semibold text-ink-900">{user?.name}</p>
                <p className="break-anywhere text-xs text-ink-500">{user?.email}</p>
                <span className={`pill mt-2 md:hidden ${roleClass}`}>{roleLabel}</span>
              </div>
              <button
                onClick={() => { logout(); navigate('/login'); }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium text-ink-700 transition-colors hover:bg-vega-red-soft hover:text-vega-red"
              >
                <TbLogout2 size={16} />
                Logout
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Mobile search row — full width, so the field is actually usable. */}
      {searchOpen && (
        <div className="relative px-3 pb-2.5 sm:hidden">
          <TbSearch className="pointer-events-none absolute left-6 top-1/2 -translate-y-1/2 text-ink-500" size={16} />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to NIFTY, BANKNIFTY…"
            aria-label="Jump to symbol"
            className="input-dark pl-9 text-sm"
          />
          {matches.length > 0 && (
            <div className="absolute left-3 right-3 z-50 mt-1 overflow-hidden rounded-lg border border-vega-border bg-vega-panel shadow-glass-lg">
              {matches.map((s) => (
                <button
                  key={s}
                  onClick={() => pick(s)}
                  className="block w-full px-3 py-2.5 text-left text-sm font-medium text-ink-700 hover:bg-vega-blue/[0.07]"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Status strip for phones — keeps market/feed state visible everywhere. */}
      <div className="flex items-center gap-2 overflow-x-auto border-t border-vega-border/70 px-3 py-2 sm:hidden">
        <MarketStatusBadge />
        <ConnectionBadge status={connectionStatus} />
      </div>
    </header>
  );
}

export default memo(TopBar);
