import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import logo from '../../assets/images/vega-analysis-logo.png';
import AuroraBackground from '../../site/components/AuroraBackground';

/**
 * Shared chrome for every authentication screen: login, register, pending
 * approval, forgot password, reset password, admin login.
 *
 * WHY THESE SCREENS ARE DARK WHILE THE DASHBOARD IS LIGHT. Auth sits at the
 * end of the marketing funnel, not at the start of the terminal — a visitor
 * arrives here from the public site, and a hard flip from black to off-white
 * mid-signup reads as landing on a different product. So these screens share
 * the site's design system (`site-*` classes, `.site-root` scope) and the
 * change to the light terminal happens once, at the moment the user actually
 * enters it. The dashboard, admin console and every feature page are untouched.
 *
 * `.site-root` is what carries the dark `color-scheme`, the emerald focus ring
 * and the dark scrollbars. Without it, native controls and autofill on these
 * forms would render in the light theme the rest of the app uses.
 *
 * The background is the marketing site's own AuroraBackground rather than a
 * second copy of it, so the two can never drift apart.
 */
export default function AuthShell({
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-md',
  showBackLink = true,
}) {
  return (
    <div className="site-root relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10 font-body text-text sm:px-6">
      <AuroraBackground />

      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className={`relative z-10 w-full ${width}`}
      >
        {/* ---------- brand ---------- */}
        <Link to="/" className="group mb-7 flex flex-col items-center gap-3">
          <img
            src={logo}
            alt=""
            className="h-14 w-auto object-contain transition-transform duration-300 group-hover:scale-105"
          />
          <span className="font-display text-2xl font-bold tracking-tight text-text">
            Vega <span className="site-gradient-text">Analysis</span>
          </span>
        </Link>

        {/* ---------- card ---------- */}
        <div className="site-card p-7 sm:p-9">
          <div className="mb-7 text-center">
            <h1 className="font-display text-2xl font-bold tracking-tight text-text sm:text-[1.7rem]">
              {title}
            </h1>
            {subtitle && (
              <p className="mx-auto mt-2.5 max-w-sm text-sm leading-relaxed text-muted">
                {subtitle}
              </p>
            )}
          </div>

          {children}
        </div>

        {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}

        {/* The public site is the front door, so these screens always need a
            way back to it — otherwise a visitor who clicks Login is stranded. */}
        {showBackLink && (
          <p className="mt-4 text-center text-xs text-muted/70">
            <Link to="/" className="transition-colors hover:text-primary">
              ← Back to site
            </Link>
          </p>
        )}
      </motion.div>
    </div>
  );
}

/**
 * A labelled form row.
 *
 * `htmlFor`/`id` are wired through rather than relying on nesting, so clicking
 * the label focuses the control even when the control is a composite (the
 * password field wraps its input in a relative container for the eye button).
 */
export function Field({ label, htmlFor, hint, children }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label
          htmlFor={htmlFor}
          className="text-xs font-semibold uppercase tracking-wider text-muted"
        >
          {label}
        </label>
        {hint}
      </div>
      {children}
    </div>
  );
}

/** Inline error banner, shared so every auth screen reports failures alike. */
export function AuthError({ children }) {
  if (!children) return null;
  return (
    <motion.p
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="alert"
      className="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-sm leading-relaxed text-danger"
    >
      {children}
    </motion.p>
  );
}

/** Inline success banner. */
export function AuthSuccess({ children }) {
  if (!children) return null;
  return (
    <motion.p
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      role="status"
      className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-3 text-sm leading-relaxed text-primary"
    >
      {children}
    </motion.p>
  );
}
