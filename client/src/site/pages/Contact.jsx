import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  HiOutlineMail, HiOutlinePhone, HiOutlineChatAlt2, HiOutlineExternalLink,
} from 'react-icons/hi';
import publicApi from '../api/publicApi';

/**
 * Contact.
 *
 * THE FORM ACTUALLY SENDS SOMETHING NOW. The version this replaces set a
 * `submitted` flag and rendered "Thanks — your message has been sent!" while
 * doing nothing at all: no request, no mail, no record. A confirmation for a
 * message that was never transmitted is worse than having no form.
 *
 * Rather than invent a mail backend, the form composes the message and hands
 * it to WhatsApp — the same click-to-chat mechanism the signup approval flow
 * already uses. The visitor sees their message in WhatsApp and presses Send
 * themselves; nothing is transmitted on their behalf. If an email address is
 * configured, a mailto alternative is offered alongside it.
 */

export default function Contact() {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const [handedOff, setHandedOff] = useState(false);

  useEffect(() => {
    publicApi.get('/site-config')
      .then(({ data }) => setConfig(data))
      .catch(() => setConfig({ adminWhatsappNumber: null, contactEmail: null, contactPhone: null }));
  }, []);

  const change = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));

  const bodyText = useMemo(() => (
    `Vega Analysis enquiry\n\n`
    + `Name: ${form.name || '-'}\n`
    + `Email: ${form.email || '-'}\n`
    + `Subject: ${form.subject || '-'}\n\n`
    + `${form.message || ''}`
  ), [form]);

  const whatsappUrl = config?.adminWhatsappNumber
    ? `https://wa.me/${config.adminWhatsappNumber}?text=${encodeURIComponent(bodyText)}`
    : null;

  const mailtoUrl = config?.contactEmail
    ? `mailto:${config.contactEmail}?subject=${encodeURIComponent(form.subject || 'Vega Analysis enquiry')}&body=${encodeURIComponent(bodyText)}`
    : null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!whatsappUrl) return;
    window.open(whatsappUrl, '_blank', 'noopener');
    setHandedOff(true);
  };

  const channels = [
    whatsappUrl && {
      icon: HiOutlineChatAlt2,
      label: 'WhatsApp',
      value: `+${config.adminWhatsappNumber}`,
      href: `https://wa.me/${config.adminWhatsappNumber}`,
      external: true,
    },
    config?.contactEmail && {
      icon: HiOutlineMail,
      label: 'Email',
      value: config.contactEmail,
      href: `mailto:${config.contactEmail}`,
    },
    config?.contactPhone && {
      icon: HiOutlinePhone,
      label: 'Phone',
      value: config.contactPhone,
      href: `tel:${config.contactPhone.replace(/\s/g, '')}`,
    },
  ].filter(Boolean);

  return (
    <>
      <section className="px-5 pb-12 pt-20 text-center sm:px-6">
        <div className="mx-auto max-w-2xl">
          <span className="site-eyebrow">Contact</span>
          <h1 className="mt-3 font-display text-4xl font-bold text-text sm:text-5xl">
            Get in touch
          </h1>
          <p className="mt-4 text-base leading-relaxed text-text/60 sm:text-lg">
            Questions about access, approval or the platform? Message us on WhatsApp —
            it is the fastest way to reach us.
          </p>
        </div>
      </section>

      {channels.length > 0 && (
        <section className="px-5 pb-16 sm:px-6">
          <div
            className={`mx-auto grid max-w-4xl grid-cols-1 gap-5 ${
              channels.length === 1 ? 'max-w-md' : channels.length === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3'
            }`}
          >
            {channels.map((c, i) => (
              <motion.a
                key={c.label}
                href={c.href}
                {...(c.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.35, delay: i * 0.08 }}
                className="site-card group flex flex-col items-center p-7 text-center transition-colors hover:border-primary/30"
              >
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary-gradient group-hover:text-white">
                  <c.icon size={24} />
                </div>
                <h3 className="font-display text-xs font-semibold uppercase tracking-wider text-text/45">
                  {c.label}
                </h3>
                <p className="mt-2 break-all font-display text-sm font-semibold text-text">
                  {c.value}
                </p>
              </motion.a>
            ))}
          </div>
        </section>
      )}

      <section className="px-5 pb-24 sm:px-6">
        <div className="mx-auto max-w-2xl">
          <div className="mb-8 text-center">
            <span className="site-eyebrow">Send a message</span>
            <h2 className="mt-3 font-display text-3xl font-bold text-text sm:text-4xl">
              Write to us
            </h2>
          </div>

          <div className="site-card p-7 sm:p-8">
            {!config ? (
              <p className="py-10 text-center text-sm text-text/45">Loading contact options…</p>
            ) : !whatsappUrl ? (
              <div className="py-8 text-center">
                <p className="text-sm text-text/60">
                  No contact channel is configured yet.
                </p>
                <p className="mt-2 text-xs text-text/45">
                  Set <code className="rounded bg-slate-100 px-1.5 py-0.5">ADMIN_WHATSAPP_NUMBER</code>{' '}
                  in the server environment to enable this form.
                </p>
              </div>
            ) : (
              <>
                <form onSubmit={handleSubmit} className="space-y-5">
                  <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                    <Field label="Name">
                      <input
                        name="name" value={form.name} onChange={change} required
                        placeholder="Your name" className="site-input"
                      />
                    </Field>
                    <Field label="Email">
                      <input
                        type="email" name="email" value={form.email} onChange={change} required
                        placeholder="you@email.com" className="site-input"
                      />
                    </Field>
                  </div>

                  <Field label="Subject">
                    <input
                      name="subject" value={form.subject} onChange={change} required
                      placeholder="What is this about?" className="site-input"
                    />
                  </Field>

                  <Field label="Message">
                    <textarea
                      name="message" value={form.message} onChange={change} required rows={5}
                      placeholder="Tell us how we can help…" className="site-input resize-none"
                    />
                  </Field>

                  <button type="submit" className="site-btn-primary w-full">
                    <HiOutlineChatAlt2 size={17} /> Open in WhatsApp
                  </button>

                  <p className="text-center text-xs leading-relaxed text-text/45">
                    This opens WhatsApp with your message filled in. You press{' '}
                    <span className="font-medium text-text/70">Send</span> — nothing is
                    sent on your behalf.
                  </p>
                </form>

                {handedOff && (
                  <p className="mt-5 rounded-xl border border-success/30 bg-success/10 px-4 py-3 text-center text-sm text-success">
                    WhatsApp should have opened. If it did not,{' '}
                    <a
                      href={whatsappUrl} target="_blank" rel="noopener noreferrer"
                      className="font-semibold underline"
                    >
                      open it here
                    </a>
                    , then press Send.
                  </p>
                )}

                {mailtoUrl && (
                  <p className="mt-5 border-t border-border pt-5 text-center text-xs text-text/50">
                    Prefer email?{' '}
                    <a href={mailtoUrl} className="inline-flex items-center gap-1 font-semibold text-primary hover:underline">
                      Send this as an email <HiOutlineExternalLink size={13} />
                    </a>
                  </p>
                )}
              </>
            )}
          </div>

          <p className="mt-8 text-center text-sm text-text/55">
            Looking to get access?{' '}
            <Link to="/register" className="font-semibold text-primary hover:underline">
              Register here
            </Link>{' '}
            and an administrator will review your account.
          </p>
        </div>
      </section>
    </>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-text/60">{label}</label>
      {children}
    </div>
  );
}
