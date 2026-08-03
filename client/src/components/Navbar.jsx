import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  return (
    <nav className="glass-card mx-4 mt-4 px-6 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <span className="text-lg font-bold text-slate-900">Vega <span className="text-vega-blue-light">Analysis</span></span>
        {user?.role === 'premium' && (
          <span className="text-[10px] uppercase tracking-wide bg-vega-blue/20 text-vega-blue-light px-2 py-0.5 rounded-full border border-vega-blue/40">
            Premium
          </span>
        )}
        {user?.role === 'free' && (
          <span className="text-[10px] uppercase tracking-wide bg-gray-700/40 text-gray-400 px-2 py-0.5 rounded-full">
            Free
          </span>
        )}
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-400">{user?.name}</span>
        <button
          onClick={() => { logout(); navigate('/login'); }}
          className="text-sm text-gray-400 hover:text-loss transition-colors"
        >
          Logout
        </button>
      </div>
    </nav>
  );
}
