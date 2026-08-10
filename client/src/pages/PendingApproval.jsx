import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { FaWhatsapp } from 'react-icons/fa';
import { HiOutlineClock } from 'react-icons/hi';
import api from '../api/axios';
import AuthShell from '../components/auth/AuthShell';

/**
 * Shown immediately after registration.
 *
 * Register.jsx already tried to open WhatsApp automatically; popup blockers
 * can silently swallow that, so the link is repeated here as an explicit
 * button. If the user navigated here directly (no router state), the link is
 * rebuilt from /api/auth/config so the page is never a dead end.
 *
 * THE FALLBACK MESSAGE MIRRORS THE SERVER'S. `buildWhatsAppUrl` in
 * authController.js is the canonical version; this rebuild has to carry the
 * same fields — including User ID and Account Type — or an admin receiving the
 * fallback would get a thinner message than one receiving the real thing and
 * have no way to tell which they were looking at.
 *
 * NO PASSWORD IS EVER PUT IN THIS MESSAGE, here or on the server. It is
 * bcrypt-hashed at registration and never exists in plaintext afterwards.
 */
export default function PendingApproval() {
  const { state } = useLocation();
  const [fallbackUrl, setFallbackUrl] = useState(null);

  const name = state?.name;
  const email = state?.email;
  const mobile = state?.mobile;
  const userId = state?.userId;
  // From the registration form — the broker they already trade through.
  const broker = state?.broker;
  // Set by the onboarding step — how they want to get access. A user who
  // reached this screen without choosing (expired token, direct visit) simply
  // has no option to show.
  const selectedOption = state?.selectedOption;

  useEffect(() => {
    if (state?.whatsappUrl) return;
    api.get('/auth/config')
      .then(({ data }) => {
        if (!data.adminWhatsappNumber) return;
        // Mirrors authController.buildOnboardingWhatsAppUrl field for field —
        // an admin receiving this fallback must not get a thinner message than
        // one receiving the real thing, with no way to tell which they have.
        const text =
          'Hello, I have registered on Vega Analysis.' +
          (name ? `\n\nName: ${name}` : '') +
          (mobile ? `\nMobile: ${mobile}` : '') +
          (email ? `\nEmail: ${email}` : '') +
          (broker ? `\nDemat Broker: ${broker}` : '') +
          (userId ? `\nUser ID: ${userId}` : '') +
          (selectedOption ? `\n\nSelected Option: ${selectedOption}` : '') +
          '\n\nStatus: Pending approval';
        setFallbackUrl(`https://wa.me/${data.adminWhatsappNumber}?text=${encodeURIComponent(text)}`);
      })
      .catch(() => setFallbackUrl(null));
  }, [state, name, email, mobile, broker, userId, selectedOption]);

  const whatsappUrl = state?.whatsappUrl || fallbackUrl;
  const hasDetails = name || email || mobile || broker || userId || selectedOption;

  return (
    <AuthShell
      title="Registration received"
      subtitle="An administrator must approve your account before you can sign in."
      width="max-w-lg"
      footer={
        <Link to="/login" className="font-semibold text-primary hover:underline">
          Already approved? Sign in →
        </Link>
      }
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="flex flex-col items-center"
      >
        <span className="grid h-16 w-16 place-items-center rounded-2xl border border-gold/25 bg-gold/10 text-gold">
          <HiOutlineClock size={30} />
        </span>
        <p className="mt-5 text-center text-sm leading-relaxed text-muted">
          Your account is{' '}
          <span className="font-semibold text-gold">pending approval</span>.
        </p>
      </motion.div>

      {hasDetails && (
        <div className="mt-7 space-y-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] px-5 py-4">
          {name && <Row label="Name" value={name} />}
          {email && <Row label="Email" value={email} />}
          {mobile && <Row label="Mobile" value={mobile} />}
          {broker && <Row label="Demat Broker" value={broker} />}
          {userId && <Row label="User ID" value={String(userId)} />}
          {selectedOption && <Row label="Selected Option" value={selectedOption} />}
        </div>
      )}

      <div className="mt-7 space-y-3">
        {whatsappUrl ? (
          <>
            <a
              href={whatsappUrl}
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
      </div>
    </AuthShell>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="truncate font-medium text-text">{value}</span>
    </div>
  );
}
