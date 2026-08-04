import { useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiOutlineAtSymbol, HiOutlineArrowRight, HiOutlineMailOpen, HiOutlineChatAlt2,
} from 'react-icons/hi';
import api from '../api/axios';
import AuthShell, { Field, AuthError } from '../components/auth/AuthShell';

/**
 * Step 1 of the password reset: ask for the account, send the link.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO is tell the visitor whether the
 * address they typed is registered. Success and "no such account" render the
 * same confirmation, because a reset form that distinguishes them is a free
 * account-enumeration tool — type addresses until one says "sent". The server
 * returns an identical response in both cases; this screen simply does not
 * undo that by inferring anything from it.
 *
 * The one exception is a server with no mail configured, which answers 503 with
 * a distinguishable code. Showing "check your inbox" to someone whose reset
 * email can never be sent would leave them waiting on nothing, so that case
 * points them at WhatsApp instead.
 */
export default function ForgotPassword() {
  const [identifier, setIdentifier] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setUnavailable('');
    setBusy(true);
    try {
      await api.post('/auth/forgot-password', { identifier: identifier.trim() });
      setSent(true);
    } catch (err) {
      const data = err.response?.data;
      if (data?.code === 'RESET_EMAIL_UNAVAILABLE') {
        setUnavailable(data.message);
      } else {
        setError(data?.message || 'Could not send the reset link. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="If an account matches those details, we have sent a password reset link to its registered email address."
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
          <span className="grid h-16 w-16 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary shadow-glow-emerald">
            <HiOutlineMailOpen size={30} />
          </span>

          <p className="mt-6 text-sm leading-relaxed text-muted">
            The link is valid for{' '}
            <span className="font-semibold text-text">30 minutes</span> and can only be
            used once. If it does not arrive within a few minutes, check your spam
            folder.
          </p>

          <button
            type="button"
            onClick={() => { setSent(false); setIdentifier(''); }}
            className="site-btn-outline mt-7 w-full !py-3 !text-sm"
          >
            Use a different email or number
          </button>
        </motion.div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Forgot your password?"
      subtitle="Enter the email address or mobile number on your account and we will send you a reset link."
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
        <Field label="Email or mobile number" htmlFor="forgot-identifier">
          <div className="relative">
            <HiOutlineAtSymbol
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              id="forgot-identifier"
              type="text"
              required
              autoFocus
              autoComplete="username"
              className="site-input !pl-10"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="you@example.com or 9876543210"
            />
          </div>
        </Field>

        <p className="text-xs leading-relaxed text-muted/80">
          The reset link is always sent to the email address registered on the account,
          even if you look it up by mobile number.
        </p>

        <AuthError>{error}</AuthError>

        {unavailable && (
          <div className="rounded-xl border border-gold/30 bg-gold/10 px-4 py-3.5 text-sm leading-relaxed text-gold">
            <p className="flex items-start gap-2.5">
              <HiOutlineChatAlt2 size={17} className="mt-0.5 shrink-0" />
              <span>{unavailable}</span>
            </p>
            <Link
              to="/contact"
              className="mt-3 inline-block font-semibold underline underline-offset-2"
            >
              Open the contact page →
            </Link>
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !identifier.trim()}
          className="site-btn-primary w-full !py-3.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? 'Sending…' : (
            <>
              Send reset link <HiOutlineArrowRight size={17} />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
