import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { HiOutlineMail, HiOutlineUser, HiOutlinePhone, HiOutlineArrowRight } from 'react-icons/hi';
import { useAuth } from '../context/AuthContext';
import AuthShell, { Field, AuthError } from '../components/auth/AuthShell';
import PasswordField from '../components/auth/PasswordField';
import PasswordStrength, { evaluatePassword, PASSWORD_MIN } from '../components/auth/PasswordStrength';

/**
 * Signup step 1 of the approval flow:
 *
 *   Register -> Pending Approval -> WhatsApp opens prefilled -> user presses
 *   Send -> admin approves -> user can log in.
 *
 * The WhatsApp handoff uses the plain click-to-chat URL (https://wa.me/...),
 * NOT the WhatsApp Business API: it only opens a chat with the message typed
 * in, and the user sends it themselves. Nothing is transmitted on their behalf,
 * and the message carries identity details only — never the password.
 *
 * The registration call itself is unchanged. What is new is the show/hide
 * control, the live strength meter, and client-side password validation that
 * mirrors the server's rules so a rejection is caught before the round trip.
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
  { value: 'angelone', label: 'Angel One' },
  { value: 'dhan', label: 'Dhan' },
  { value: 'upstox', label: 'Upstox' },
  { value: 'groww', label: 'Groww' },
];

export default function Register() {
  const { register, loading } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '', email: '', password: '', mobile: '', broker: '',
  });
  const [error, setError] = useState('');
  // Only true once the field has been left, so the meter never turns red while
  // somebody is still on the third character of a good password.
  const [passwordTouched, setPasswordTouched] = useState(false);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const { isValid: passwordValid } = useMemo(
    () => evaluatePassword(form.password),
    [form.password]
  );

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    // Digits only — wa.me rejects spaces, dashes and '+'.
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

    try {
      const result = await register({ ...form, mobile });

      // Popup blockers only allow window.open inside a user gesture. This is
      // still within the submit handler's async chain, so browsers generally
      // permit it; PendingApproval also shows a manual link as a fallback.
      if (result.whatsappUrl) window.open(result.whatsappUrl, '_blank', 'noopener');

      navigate('/pending-approval', {
        replace: true,
        state: {
          name: form.name,
          email: form.email,
          mobile,
          broker: result.user?.brokerLabel
            || BROKERS.find((b) => b.value === form.broker)?.label
            || null,
          // Carried through so the pending screen — and its rebuilt WhatsApp
          // fallback — can show the same details the server put in the message.
          userId: result.user?.id ?? null,
          accountType: result.user?.accountType ?? null,
          whatsappUrl: result.whatsappUrl,
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

        <AuthError>{error}</AuthError>

        <div className="rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3.5 text-xs leading-relaxed text-muted">
          After registering, WhatsApp will open with a prefilled message to the
          administrator. <span className="font-semibold text-text">Press Send</span> to
          request approval — your account stays pending until it is approved.
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
