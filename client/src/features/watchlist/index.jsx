// Placeholder for the "Watchlist" feature.
// Architecture is ready: this module can grow its own components/, hooks/,
// and services/ subfolders and be wired into a route + the sidebar nav
// once the backend endpoint(s) for Watchlist exist.
export default function WatchlistPlaceholder() {
  return (
    <div className="glass-card p-8 text-center text-gray-500">
      <p className="text-gray-300 font-medium mb-1">Watchlist</p>
      <p className="text-sm">Coming soon.</p>
    </div>
  );
}
