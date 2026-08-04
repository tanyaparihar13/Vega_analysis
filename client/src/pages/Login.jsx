import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { HiOutlineMail, HiOutlineArrowRight } from 'react-icons/hi';
import { useAuth } from '../context/AuthContext';
import AuthShell, { Field, AuthError, AuthSuccess } from '../components/auth/AuthShell';
import PasswordField from '../components/auth/PasswordField';

/**
 * Sign in.
 *
 * The authentication logic is unchanged: same `login()` call, same role-based
 * destination, same error handling. What is new is the presentation, the
 * show/hide password control and the route into the reset flow.
 */
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * ResetPassword sends the user here with a confirmation rather than signing
   * them in, because approval and authentication are separate gates — a
   * pending account can legitimately reset a forgotten password without that
   * granting it a session.
   *
   * Held in state so it clears the moment the user starts a new attempt;
   * leaving "password updated" on screen next to a failed login would be
   * actively confusing.
   */
  const [notice, setNotice] = useState(state?.notice || '');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    try {
      /**
       * Route by role.
       *
       * `login` returns the user, so the destination is decided from the fresh
       * response rather than from context state, which has not re-rendered yet
       * at this point in the handler.
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
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your Vega Analysis terminal."
      footer={
        <>
          New here?{' '}
          <Link to="/register" className="font-semibold text-primary hover:underline">
            Open an account
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Email" htmlFor="login-email">
          <div className="relative">
            <HiOutlineMail
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              id="login-email"
              type="email"
              required
              autoComplete="email"
              className="site-input !pl-10"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="you@example.com"
            />
          </div>
        </Field>

        <Field
          label="Password"
          htmlFor="login-password"
          hint={
            <Link
              to="/forgot-password"
              className="text-xs font-semibold text-primary transition-opacity hover:opacity-80"
            >
              Forgot password?
            </Link>
          }
        >
          <PasswordField
            id="login-password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            placeholder="Enter your password"
            autoComplete="current-password"
          />
        </Field>

        <AuthSuccess>{notice}</AuthSuccess>
        <AuthError>{error}</AuthError>

        <button
          type="submit"
          disabled={busy}
          className="site-btn-primary w-full !py-3.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Signing in…' : (
            <>
              Sign In <HiOutlineArrowRight size={17} />
            </>
          )}
        </button>
      </form>

      <p className="mt-6 border-t border-white/[0.08] pt-5 text-center text-xs text-muted/70">
        <Link to="/admin/login" className="transition-colors hover:text-primary">
          Admin login
        </Link>
      </p>
    </AuthShell>
  );
}
