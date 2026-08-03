/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      screens: {
        // Small phones (iPhone SE / Galaxy A-series) get their own step so the
        // dense summary tiles can go two-up before the 640px `sm` breakpoint.
        xs: '420px',
        // Tall desktop step used by the Vega workspace to promote the table
        // from "under the chart" to "beside the chart".
        '3xl': '1750px',
      },

      /**
       * PREMIUM LIGHT THEME.
       *
       * The token NAMES are deliberately unchanged. ~40 components reference
       * `vega-black` / `vega-panel` / `vega-border` etc., so re-pointing the
       * values here converts the whole app at once with no component edits and
       * no risk of missing one — which is what keeps this a purely visual
       * change.
       *
       * The names now describe ROLE, not literal colour:
       *   vega-black        -> app background   (was near-black, now off-white)
       *   vega-panel        -> card surface
       *   vega-panel-raised -> elevated surface (tooltips, popovers)
       *   vega-border       -> hairline borders
       */
      colors: {
        'vega-black': '#eef2f8',
        'vega-panel': '#ffffff',
        'vega-panel-raised': '#ffffff',
        'vega-panel-muted': '#f8fafc',
        'vega-border': '#dbe3ee',
        'vega-border-strong': '#c3cede',
        'vega-blue': '#1d4ed8',
        'vega-blue-light': '#2563eb',
        'vega-blue-dark': '#1e3a8a',
        // Direction colours are the ones users read fastest, so they are picked
        // for contrast on white rather than for neon glow on black. Both clear
        // WCAG AA (4.5:1) against #ffffff and #f8fafc as normal-size text.
        'vega-green': '#0f7a46',
        'vega-green-soft': '#e7f6ee',
        'vega-red': '#c62828',
        'vega-red-soft': '#fdecec',
        // Interactive accent only (active nav, focus rings, "live" dots) — never
        // used for price direction, so it cannot be confused with green/red.
        'vega-cyan': '#0e7490',
        'vega-amber': '#a45309',
        'vega-amber-soft': '#fdf3e3',
        // Ink scale for text. Named separately from `gray` so new code has an
        // unambiguous, contrast-checked ramp to reach for.
        'ink': {
          900: '#0b1220', // headings
          800: '#16202f',
          700: '#243146', // body copy
          600: '#3d4c66',
          500: '#5a6a85', // secondary copy — 4.6:1 on white
          400: '#7b8aa3', // hint text only, never for values
        },

        /**
         * GRAY RAMP INVERSION.
         *
         * This app was written dark-first: `text-gray-200` meant "bright text
         * on a near-black card". On the light theme those shades are nearly
         * invisible, which is the root cause of the unreadable labels.
         *
         * index.css used to patch this with `.text-gray-200 { color: … }`
         * overrides, but a plain class selector cannot reach the VARIANTS —
         * `hover:text-gray-200` still resolved to the old near-white, so every
         * hover state in the sidebar, top bar and tables faded out on contact.
         *
         * Redefining the palette here fixes the base classes and every variant
         * (hover:, focus:, group-hover:, disabled:) in one place. Verified safe:
         * across all 35 files, `gray-*` is used for text everywhere except three
         * decorative `bg-gray-500/700` chips, which stay sensible on this ramp.
         */
        gray: {
          50: '#f8fafc',
          100: '#0b1220',
          200: '#16202f',
          300: '#243146',
          400: '#3d4c66',
          500: '#5a6a85',
          600: '#7b8aa3',
          700: '#c3cede',
          800: '#dbe3ee',
          900: '#eef2f8',
          950: '#f8fafc',
        },

        /**
         * PUBLIC WEBSITE TOKENS (src/site/**) — DARK LUXURY FINTECH.
         *
         * The marketing site has its own visual language that deliberately does
         * NOT match the dense light terminal look of the app: deep black,
         * emerald/teal/electric-blue neon, glassmorphism, Playfair headings.
         * Rather than run a second Tailwind build, its palette lives here
         * alongside the app's.
         *
         * SCOPED, NOT SHARED. Every name in this block was grepped across all
         * app source files: `primary`, `secondary`, `accent`, `background`,
         * `card`, `border`, `text`, `muted`, `success`, `danger`, `gold`,
         * `plasma`, `surface`, `surface-2`, `hairline` appear ONLY inside
         * src/site/** and the `site-` rules in index.css. Re-pointing them from
         * the old light values to these dark ones therefore converts the whole
         * marketing site at once and cannot reach the dashboard, the admin
         * console or the auth screens — those use the vega-* / ink-* scales,
         * which are untouched.
         *
         * Do not reuse these inside the dashboard/admin.
         */
        primary: '#00E676',       // emerald — primary action, Call Vega, "live"
        secondary: '#00FFC6',     // neon teal — gradient partner, highlights
        accent: '#00BFFF',        // electric blue — data accents, links
        plasma: '#A855F7',        // purple glow — tertiary depth in the mesh
        background: '#050505',    // deep black page field
        surface: '#0A0F14',       // raised glass base
        'surface-2': '#111820',   // second elevation (hover, nested panels)
        card: '#0A0F14',
        border: '#1B2530',        // hairline on dark
        hairline: '#1B2530',
        text: '#EAF2F7',          // primary copy — 15.8:1 on #050505
        muted: '#93A3B4',         // secondary copy — 7.4:1 on #050505
        success: '#00E676',
        danger: '#FF4D6D',
        gold: '#F0B90B',
      },

      fontFamily: {
        sans: ['Inter', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', '"Cascadia Mono"', 'monospace'],
        // Public website only. `sans` stays the app's default, so these two
        // change nothing until a component opts in with font-display /
        // font-body.
        //
        // `display` is the large elegant serif the marketing headings use.
        // It is NOT for buttons or micro-labels — those stay on font-body
        // (Inter), which is why the site-btn-* rules in index.css say so
        // explicitly.
        display: ['"Playfair Display"', 'Georgia', 'Cambria', 'Times New Roman', 'serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },

      // Public website gradients. No `backgroundImage` key existed before, so
      // this adds utilities rather than replacing any.
      backgroundImage: {
        // The page field's ambient light. Deliberately low-alpha: it has to
        // read as depth behind content, never as colour on top of it.
        'grid-glow':
          'radial-gradient(ellipse 80% 55% at 50% -10%, rgba(0,230,118,0.13), transparent 60%),'
          + 'radial-gradient(ellipse 60% 45% at 88% 8%, rgba(0,191,255,0.10), transparent 62%),'
          + 'radial-gradient(ellipse 55% 45% at 8% 22%, rgba(168,85,247,0.09), transparent 60%)',
        'primary-gradient': 'linear-gradient(135deg, #00E676 0%, #00FFC6 52%, #00BFFF 100%)',
        'gold-gradient': 'linear-gradient(135deg, #F0B90B 0%, #FFD75E 100%)',
        // Emerald -> teal -> blue -> purple, used by the animated conic border
        // on hero cards and the CTA sweep.
        'aurora-ring':
          'conic-gradient(from 0deg, #00E676, #00FFC6, #00BFFF, #A855F7, #00E676)',
        // The diagonal light that travels across the primary CTA.
        'sheen':
          'linear-gradient(105deg, transparent 38%, rgba(255,255,255,0.55) 50%, transparent 62%)',
        // Faint technical grid — the "trading terminal" texture under the hero.
        'tech-grid':
          'linear-gradient(rgba(255,255,255,0.028) 1px, transparent 1px),'
          + 'linear-gradient(90deg, rgba(255,255,255,0.028) 1px, transparent 1px)',
        // Glass highlight: a card's top edge catching light.
        'glass-sheen':
          'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.02) 22%, transparent 55%)',
      },

      fontSize: {
        // Tighter line-heights than Tailwind's defaults, because this is a
        // dense data UI — and a floor on the small end: the old `text-[9px]`
        // and `text-[10px]` labels were the other half of the readability
        // problem. Nothing in the app should render below 11px now.
        '2xs': ['0.6875rem', { lineHeight: '0.95rem', letterSpacing: '0.02em' }], // 11px
        xs: ['0.75rem', { lineHeight: '1.05rem' }],                               // 12px
        sm: ['0.8125rem', { lineHeight: '1.15rem' }],                             // 13px
        base: ['0.9375rem', { lineHeight: '1.4rem' }],                            // 15px
        lg: ['1.0625rem', { lineHeight: '1.5rem' }],
        xl: ['1.25rem', { lineHeight: '1.65rem', letterSpacing: '-0.01em' }],
        '2xl': ['1.5rem', { lineHeight: '1.9rem', letterSpacing: '-0.015em' }],
        '3xl': ['1.875rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
      },

      boxShadow: {
        // Soft elevation reads as "premium" on light; the old heavy black glow
        // just looks like a smudge on a white surface.
        glass: '0 1px 2px 0 rgba(15,23,42,0.04), 0 6px 20px -6px rgba(15,23,42,0.10)',
        'glass-lg': '0 2px 4px -1px rgba(15,23,42,0.05), 0 16px 40px -12px rgba(15,23,42,0.16)',
        'glow-cyan': '0 0 0 1px rgba(29, 78, 216, 0.25), 0 2px 12px -2px rgba(29, 78, 216, 0.28)',
        // Sticky table headers need a real edge or rows appear to slide over them.
        'sticky-head': '0 1px 0 0 rgba(15,23,42,0.10), 0 6px 10px -8px rgba(15,23,42,0.35)',
        // Public website elevation. On black, "elevation" is light, not
        // shadow — so each of these pairs a real drop shadow (which separates
        // the card from the field) with a coloured bloom (which is what reads
        // as premium).
        glow: '0 10px 34px -8px rgba(0,230,118,0.45), 0 0 0 1px rgba(0,230,118,0.16)',
        'glow-emerald': '0 0 44px -10px rgba(0,230,118,0.55)',
        'glow-teal': '0 0 44px -10px rgba(0,255,198,0.50)',
        'glow-blue': '0 0 44px -10px rgba(0,191,255,0.48)',
        'glow-plasma': '0 0 48px -12px rgba(168,85,247,0.50)',
        // The continuous halo on the "Watch Live Vega" button, at rest.
        'cta-rest': '0 0 0 1px rgba(0,230,118,0.35), 0 8px 30px -6px rgba(0,230,118,0.42), 0 0 60px -18px rgba(0,255,198,0.5)',
        'cta-hot': '0 0 0 1px rgba(0,255,198,0.55), 0 14px 44px -8px rgba(0,230,118,0.62), 0 0 90px -16px rgba(0,255,198,0.7)',
        card: '0 18px 48px -22px rgba(0,0,0,0.95), inset 0 1px 0 0 rgba(255,255,255,0.055)',
        'card-hover': '0 26px 70px -24px rgba(0,0,0,1), 0 0 0 1px rgba(0,230,118,0.22), inset 0 1px 0 0 rgba(255,255,255,0.09)',
      },

      transitionProperty: {
        width: 'width',
      },

      keyframes: {
        'vega-shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        // Public website motion. Every one of these is decorative — nothing
        // here conveys state, so the global prefers-reduced-motion rule in
        // index.css can safely flatten all of them.
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        'float-sm': {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-6px)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.6 },
        },
        // Hero background mesh. Translate + scale only (both compositor
        // properties) so the blobs never trigger layout or paint.
        'aurora-a': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1)' },
          '33%': { transform: 'translate3d(6%, -4%, 0) scale(1.14)' },
          '66%': { transform: 'translate3d(-5%, 5%, 0) scale(0.92)' },
        },
        'aurora-b': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(1.05)' },
          '40%': { transform: 'translate3d(-8%, 6%, 0) scale(0.9)' },
          '75%': { transform: 'translate3d(7%, 3%, 0) scale(1.2)' },
        },
        'aurora-c': {
          '0%, 100%': { transform: 'translate3d(0,0,0) scale(0.95)' },
          '50%': { transform: 'translate3d(5%, 7%, 0) scale(1.18)' },
        },
        // Ticker. -50% because the strip renders its content twice; see
        // .site-marquee in index.css.
        marquee: {
          from: { transform: 'translate3d(0,0,0)' },
          to: { transform: 'translate3d(-50%,0,0)' },
        },
        // The travelling highlight on the primary CTA.
        sweep: {
          '0%': { transform: 'translateX(-130%)' },
          '55%, 100%': { transform: 'translateX(130%)' },
        },
        // Breathing halo behind the CTA and the "Go Live Now" button.
        'halo-pulse': {
          '0%, 100%': { opacity: '0.55', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.06)' },
        },
        'ring-spin': {
          to: { transform: 'rotate(360deg)' },
        },
        'grid-pan': {
          from: { backgroundPosition: '0 0' },
          to: { backgroundPosition: '48px 48px' },
        },
        // Particle drift for the hero starfield.
        'drift-up': {
          '0%': { transform: 'translateY(0)', opacity: '0' },
          '12%': { opacity: '0.85' },
          '85%': { opacity: '0.5' },
          '100%': { transform: 'translateY(-120px)', opacity: '0' },
        },
        // Skeleton / loading shimmer on the dark surfaces.
        'shimmer-x': {
          '100%': { transform: 'translateX(100%)' },
        },
      },

      // The app declares its own animations directly in index.css, so this key
      // is new and cannot shadow one of them.
      animation: {
        float: 'float 6s ease-in-out infinite',
        'float-sm': 'float-sm 5s ease-in-out infinite',
        pulseGlow: 'pulseGlow 2.5s ease-in-out infinite',
        'aurora-a': 'aurora-a 26s ease-in-out infinite',
        'aurora-b': 'aurora-b 32s ease-in-out infinite',
        'aurora-c': 'aurora-c 38s ease-in-out infinite',
        marquee: 'marquee 46s linear infinite',
        'marquee-slow': 'marquee 78s linear infinite',
        sweep: 'sweep 3.6s ease-in-out infinite',
        'halo-pulse': 'halo-pulse 2.8s ease-in-out infinite',
        'ring-spin': 'ring-spin 6s linear infinite',
        'grid-pan': 'grid-pan 9s linear infinite',
        // Duration and delay are overridden per particle inline, so the value
        // here only has to be a sane default.
        'drift-up': 'drift-up 18s linear infinite',
        'shimmer-x': 'shimmer-x 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
