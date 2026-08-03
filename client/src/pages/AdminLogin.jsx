import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function AdminLogin() {
  const { adminLogin } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await adminLogin(form.email, form.password);
      navigate('/admin');
    } catch (err) {
      setError(err.response?.data?.message || 'Invalid admin credentials');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-vega-black">
      <div className="glass-card w-full max-w-md p-8 border-vega-blue/30">
        <div className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-slate-900">Admin Console</h1>
          <p className="text-sm text-gray-400 mt-1">Vega Analysis — Restricted Access</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email" required placeholder="Admin email" className="input-dark w-full"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            type="password" required placeholder="Password" className="input-dark w-full"
            value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
          {error && <p className="text-loss text-sm">{error}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-50">
            {busy ? 'Verifying…' : 'Sign In as Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}
