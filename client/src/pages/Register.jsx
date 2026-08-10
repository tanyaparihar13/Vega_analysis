import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HiOutlineMail, HiOutlineUser, HiOutlinePhone, HiOutlineArrowRight } from 'react-icons/hi';
import { useAuth } from '../context/AuthContext';
import AuthShell, { Field, AuthError } from '../components/auth/AuthShell';
import PasswordField from '../components/auth/PasswordField';
import PasswordStrength, { evaluatePassword, PASSWORD_MIN } from '../components/auth/PasswordStrength';

/**
 * Signup step 1 of 2.
 *
 *   Register (identity + demat broker) -> Onboarding (choose an access route)
 *   -> WhatsApp -> admin approves -> user can log in.
 *
 * TWO DIFFERENT QUESTIONS, TWO DIFFERENT FIELDS.
 * The Demat Broker dropdown here asks "which broker do you ALREADY trade
 * through?" and is stored in users.broker. The next screen asks "how do you
 * want to get access?" and stores that in user_onboarding.selected_option.
 * They are not the same fact and neither overwrites the other — a user can hold
 * a Zerodha account today and still be willing to open a Dhan account to get
 * in, and the admin needs both halves before they call.
 *
 * WHAT DID MOVE: opening WhatsApp. It used to fire the instant the account was
 * created, which sent the admin a bare "someone signed up". It now fires after
 * the onboarding choice, so every message that arrives says what the person
 * actually wants.
 */

/**
 * Demat brokers, in the order the form shows them.
 *
 * `value` must match the `broker` ENUM in server/src/schema.sql and the BROKERS
 * map in server/src/controllers/authController.js. The server is authoritative:
 * anything it does not recognise comes back as a 400 naming the accepted keys,
 * so a mismatch here fails loudly at signup rather than storing a bad value.
 */
const BROKERS = [
  { value: 'zerodha', label: 'Zerodha' },
  { value: 'dhan', label: 'Dhan' },
  { value: 'upstox', label: 'Upstox' },
  { value: 'groww', label: 'Groww' },
  { value: 'angelone', label: 'Angel One' },
];

export default function Register() {
  const { register, loading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '', email: '', password: '', confirmPassword: '', mobile: '', broker: '',
  });
  const [error, setError] = useState('');
  // Only true once the field has been left, so the meter never turns red while
  // somebody is still on the third character of a good password.
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [confirmTouched, setConfirmTouched] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const { isValid: passwordValid } = useMemo(
    () => evaluatePassword(form.password),
    [form.password]
  );

  const confirmMismatch = !!form.confirmPassword && form.confirmPassword !== form.password;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Digits only — wa.me rejects spaces, dashes and '+', and this number is
    // what the onboarding handoff quotes to the admin.
    const mobile = form.mobile.replace(/\D/g, '');
    if (mobile.length < 10) {
      setError('Please enter a valid mobile number (at least 10 digits).');
      return;
    }
    if (!form.broker) {
      setError('Please select your demat broker.');
      return;
    }
    if (!passwordValid) {
      setPasswordTouched(true);
      setError(
        `Please choose a password with at least ${PASSWORD_MIN} characters, including a letter and a number.`
      );
      return;
    }
    if (form.confirmPassword !== form.password) {
      setConfirmTouched(true);
      setError('The two passwords do not match.');
      return;
    }

    try {
      const result = await register({ ...form, mobile });

      // The onboarding token is already in sessionStorage (see AuthContext).
      // These details ride along purely so the next screen can greet the user
      // and show what will be sent — it re-reads nothing sensitive.
      navigate('/onboarding', {
        replace: true,
        state: {
          name: form.name,
          email: form.email,
          mobile,
          broker: result.user?.brokerLabel
            || BROKERS.find((b) => b.value === form.broker)?.label
            || null,
          userId: result.user?.id ?? null,
        },
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    }
  };

  return (
    <AuthShell
      title="Open your account"
      subtitle="Register for the Vega Analysis terminal. An administrator reviews every account before access is granted."
      width="max-w-lg"
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-5">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          <Field label="Full Name" htmlFor="reg-name">
            <div className="relative">
              <HiOutlineUser
                size={17}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                id="reg-name" required autoComplete="name" className="site-input !pl-10"
                value={form.name} onChange={set('name')} placeholder="Jane Trader"
              />
            </div>
          </Field>

          <Field label="Mobile Number" htmlFor="reg-mobile">
            <div className="relative">
              <HiOutlinePhone
                size={17}
                className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
                aria-hidden="true"
              />
              <input
                id="reg-mobile" type="tel" required autoComplete="tel" inputMode="numeric"
                className="site-input !pl-10"
                value={form.mobile} onChange={set('mobile')} placeholder="9876543210"
              />
            </div>
          </Field>
        </div>

        <Field label="Email" htmlFor="reg-email">
          <div className="relative">
            <HiOutlineMail
              size={17}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
              aria-hidden="true"
            />
            <input
              id="reg-email" type="email" required autoComplete="email"
              className="site-input !pl-10"
              value={form.email} onChange={set('email')} placeholder="you@example.com"
            />
          </div>
        </Field>

        <Field label="Demat Broker" htmlFor="reg-broker">
          <select
            id="reg-broker" required className="site-input"
            value={form.broker} onChange={set('broker')}
          >
            <option value="" disabled>Select your broker</option>
            {BROKERS.map((b) => (
              <option key={b.value} value={b.value}>{b.label}</option>
            ))}
          </select>
        </Field>

        <Field label="Password" htmlFor="reg-password">
          <div onBlur={() => setPasswordTouched(true)}>
            <PasswordField
              id="reg-password"
              value={form.password}
              onChange={set('password')}
              placeholder="Create new password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              invalid={passwordTouched && !!form.password && !passwordValid}
              describedBy="reg-password-strength"
            />
          </div>
          <PasswordStrength id="reg-password-strength" password={form.password} />
        </Field>

        <Field label="Confirm Password" htmlFor="reg-confirm">
          <div onBlur={() => setConfirmTouched(true)}>
            <PasswordField
              id="reg-confirm"
              value={form.confirmPassword}
              onChange={set('confirmPassword')}
              placeholder="Re-enter your password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              invalid={confirmTouched && confirmMismatch}
              describedBy="reg-confirm-hint"
            />
          </div>
          {/* Announced politely rather than assertively: this fires while the
              user is still typing the second password, and an assertive live
              region would interrupt a screen reader on every keystroke. */}
          <p
            id="reg-confirm-hint"
            aria-live="polite"
            className={`mt-1.5 text-xs ${confirmTouched && confirmMismatch ? 'text-danger' : 'text-muted/70'}`}
          >
            {confirmTouched && confirmMismatch
              ? 'The two passwords do not match.'
              : 'Type your password a second time to confirm it.'}
          </p>
        </Field>

        <AuthError>{error}</AuthError>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3.5 text-xs leading-relaxed text-muted">
          Next, you will choose how you would like to get access —{' '}
          <span className="font-semibold text-text">Lifetime Access</span>, or opening a
          broking account with <span className="font-semibold text-text">Dhan</span> or{' '}
          <span className="font-semibold text-text">Angel One</span>.
        </div>

        <button
          type="submit"
          disabled={loading}
          className="site-btn-primary w-full !py-3.5 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? 'Creating account…' : (
            <>
              Create Account <HiOutlineArrowRight size={17} />
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
