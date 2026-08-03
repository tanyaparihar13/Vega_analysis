import { useMemo } from 'react';

/**
 * The cinematic field the whole marketing site sits on.
 *
 * Four stacked layers, all `position: fixed` so they cost nothing to scroll and
 * never lengthen the page:
 *
 *   1. base wash      static radial mesh (bg-grid-glow) — the ambient colour
 *   2. aurora blobs   three heavily blurred gradient discs on slow, offset loops
 *   3. tech grid      faint 48px lattice, panning, masked to a soft vignette
 *   4. particles      a sparse drift of glowing motes
 *
 * WHY IT IS BUILT LIKE THIS. Only `transform` and `opacity` animate — never
 * width, height, filter or background-position on an element that paints text.
 * Each blob is its own compositor layer, so the browser animates them without
 * repainting a single pixel of content. That is what keeps a full-screen
 * animated background at 60fps on a mid-range phone.
 *
 * `pointer-events-none` throughout: this is scenery, and it must never eat a
 * click meant for the page.
 *
 * `aria-hidden` because none of it carries meaning. A screen reader announcing
 * two dozen empty decorative spans would be pure noise.
 */

const PARTICLE_COUNT = 26;

/** The three accent colours of the palette, one per blob. */
const BLOBS = [
  {
    className:
      'left-[-18%] top-[-16%] h-[62vmax] w-[62vmax] animate-aurora-a '
      + 'bg-[radial-gradient(circle,rgba(0,230,118,0.30),transparent_66%)]',
  },
  {
    className:
      'right-[-22%] top-[-8%] h-[56vmax] w-[56vmax] animate-aurora-b '
      + 'bg-[radial-gradient(circle,rgba(0,191,255,0.26),transparent_66%)]',
  },
  {
    className:
      'bottom-[-26%] left-[22%] h-[58vmax] w-[58vmax] animate-aurora-c '
      + 'bg-[radial-gradient(circle,rgba(168,85,247,0.22),transparent_68%)]',
  },
];

export default function AuroraBackground() {
  /**
   * Particle placement is randomised once per mount and then frozen.
   *
   * Recomputing on render would make every mote jump to a new spot whenever
   * anything above re-rendered — a nav toggle, a poll landing, a route change.
   * `useMemo` with an empty dependency list is the whole fix.
   */
  const particles = useMemo(
    () => Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
      id: i,
      left: `${Math.random() * 100}%`,
      top: `${55 + Math.random() * 50}%`,
      size: 1 + Math.random() * 2.4,
      // Spread across a wide band so the drift never looks like a pulse of
      // motes leaving together.
      duration: 14 + Math.random() * 16,
      delay: Math.random() * 18,
      teal: Math.random() > 0.55,
    })),
    []
  );

  return (
    // `site-grain` adds the noise overlay via ::after — large flat areas of
    // near-black band visibly on 8-bit panels, and the grain breaks up the
    // gradient steps.
    <div className="site-grain pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {/* 1 — base wash */}
      <div className="absolute inset-0 bg-background" />
      <div className="absolute inset-0 bg-grid-glow" />

      {/* 2 — aurora blobs */}
      {BLOBS.map((b) => (
        <div
          key={b.className}
          className={`absolute rounded-full blur-[90px] will-change-transform ${b.className}`}
        />
      ))}

      {/* 3 — technical lattice.
             Masked to a soft ellipse so it reads as texture under the hero and
             fades out before it can fight with the content further down. */}
      <div
        className="absolute inset-0 animate-grid-pan bg-tech-grid opacity-70"
        style={{
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse 90% 55% at 50% 0%, #000 10%, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(ellipse 90% 55% at 50% 0%, #000 10%, transparent 72%)',
        }}
      />

      {/* 4 — drifting motes */}
      {particles.map((p) => (
        <span
          key={p.id}
          className="absolute animate-drift-up rounded-full will-change-transform"
          style={{
            left: p.left,
            top: p.top,
            width: p.size,
            height: p.size,
            backgroundColor: p.teal ? '#00FFC6' : '#00E676',
            boxShadow: `0 0 ${p.size * 5}px ${p.teal ? '#00FFC6' : '#00E676'}`,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
            opacity: 0,
          }}
        />
      ))}

      {/* A vignette keeps the eye centred and stops the blobs glowing hard into
          the corners of a wide monitor. */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_45%,rgba(5,5,5,0.85)_100%)]" />
    </div>
  );
}
