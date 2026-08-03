import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      /**
       * Route by role.
       *
       * `login` returns the user, so the destination is decided from the fresh
       * response rather than from context state, which has not re-rendered yet
       * at this point in the handler.
       *
       * This used to send everyone to /dashboard, so an admin signing in
       * through the public Login link landed on the trading dashboard and had
       * to find the Admin Panel in the sidebar. The dedicated /admin/login
       * screen already did this correctly; the two now agree.
       *
       * `replace` keeps the login screen out of the history stack — otherwise
       * Back from the dashboard returns to a form the user has already used.
       */
      const user = await login(form.email, form.password);
      navigate(user?.role === 'admin' ? '/admin' : '/dashboard', { replace: true });
    } catch (err) {
      setError(err.response?.data?.message || 'Login failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-vega-black bg-[radial-gradient(circle_at_top,_rgba(47,111,237,0.12),_transparent_55%)]">
      <div className="glass-card w-full max-w-md p-8">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">
            Vega <span className="text-vega-blue-light">Analysis</span>
          </h1>
          <p className="text-sm text-gray-400 mt-1">Professional Trading Terminal</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Email</label>
            <input
              type="email" required className="input-dark w-full"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@example.com"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 block">Password</label>
            <input
              type="password" required className="input-dark w-full"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-loss text-sm">{error}</p>}

          <button type="submit" disabled={busy} className="btn-primary w-full mt-2 disabled:opacity-50">
            {busy ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <p className="text-sm text-gray-400 text-center mt-6">
          New here?{' '}
          <Link to="/register" className="text-vega-blue-light hover:underline">
            Create an account
          </Link>
        </p>
        {/* The public site is the front door now, so these screens need a way
            back to it — otherwise a visitor who clicks Login is stranded. */}
        <p className="text-xs text-gray-600 text-center mt-2">
          <Link to="/" className="hover:text-gray-400">← Back to site</Link>
          <span className="mx-2 text-gray-700">·</span>
          <Link to="/admin/login" className="hover:text-gray-400">Admin login</Link>
        </p>
      </div>
    </div>
  );
}
