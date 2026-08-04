import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TbSearch, TbChevronDown, TbBuildingBank, TbChartCandle, TbAlertCircle } from 'react-icons/tb';

/**
 * Searchable instrument selector — the five indices plus every F&O stock.
 *
 * WHY A COMBOBOX AND NOT A <select>
 * Two hundred-odd options is past the point where a native select is usable on
 * a desktop, and the list has to carry per-row context a native <option> cannot
 * show: which category a name is in, and whether it is continuously recorded
 * (so it has history) or live-only. That second flag is the difference between
 * "this chart is empty because the market is shut" and "this instrument has no
 * history yet", and a user should not have to discover it by finding an empty
 * chart.
 *
 * FILTERING IS LOCAL. The catalogue is fetched once per session by the parent
 * and filtered in memory here — a keystroke-per-request search would be ~200
 * round trips to re-derive a list the browser already holds, which is exactly
 * the "minimal API calls" requirement.
 *
 * KEYBOARD
 *   type          filter (the input takes focus the moment the list opens)
 *   up / down     move the active option, scrolling it into view
 *   enter         select the active option
 *   escape        close without changing the selection
 *   tab           closes, because a combobox that traps tab is a trap
 *
 * The listbox is virtualisation-free on purpose: ~200 rows is well inside what
 * the browser renders without complaint, and a windowing library here would be
 * a dependency and a scroll-restoration bug for no measurable gain.
 */

const GROUP_META = {
  index: { label: 'Indices', icon: TbBuildingBank },
  stock: { label: 'F&O Stocks', icon: TbChartCandle },
};

