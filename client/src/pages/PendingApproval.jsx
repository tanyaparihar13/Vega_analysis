import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import api from '../api/axios';

/**
 * Shown immediately after registration.
 *
 * Register.jsx already tried to open WhatsApp automatically; popup blockers
 * can silently swallow that, so the link is repeated here as an explicit
 * button. If the user navigated here directly (no router state), the link is
 * rebuilt from /api/auth/config so the page is never a dead end.
 */
export default function PendingApproval() {
  const { state } = useLocation();
  const [fallbackUrl, setFallbackUrl] = useState(null);

  const name = state?.name;
  const email = state?.email;
  const mobile = state?.mobile;
  const broker = state?.broker;

  useEffect(() => {
    if (state?.whatsappUrl) return;
    api.get('/auth/config')
      .then(({ data }) => {
        if (!data.adminWhatsappNumber) return;
        const text =
          'Hello, I have registered on Vega Analysis and would like my account approved.' +
          (name ? `\n\nName: ${name}` : '') +
          (email ? `\nEmail: ${email}` : '') +
          (mobile ? `\nMobile: ${mobile}` : '') +
          (broker ? `\nDemat Broker: ${broker}` : '') +
          '\n\nStatus: Pending approval';
        setFallbackUrl(`https://wa.me/${data.adminWhatsappNumber}?text=${encodeURIComponent(text)}`);
      })
      .catch(() => setFallbackUrl(null));
  }, [state, name, email, mobile, broker]);

  const whatsappUrl = state?.whatsappUrl || fallbackUrl;

  return (
    <div className="flex min-h-screen items-center justify-center bg-vega-black px-4 py-10">
      <div className="glass-card w-full max-w-lg p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-vega-amber/10 text-2xl">
          ⏳
        </div>

        <h1 className="text-xl font-semibold text-slate-900">Registration received</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
          Your account is <span className="font-medium text-vega-amber">pending approval</span>.
          An administrator must approve it before you can sign in.
        </p>

        {(name || email || mobile || broker) && (
          <div className="mx-auto mt-5 max-w-xs space-y-1.5 rounded-lg border border-vega-border bg-slate-50 px-4 py-3 text-left text-xs">
            {name && <Row label="Name" value={name} />}
            {email && <Row label="Email" value={email} />}
            {mobile && <Row label="Mobile" value={mobile} />}
            {broker && <Row label="Broker" value={broker} />}
          </div>
        )}

        <div className="mt-6 space-y-3">
          {whatsappUrl ? (
            <>
              <a
                href={whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-[#25D366] px-4 py-2.5 font-medium text-white transition-opacity hover:opacity-90"
              >
                Open WhatsApp and send the request
              </a>
              <p className="text-xs text-slate-400">
                WhatsApp should have opened automatically. If it did not, use the
                button above — then press <span className="font-medium text-slate-600">Send</span>.
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-400">
              Contact the administrator to have your account approved.
            </p>
          )}
        </div>

        <div className="mt-7 border-t border-vega-border pt-5">
          <Link to="/login" className="text-sm font-medium text-vega-blue hover:underline">
            Already approved? Sign in →
          </Link>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-400">{label}</span>
      <span className="truncate font-medium text-slate-700">{value}</span>
    </div>
  );
}
