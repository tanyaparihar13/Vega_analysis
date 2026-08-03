import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Signup step 1 of the approval flow:
 *
 *   Register -> Pending Approval -> WhatsApp opens prefilled -> user presses
 *   Send -> admin approves -> user can log in.
 *
 * The WhatsApp handoff uses the plain click-to-chat URL (https://wa.me/...),
 * NOT the WhatsApp Business API: it only opens a chat with the message typed
 * in, and the user sends it themselves. Nothing is transmitted on their behalf.
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

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

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
          whatsappUrl: result.whatsappUrl,
        },
      });
    } catch (err) {
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-vega-black px-4 py-10">
      <div className="glass-card w-full max-w-md p-8">
        <div className="mb-7 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Vega <span className="text-vega-blue">Analysis</span>
          </h1>
          <p className="mt-1 text-sm text-slate-500">Create your account</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Full Name">
            <input required className="input-dark w-full" value={form.name}
              onChange={set('name')} placeholder="Jane Trader" />
          </Field>

          <Field label="Email">
            <input type="email" required className="input-dark w-full" value={form.email}
              onChange={set('email')} placeholder="you@example.com" />
          </Field>

          <Field label="Mobile Number">
            <input type="tel" required className="input-dark w-full" value={form.mobile}
              onChange={set('mobile')} placeholder="9876543210" inputMode="numeric" />
          </Field>

          <Field label="Demat Broker">
            <select required className="input-dark w-full" value={form.broker} onChange={set('broker')}>
              <option value="" disabled>Select your broker</option>
              {BROKERS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
          </Field>

          <Field label="Password">
            <input type="password" required minLength={8} className="input-dark w-full"
              value={form.password} onChange={set('password')} placeholder="Minimum 8 characters" />
          </Field>

          {error && (
            <p className="rounded-lg bg-vega-red/10 px-3 py-2 text-sm text-vega-red">{error}</p>
          )}

          <div className="rounded-lg border border-vega-border bg-slate-50 px-3 py-2.5 text-xs leading-relaxed text-slate-500">
            After registering, WhatsApp will open with a prefilled message to the
            administrator. <span className="font-medium text-slate-700">Press Send</span> to
            request approval — your account stays pending until it is approved.
          </div>

          <button type="submit" disabled={loading}
            className="btn-primary mt-1 w-full disabled:opacity-50">
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-vega-blue hover:underline">Sign in</Link>
        </p>
        <p className="mt-2 text-center text-xs text-gray-600">
          <Link to="/" className="hover:text-gray-400">← Back to site</Link>
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{label}</label>
      {children}
    </div>
  );
}