export default function InstrumentSelector({
  indices = [],
  stocks = [],
  value,
  onChange,
  loading = false,
  error = null,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const rootRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const optionRefs = useRef([]);

  const selected = useMemo(
    () => [...indices, ...stocks].find((i) => i.symbol === value) || null,
    [indices, stocks, value]
  );

  /**
   * One flat array of {type:'group'|'option'} rows.
   *
   * Flat because arrow-key navigation has to walk options in visual order across
   * group boundaries; keeping the groups nested would mean the keyboard handler
   * re-deriving that order on every keypress.
   */
  const rows = useMemo(() => {
    const q = query.trim().toUpperCase();
    const match = (i) => !q || i.symbol.includes(q) || String(i.label).toUpperCase().includes(q);

    const out = [];
    for (const [category, items] of [['index', indices], ['stock', stocks]]) {
      const hits = items.filter(match);
      if (!hits.length) continue;
      out.push({ type: 'group', category, count: hits.length });
      for (const item of hits) out.push({ type: 'option', item });
    }
    return out;
  }, [indices, stocks, query]);

  const optionRows = useMemo(
    () => rows.map((r, i) => (r.type === 'option' ? i : -1)).filter((i) => i >= 0),
    [rows]
  );

  // Reset the highlight to the first hit whenever the filter changes, so Enter
  // always selects what the user is looking at rather than a stale row.
  useEffect(() => { setActiveIndex(optionRows[0] ?? -1); }, [optionRows]);

  // ---- open / close -------------------------------------------------------
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) close(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const commit = useCallback((item) => {
    if (item) onChange?.(item.symbol);
    close();
  }, [onChange, close]);

  /** Move the highlight n options and keep it visible without scrolling the page. */
  const move = useCallback((delta) => {
    if (!optionRows.length) return;
    const current = optionRows.indexOf(activeIndex);
    const next = current < 0
      ? 0
      : Math.min(optionRows.length - 1, Math.max(0, current + delta));
    const rowIndex = optionRows[next];
    setActiveIndex(rowIndex);
    optionRefs.current[rowIndex]?.scrollIntoView({ block: 'nearest' });
  }, [optionRows, activeIndex]);

  const onKeyDown = (e) => {
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); break;
      case 'ArrowUp': e.preventDefault(); move(-1); break;
      case 'Home': e.preventDefault(); move(-optionRows.length); break;
      case 'End': e.preventDefault(); move(optionRows.length); break;
      case 'Enter': {
        e.preventDefault();
        const row = rows[activeIndex];
        if (row?.type === 'option') commit(row.item);
        break;
      }
      case 'Escape': e.preventDefault(); close(); break;
      case 'Tab': close(); break;
      default: break;
    }
  };

  const total = indices.length + stocks.length;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select instrument"
        className="flex min-w-[9.5rem] items-center gap-2 rounded-lg border border-vega-border bg-vega-panel px-3 py-2 text-left transition-colors hover:border-vega-border-strong sm:min-w-[12rem]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-ink-900">
            {selected?.symbol || (loading ? 'Loading…' : 'Select instrument')}
          </span>
          <span className="block truncate text-2xs font-medium text-ink-500">
            {selected
              ? `${GROUP_META[selected.category]?.label ?? ''}${selected.recorded ? '' : ' · live only'}`
              : `${total} instruments`}
          </span>
        </span>
        <TbChevronDown
          size={15}
          className={`shrink-0 text-ink-500 ${open ? 'rotate-180 transition-transform' : 'transition-transform'}`}
        />
      </button>

      {open && (
        <div className="absolute left-0 z-50 mt-1.5 w-[19rem] rounded-xl border border-vega-border bg-vega-panel p-1.5 shadow-glass-lg sm:w-[22rem]">
          <div className="relative mb-1.5">
            <TbSearch size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="Search NIFTY, APLAPOLLO, ADANIPORTS…"
              aria-label="Search instruments"
              aria-controls="instrument-listbox"
              aria-activedescendant={activeIndex >= 0 ? `instrument-option-${activeIndex}` : undefined}
              className="input-dark py-1.5 pl-8 pr-2 text-xs"
            />
          </div>

          {error && (
            <p className="flex items-start gap-1.5 px-2 py-3 text-xs leading-relaxed text-vega-red">
              <TbAlertCircle size={14} className="mt-0.5 shrink-0" />
              {error}
            </p>
          )}

          {/* `overscroll-contain` keeps a flick at the end of the list from
              scrolling the page underneath it. */}
          <div
            id="instrument-listbox"
            role="listbox"
            aria-label="Instruments"
            ref={listRef}
            className="scroll-thin max-h-[19rem] overflow-y-auto overscroll-contain scroll-smooth"
          >
            {!error && rows.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-ink-500">
                {loading ? 'Loading instruments…' : `No instrument matches “${query}”.`}
              </p>
            )}

            {rows.map((row, i) => {
              if (row.type === 'group') {
                const meta = GROUP_META[row.category];
                const Icon = meta.icon;
                return (
                  <div
                    key={`group-${row.category}`}
                    role="presentation"
                    className="sticky top-0 z-10 flex items-center gap-1.5 bg-vega-panel px-2 py-1.5 text-2xs font-bold uppercase tracking-wider text-ink-500"
                  >
                    <Icon size={13} />
                    {meta.label}
                    <span className="ml-auto font-mono">{row.count}</span>
                  </div>
                );
              }

              const { item } = row;
              const isSelected = item.symbol === value;
              const isActive = i === activeIndex;

              return (
                <button
                  key={item.symbol}
                  id={`instrument-option-${i}`}
                  ref={(el) => { optionRefs.current[i] = el; }}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => commit(item)}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left transition-colors ${
                    isSelected
                      ? 'bg-vega-blue/10 text-vega-blue'
                      : isActive
                        ? 'bg-vega-panel-muted text-ink-900'
                        : 'text-ink-700'
                  }`}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-bold">{item.symbol}</span>
                    <span className="block truncate text-2xs font-medium text-ink-500">
                      {item.exchange}
                      {item.lotSize ? ` · lot ${item.lotSize}` : ''}
                    </span>
                  </span>
                  {/* Recorded instruments have history; the rest are live-only
                      until someone watches them, and saying so here is cheaper
                      than an empty historical chart later. */}
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-bold ${
                      item.recorded
                        ? 'bg-vega-green-soft text-vega-green'
                        : 'bg-vega-panel-muted text-ink-500'
                    }`}
                    title={item.recorded
                      ? `Recorded continuously at ${item.resolution}`
                      : 'Live only — history starts from first viewing'}
                  >
                    {item.recorded ? item.resolution : 'live'}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
