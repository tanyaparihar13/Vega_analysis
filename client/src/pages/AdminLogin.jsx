import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HiOutlineMail, HiOutlineShieldCheck, HiOutlineArrowRight } from 'react-icons/hi';
import { useAuth } from '../context/AuthContext';
import AuthShell, { Field, AuthError } from '../components/auth/AuthShell';
import PasswordField from '../components/auth/PasswordField';

/**
 * Admin sign-in.
 *
 * The authentication call is untouched — same `adminLogin`, same destination,
 * same error handling. Restyled onto the shared auth chrome and given the same
 * show/hide password control as the other screens, so this is not the one
 * remaining form in the flow with a password field you cannot check before
 * submitting.
 *
 * No "Forgot password?" link here on purpose. The reset flow emails a link and
 * then drops the user at the ordinary /login; an admin who has forgotten their
 * password uses that same flow from the public screen, and duplicating the
 * entry point here would imply a separate admin-only reset that does not exist.
 */
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
    <AuthShell
      title="Admin Console"
      subtitle="Restricted access. Administrator credentials only."
      footer={
        <>
          Not an administrator?{' '}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Standard sign in
          </Link>
        </>
      }
    >
      <div className="mb-6 flex items-center justify-center gap-2 rounded-xl border border-accent/25 bg-accent/10 px-4 py-2.5 text-xs font-semibold text-accent">
        <HiOutlineShieldCheck size={16} />
        Restricted area
      </div>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Admin Email" htmlFor="admin-email">
          <div className="relative">
            <HiOutlineMail
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              id="admin-email"
              type="email"
              required
              autoComplete="email"
              className="site-input !pl-10"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="admin@example.com"
            />
          </div>
        </Field>

        <Field label="Password" htmlFor="admin-password">
          <PasswordField
            id="admin-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="Enter your password"
            autoComplete="current-password"
          />
        </Field>

        <AuthError>{error}</AuthError>

        <button
          type="submit"
          disabled={busy}
          className="site-btn-primary w-full !py-3.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Verifying…' : (
            <>
              Sign In as Admin <HiOutlineArrowRight size={17} />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
