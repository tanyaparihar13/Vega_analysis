import { useId, useState } from 'react';
import { HiOutlineEye, HiOutlineEyeOff, HiOutlineLockClosed } from 'react-icons/hi';

/**
 * Password input with a show/hide toggle.
 *
 * HIDDEN BY DEFAULT, ALWAYS. `useState(false)` is the whole guarantee — there
 * is no prop to start it revealed, because there is no screen on which that
 * would be correct.
 *
 * FOUR DETAILS THAT MATTER MORE THAN THEY LOOK:
 *
 * · The toggle is a real <button type="button">. Without the explicit type it
 *   defaults to `submit` inside a <form>, so revealing your password would
 *   submit the login form — a bug that only shows up once the field is wired
 *   into a real screen.
 * · `tabIndex={-1}` keeps it out of the tab order. Someone typing a password
 *   and pressing Tab expects to reach the submit button, not a decoration in
 *   between. It stays fully reachable by mouse, touch and screen reader.
 * · `aria-pressed` + a label that changes with state, so a screen reader
 *   announces whether the password is currently visible — which is exactly the
 *   thing a non-sighted user cannot otherwise tell.
 * · Revealed text switches to the mono face. Distinguishing l/1/I and O/0 is
 *   the entire reason someone clicked the eye.
 */
export default function PasswordField({
  id,
  value,
  onChange,
  placeholder = 'Enter your password',
  autoComplete = 'current-password',
  required = true,
  minLength,
  invalid = false,
  describedBy,
  autoFocus = false,
}) {
  const [visible, setVisible] = useState(false);
  // Generated so multiple password fields on one screen (reset: new + confirm)
  // cannot collide on the same id.
  const generatedId = useId();
  const inputId = id || generatedId;

  return (
    <div className="relative">
      <HiOutlineLockClosed
        size={17}
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
        aria-hidden="true"
      />

      <input
        id={inputId}
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={`site-input !pl-10 !pr-12 ${visible ? 'font-mono tracking-tight' : ''} ${
          invalid ? '!border-danger/50 focus:!ring-danger/20' : ''
        }`}
      />

      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? 'Hide password' : 'Show password'}
        aria-pressed={visible}
        title={visible ? 'Hide password' : 'Show password'}
        className="site-eye-toggle absolute right-1.5 top-1/2 -translate-y-1/2"
      >
        {visible ? <HiOutlineEyeOff size={19} /> : <HiOutlineEye size={19} />}
      </button>
    </div>
  );
}
