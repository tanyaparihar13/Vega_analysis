import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaWhatsapp } from 'react-icons/fa';
import {
  HiOutlineArrowRight, HiOutlineSparkles, HiOutlineBadgeCheck, HiOutlineOfficeBuilding,
} from 'react-icons/hi';
import api from '../api/axios';
import { useAuth } from '../context/AuthContext';
import AuthShell, { AuthError } from '../components/auth/AuthShell';

/**
 * Signup step 2 of 2 — the onboarding choice.
 *
 * WHAT THIS SCREEN IS FOR
 * The account already exists at this point (step 1 created it, status
 * 'pending'). What the admin still does not know is what the person actually
 * wants, and "someone registered" is not a lead anyone can act on. This screen
 * turns it into one: pay for lifetime access, or open a broking account with
 * Dhan or Angel One.
 *
 * AUTHORISATION
 * There is no session here and there cannot be one — a pending account cannot
 * log in, which is the whole point of the approval gate. The write is authorised
 * by the scope-limited token step 1 returned, held in sessionStorage and sent by
 * AuthContext.selectOnboardingOption(). It expires in 30 minutes and is refused
 * by every other endpoint.
 *
 * THE WHATSAPP HANDOFF
 * Unchanged in mechanism from what it replaced: a plain https://wa.me/ link that
 * OPENS a chat with the message prefilled. The user presses Send themselves.
 * Nothing is transmitted on their behalf, and the message never contains a
 * password. What changed is only WHEN it opens — after the choice, so the
 * message says what the person wants.
 *
 * The popup is opened inside the click handler's async chain because popup
 * blockers only allow window.open during a user gesture; the confirmation state
 * below repeats the link for the case where it is swallowed anyway.
 */

/** Visual treatment per option. The keys are the server's ENUM values. */
const OPTION_STYLE = {
  lifetime: {
    icon: HiOutlineSparkles,
    ring: 'border-gold/30 hover:border-gold/60',
    glow: 'group-hover:shadow-[0_0_44px_-10px_rgba(240,185,11,0.55)]',
    chip: 'bg-gold/12 text-gold border-gold/30',
    iconWrap: 'border-gold/25 bg-gold/10 text-gold',
    blurb: 'One-time payment. Full terminal, live Vega streaming, every recorded session.',
  },
  dhan: {
    icon: HiOutlineOfficeBuilding,
    ring: 'border-primary/25 hover:border-primary/55',
    glow: 'group-hover:shadow-glow-emerald',
    chip: 'bg-primary/12 text-primary border-primary/30',
    iconWrap: 'border-primary/25 bg-primary/10 text-primary',
    blurb: 'Open a demat account with Dhan through us and get terminal access.',
  },
  angel_one: {
    icon: HiOutlineOfficeBuilding,
    ring: 'border-accent/25 hover:border-accent/55',
    glow: 'group-hover:shadow-glow-blue',
    chip: 'bg-accent/12 text-accent border-accent/30',
    iconWrap: 'border-accent/25 bg-accent/10 text-accent',
    blurb: 'Open a demat account with Angel One through us and get terminal access.',
  },
};

/** Shown until /onboarding/options answers, so the page never renders empty. */
const FALLBACK_OPTIONS = [
  { key: 'lifetime', label: 'Lifetime Access', message: 'I am ready to pay for Lifetime Access', priceInr: 4999 },
  { key: 'dhan', label: 'Open an account with Dhan', message: 'I am ready to open an account with Dhan', priceInr: null },
  { key: 'angel_one', label: 'Open an account with Angel One', message: 'I am ready to open an account with Angel One', priceInr: null },
];

