import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { HiOutlineArrowRight, HiOutlineExclamationCircle } from 'react-icons/hi';
import api from '../api/axios';
import AuthShell, { Field, AuthError } from '../components/auth/AuthShell';
import PasswordField from '../components/auth/PasswordField';
import PasswordStrength, { evaluatePassword, PASSWORD_MIN } from '../components/auth/PasswordStrength';

/**
 * Step 2 of the password reset: redeem the emailed token, set a new password.
 *
 * THE TOKEN IS VALIDATED BEFORE THE FORM IS SHOWN. Letting somebody choose a
 * password, confirm it, and only then learn that their link expired forty
 * minutes ago is the kind of small cruelty that generates support messages.
 * One cheap GET up front turns that into an immediate, actionable message.
 *
 * ON SUCCESS THE USER IS SENT TO /login, NOT SIGNED IN. Approval and
 * authentication are separate gates in this product: a pending, rejected or
 * blocked account can legitimately reset a forgotten password, but resetting it
 * must not hand out a session that the approval flow exists to withhold. The
 * server issues no token here, and /login applies the existing status checks
 * exactly as it always has.
 */
export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();

  // null = still checking, true/false = the answer.
  const [tokenValid, setTokenValid] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.get(`/auth/reset-password/${encodeURIComponent(token)}/validate`)
      .then(({ data }) => { if (alive) setTokenValid(!!data.valid); })
      // A network failure is not proof the link is bad, but the form cannot be
      // shown safely without an answer — so it fails closed and offers a retry
      // through the "request a new link" path.
      .catch(() => { if (alive) setTokenValid(false); })
      ;
    return () => { alive = false; };
  }, [token]);

  const { isValid: passwordValid } = useMemo(() => evaluatePassword(password), [password]);
  const mismatch = touched && confirm.length > 0 && password !== confirm;
  const canSubmit = passwordValid && password === confirm && confirm.length > 0;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setTouched(true);

    if (!passwordValid) {
      setError(
        `Please choose a password with at least ${PASSWORD_MIN} characters, including a letter and a number.`
      );
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      const { data } = await api.post('/auth/reset-password', { token, password });
      navigate('/login', {
        replace: true,
        state: { notice: data.message || 'Your password has been updated. You can now sign in.' },
      });
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'RESET_TOKEN_INVALID') setTokenValid(false);
      setError(data?.message || 'Could not reset your password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // ---------- checking the link ----------
  if (tokenValid === null) {
    return (
      <AuthShell title="Checking your link…" subtitle="One moment.">
        <div className="flex justify-center py-6">
          <span className="h-9 w-9 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
        </div>
      </AuthShell>
    );
  }

  // ---------- expired / already used / wrong ----------
  if (tokenValid === false) {
    return (
      <AuthShell
        title="This link has expired"
        subtitle="Password reset links are valid for 30 minutes and can only be used once."
        footer={
          <>
            Remembered it?{' '}
            <Link to="/login" className="font-semibold text-primary hover:underline">
              Back to sign in
            </Link>
          </>
        }
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center text-center"
        >
          <span className="grid h-16 w-16 place-items-center rounded-2xl border border-danger/25 bg-danger/10 text-danger">
            <HiOutlineExclamationCircle size={30} />
          </span>

          <p className="mt-6 text-sm leading-relaxed text-muted">
            If you requested more than one link, only the newest one works. Request a
            fresh link and use the most recent email.
          </p>

          <Link to="/forgot-password" className="site-btn-primary mt-7 w-full !py-3.5">
            Request a new link <HiOutlineArrowRight size={17} />
          </Link>
        </motion.div>
      </AuthShell>
    );
  }

  // ---------- set a new password ----------
  return (
    <AuthShell
      title="Create a new password"
      subtitle="Choose a strong password you have not used on this account before."
      footer={
        <>
          Remembered it?{' '}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Back to sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="New password" htmlFor="reset-password">
          <div onBlur={() => setTouched(true)}>
            <PasswordField
              id="reset-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create new password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              autoFocus
              invalid={touched && !!password && !passwordValid}
              describedBy="reset-password-strength"
            />
          </div>
          <PasswordStrength id="reset-password-strength" password={password} />
        </Field>

        <Field label="Confirm new password" htmlFor="reset-confirm">
          <div onBlur={() => setTouched(true)}>
            <PasswordField
              id="reset-confirm"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter new password"
              autoComplete="new-password"
              invalid={mismatch}
              describedBy={mismatch ? 'reset-confirm-error' : undefined}
            />
          </div>
          {mismatch && (
            <p id="reset-confirm-error" className="mt-2 text-xs font-medium text-danger">
              The two passwords do not match.
            </p>
          )}
        </Field>

        <AuthError>{error}</AuthError>

        <button
          type="submit"
          disabled={busy || !canSubmit}
          className="site-btn-primary w-full !py-3.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Updating…' : (
            <>
              Update password <HiOutlineArrowRight size={17} />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
