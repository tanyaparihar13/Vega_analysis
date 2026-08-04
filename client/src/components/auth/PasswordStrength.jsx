import { HiCheck, HiOutlineX } from 'react-icons/hi';

/**
 * Password rules and the strength meter that reports on them.
 *
 * THE REQUIRED RULES MIRROR THE SERVER EXACTLY — see `validatePassword` in
 * server/src/controllers/authController.js. That is not a nicety: if this
 * component said "Strong" about something the server then rejected with a 400,
 * the user would be told their password is excellent and that it is invalid,
 * in that order, and would have no way to tell which to believe. If you change
 * one, change the other.
 *
 * Required vs optional is a real distinction here. The three required rules are
 * the ones the server enforces and the submit button waits for. The two
 * optional ones only move the meter — they make a password stronger, and
 * refusing to accept a 40-character passphrase because it has no symbol would
 * be security theatre that pushes people towards `Password1!`.
 */

export const PASSWORD_MIN = 8;

/** The single source of truth for what each rule is and whether it passed. */
export function evaluatePassword(password = '') {
  const pw = String(password);

  const rules = [
    { id: 'length', label: `At least ${PASSWORD_MIN} characters`, required: true, ok: pw.length >= PASSWORD_MIN },
    { id: 'letter', label: 'Contains a letter', required: true, ok: /[a-zA-Z]/.test(pw) },
    { id: 'number', label: 'Contains a number', required: true, ok: /[0-9]/.test(pw) },
    { id: 'mixed', label: 'Upper and lower case', required: false, ok: /[a-z]/.test(pw) && /[A-Z]/.test(pw) },
    { id: 'symbol', label: 'Contains a symbol', required: false, ok: /[^a-zA-Z0-9]/.test(pw) },
  ];

  const isValid = rules.filter((r) => r.required).every((r) => r.ok);

  // Score out of 4. Length past 12 counts for a point on its own because it is
  // worth more than any character-class rule on this list.
  let score = 0;
  if (pw.length >= PASSWORD_MIN) score += 1;
  if (pw.length >= 12) score += 1;
  if (rules.find((r) => r.id === 'mixed').ok) score += 1;
  if (rules.find((r) => r.id === 'symbol').ok) score += 1;
  // A password that fails a required rule is never described as more than weak,
  // whatever else it happens to contain.
  if (!isValid) score = Math.min(score, 1);

  return { rules, isValid, score: pw ? Math.max(score, 1) : 0 };
}

const LEVELS = [
  { label: '', color: 'transparent' },
  { label: 'Weak', color: '#FF4D6D' },
  { label: 'Fair', color: '#F0B90B' },
  { label: 'Good', color: '#00BFFF' },
  { label: 'Strong', color: '#00E676' },
];

export default function PasswordStrength({ password, id }) {
  const { rules, score } = evaluatePassword(password);
  const level = LEVELS[score];

  // Nothing typed yet: showing four grey bars and five red crosses before the
  // user has done anything reads as failure rather than guidance.
  if (!password) return null;

  return (
    <div id={id} className="mt-3">
      <div className="flex items-center gap-3">
        {/*
          Plain spans with a CSS transition, deliberately NOT motion.span.

          A JS animation library drives colour through requestAnimationFrame,
          which does not run when the tab is backgrounded or the surface is not
          compositing — the bars then freeze at whatever value they mounted
          with while the label beside them keeps updating, so the meter reads
          "Strong" next to one red bar. Worse, JS-driven colour ignores the
          global prefers-reduced-motion rule in index.css, which flattens
          transitions for everyone who asked for that.

          An inline style is what React rendered, always, whether or not
          anything is animating. The transition is pure decoration on top.
        */}
        <div className="flex flex-1 gap-1.5" role="presentation">
          {[1, 2, 3, 4].map((i) => (
            <span
              key={i}
              className="h-1.5 flex-1 rounded-full transition-colors duration-300"
              style={{
                backgroundColor: i <= score ? level.color : 'rgba(255,255,255,0.09)',
              }}
            />
          ))}
        </div>
        <span
          className="w-12 shrink-0 text-right text-xs font-semibold"
          style={{ color: level.color }}
        >
          {level.label}
        </span>
      </div>

      {/*
        aria-live so the rules are announced as they flip. Without it a screen
        reader user gets no feedback at all from a purely visual checklist.
      */}
      <ul className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2" aria-live="polite">
        {rules.map((r) => (
          <li
            key={r.id}
            className={`flex items-center gap-1.5 text-xs transition-colors ${
              r.ok ? 'text-primary' : r.required ? 'text-muted' : 'text-muted/60'
            }`}
          >
            {r.ok ? (
              <HiCheck size={14} className="shrink-0" />
            ) : (
              <HiOutlineX size={14} className="shrink-0 opacity-50" />
            )}
            <span>
              {r.label}
              {!r.required && <span className="ml-1 opacity-60">(optional)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