export default function Onboarding() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const { selectOnboardingOption, markWhatsappOpened, clearOnboardingToken } = useAuth();

  const [options, setOptions] = useState(FALLBACK_OPTIONS);
  const [busy, setBusy] = useState(null);   // the option key being submitted
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);   // { label, whatsappUrl }

  const name = state?.name;

  // A direct visit with no token cannot proceed — say so immediately rather
  // than letting the user pick an option and fail on submit.
  const hasToken = typeof window !== 'undefined'
    && !!sessionStorage.getItem('vega_onboarding_token');

  useEffect(() => {
    let cancelled = false;
    api.get('/auth/onboarding/options')
      .then(({ data }) => {
        if (!cancelled && data.options?.length) setOptions(data.options);
      })
      .catch(() => { /* the fallback list is already rendered */ });
    return () => { cancelled = true; };
  }, []);

  const choose = async (key) => {
    setBusy(key);
    setError('');
    try {
      const result = await selectOnboardingOption(key);

      if (result.whatsappUrl) {
        window.open(result.whatsappUrl, '_blank', 'noopener');
        markWhatsappOpened();
      }

      setDone({ label: result.label, whatsappUrl: result.whatsappUrl });
    } catch (err) {
      const code = err.code || err.response?.data?.code;
      setError(
        code?.startsWith('ONBOARDING_TOKEN')
          ? 'Your onboarding session has expired. Your account was created — please contact the administrator on WhatsApp to choose an option.'
          : err.response?.data?.message || 'Could not record your choice. Please try again.'
      );
    } finally {
      setBusy(null);
    }
  };

  const finish = () => {
    clearOnboardingToken();
    navigate('/pending-approval', {
      replace: true,
      state: { ...state, selectedOption: done?.label, whatsappUrl: done?.whatsappUrl },
    });
  };

  // ---- confirmation ------------------------------------------------------
  if (done) {
    return (
      <AuthShell
        title="Almost there"
        subtitle="Send the WhatsApp message so an administrator can activate your account."
        width="max-w-lg"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center"
        >
          <span className="grid h-16 w-16 place-items-center rounded-2xl border border-primary/25 bg-primary/10 text-primary">
            <HiOutlineBadgeCheck size={32} />
          </span>
          <p className="mt-5 text-center text-sm leading-relaxed text-muted">
            Your choice — <span className="font-semibold text-text">{done.label}</span> — has been
            recorded.
          </p>
        </motion.div>

        <div className="mt-7 space-y-3">
          {done.whatsappUrl ? (
            <>
              <a
                href={done.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="site-tap-clean inline-flex w-full items-center justify-center gap-2.5 rounded-xl px-5 py-3.5 font-body font-semibold text-white transition-all duration-300 hover:-translate-y-0.5"
                style={{
                  backgroundColor: '#25D366',
                  boxShadow: '0 10px 30px -10px rgba(37,211,102,0.85)',
                }}
              >
                <FaWhatsapp size={20} /> Open WhatsApp and send the request
              </a>
              <p className="text-center text-xs leading-relaxed text-muted/80">
                WhatsApp should have opened automatically. If it did not, use the button
                above — then press <span className="font-semibold text-text">Send</span>.
              </p>
            </>
          ) : (
            <p className="text-center text-xs text-muted/80">
              Contact the administrator to have your account approved.
            </p>
          )}

          <button type="button" onClick={finish} className="site-btn-outline w-full !py-3">
            Continue <HiOutlineArrowRight size={16} />
          </button>
        </div>
      </AuthShell>
    );
  }

  // ---- choice ------------------------------------------------------------
  return (
    <AuthShell
      title={name ? `Welcome, ${name.split(' ')[0]}` : 'Account created'}
      subtitle="One last step — tell us how you would like to get access. Your registration details go to our team on WhatsApp."
      width="max-w-2xl"
      footer={
        <>
          Changed your mind?{' '}
          <Link to="/login" className="font-semibold text-primary hover:underline">
            Sign in later
          </Link>
        </>
      }
    >
      {!hasToken && (
        <div className="mb-6">
          <AuthError>
            Your onboarding session has expired or this page was opened directly. Your account
            was created — please contact the administrator on WhatsApp to choose an option.
          </AuthError>
        </div>
      )}

      <div className="space-y-4">
        {options.map((option, i) => {
          const style = OPTION_STYLE[option.key] || OPTION_STYLE.dhan;
          const Icon = style.icon;
          const isBusy = busy === option.key;
          const disabled = !!busy || !hasToken;

          return (
            <motion.button
              key={option.key}
              type="button"
              onClick={() => choose(option.key)}
              disabled={disabled}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] }}
              className={`group relative flex w-full items-center gap-5 rounded-2xl border bg-[rgba(255,255,255,0.03)] px-5 py-6 text-left transition-all duration-300 sm:px-7 sm:py-7 ${style.ring} ${style.glow} ${
                disabled ? 'cursor-not-allowed opacity-55' : 'hover:-translate-y-0.5'
              }`}
            >
              <span
                className={`grid h-12 w-12 shrink-0 place-items-center rounded-xl border transition-transform duration-300 group-hover:scale-105 sm:h-14 sm:w-14 ${style.iconWrap}`}
              >
                <Icon size={24} />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="font-display text-base font-bold leading-snug text-text sm:text-lg">
                    {option.message}
                  </span>
                  {option.priceInr != null && (
                    <span
                      className={`shrink-0 rounded-full border px-2.5 py-0.5 font-body text-xs font-bold ${style.chip}`}
                    >
                      ₹{option.priceInr.toLocaleString('en-IN')}
                    </span>
                  )}
                </span>
                <span className="mt-1.5 block text-xs leading-relaxed text-muted sm:text-sm">
                  {style.blurb}
                </span>
              </span>

              <span className="shrink-0 text-muted transition-all duration-300 group-hover:translate-x-1 group-hover:text-text">
                {isBusy
                  ? <span className="block h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
                  : <HiOutlineArrowRight size={20} />}
              </span>
            </motion.button>
          );
        })}
      </div>

      {error && <div className="mt-5"><AuthError>{error}</AuthError></div>}

      <p className="mt-6 text-center text-xs leading-relaxed text-muted/75">
        Selecting an option opens WhatsApp with your registration details prefilled.
        Your password is never included.
      </p>
    </AuthShell>
  );
}
