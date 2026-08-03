import { create } from 'zustand';
import marketSocket, { CONNECTION_STATUS } from '../services/marketSocket';

/**
 * Global live-market state.
 *
 * ticksBySymbol is keyed by symbol (e.g. "NIFTY 50") so components can use
 * a selector like `useMarketStore((s) => s.ticksBySymbol['NIFTY 50'])` and
 * only re-render when THAT symbol's tick actually changes — not on every
 * tick for every instrument.
 */
export const useMarketStore = create((set) => ({
  ticksBySymbol: {},
  connectionStatus: CONNECTION_STATUS.IDLE,
  lastUpdatedAt: null,

  _applyTicks(ticks) {
    set((state) => {
      const next = { ...state.ticksBySymbol };
      ticks.forEach((tick) => { next[tick.symbol] = tick; });
      return { ticksBySymbol: next, lastUpdatedAt: new Date().toISOString() };
    });
  },

  _setConnectionStatus(status) {
    set({ connectionStatus: status });
  },
}));

// Wire the socket -> store exactly once per app load. The service itself is
// a singleton, so this module can be safely imported from multiple places
// (store, hooks, components) without opening duplicate connections or
// attaching duplicate listeners.
let wired = false;
export function initMarketFeed() {
  if (wired) return;
  wired = true;

  marketSocket.onMessage((message) => {
    if (message.type === 'snapshot' || message.type === 'ticks') {
      useMarketStore.getState()._applyTicks(message.data);
    }
  });

  marketSocket.onStatusChange((status) => {
    useMarketStore.getState()._setConnectionStatus(status);
  });

  marketSocket.connect();
}
