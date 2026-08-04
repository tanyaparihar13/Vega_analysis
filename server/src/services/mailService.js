'use strict';

const nodemailer = require('nodemailer');
require('dotenv').config();

/**
 * Outbound email. Currently used by one thing: the password reset link.
 *
 * FAILS CLOSED, DELIBERATELY. If SMTP is not configured, `isConfigured()`
 * returns false and the reset endpoint refuses the request with a clear
 * message telling the user to contact support instead. It does NOT fall back
 * to letting somebody set a new password without proving they can read the
 * account's inbox — that would turn "forgot password" into "type an email
 * address, take the account", which is the whole reason the link exists.
 *
 * Configure in server/.env:
 *
 *   SMTP_HOST=smtp.gmail.com
 *   SMTP_PORT=587
 *   SMTP_USER=you@yourdomain.com
 *   SMTP_PASS=your-app-password        # Gmail: an App Password, not the login
 *   SMTP_FROM="Vega Analysis <no-reply@yourdomain.com>"   # optional
 *   CLIENT_URL=https://your-site.com   # used to build the reset link
 *
 * Port 465 implies implicit TLS; anything else (587, 25) uses STARTTLS. That
 * is the rule every provider follows, so it is derived rather than being one
 * more thing to get wrong in .env.
 */

const HOST = process.env.SMTP_HOST || '';
const PORT = Number(process.env.SMTP_PORT) || 587;
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.SMTP_FROM || (USER ? `Vega Analysis <${USER}>` : '');

let transporter = null;

/** True when enough SMTP settings exist to attempt a send. */
function isConfigured() {
  return Boolean(HOST && USER && PASS);
}

/**
 * Built once, on first use.
 *
 * Lazily, not at require time: this module is loaded when the auth controller
 * is loaded, which is at boot. Constructing a transport for an unconfigured
 * server would mean every install without SMTP pays for it and logs noise.
 */
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: HOST,
      port: PORT,
      secure: PORT === 465,
      auth: { user: USER, pass: PASS },
    });
  }
  return transporter;
}

/** Escapes text before it goes anywhere near the HTML body. */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Sends the password reset link.
 *
 * Both a plain-text and an HTML part, because a reset mail that renders as a
 * blank page in a text-only client is a support ticket. The URL appears as
 * readable text in both, so it works even when the button does not.
 *
 * Throws on failure — the caller decides what the user is told, and it must
 * not be "check your inbox" when nothing was sent.
 */
async function sendPasswordResetEmail({ to, name, resetUrl, expiresMinutes }) {
  const tx = getTransporter();
  if (!tx) throw new Error('SMTP is not configured');

  const greeting = name ? `Hi ${name},` : 'Hi,';

  const text =
    `${greeting}\n\n`
    + `We received a request to reset the password on your Vega Analysis account.\n\n`
    + `Open this link to choose a new password:\n${resetUrl}\n\n`
    + `The link expires in ${expiresMinutes} minutes and can only be used once.\n\n`
    + `If you did not request this, you can ignore this email — your password has not been changed.\n\n`
    + `— Vega Analysis`;

  const html = `
<div style="margin:0;padding:32px 16px;background:#050505;font-family:Inter,Segoe UI,system-ui,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#0a0f14;border:1px solid #1b2530;border-radius:16px;padding:36px 32px">
    <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#eaf2f7">
      Vega <span style="color:#00e676">Analysis</span>
    </h1>
    <p style="margin:0 0 26px;font-size:13px;color:#93a3b4">Password reset request</p>

    <p style="margin:0 0 16px;font-size:14px;line-height:1.65;color:#eaf2f7">${esc(greeting)}</p>
    <p style="margin:0 0 26px;font-size:14px;line-height:1.65;color:#93a3b4">
      We received a request to reset the password on your Vega Analysis account.
      Choose a new one using the button below.
    </p>

    <a href="${esc(resetUrl)}"
       style="display:inline-block;background:#00e676;color:#04120a;font-weight:600;font-size:15px;
              text-decoration:none;padding:13px 28px;border-radius:12px">
      Reset my password
    </a>

    <p style="margin:26px 0 8px;font-size:12px;color:#93a3b4">
      Or paste this link into your browser:
    </p>
    <p style="margin:0 0 26px;font-size:12px;word-break:break-all;color:#00bfff">${esc(resetUrl)}</p>

    <p style="margin:0;padding-top:22px;border-top:1px solid #1b2530;font-size:12px;line-height:1.7;color:#93a3b4">
      This link expires in <strong style="color:#eaf2f7">${esc(expiresMinutes)} minutes</strong> and can
      only be used once.<br>
      If you did not request this, you can ignore this email — your password has not been changed.
    </p>
  </div>
</div>`.trim();

  await tx.sendMail({
    from: FROM,
    to,
    subject: 'Reset your Vega Analysis password',
    text,
    html,
  });
}

module.exports = { isConfigured, sendPasswordResetEmail };
