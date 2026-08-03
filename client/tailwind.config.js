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
         * PUBLIC WEBSITE TOKENS (src/site/**).
         *
         * The marketing site has its own visual language — gradients, larger
         * radii, Poppins display type — that deliberately does NOT match the
         * dense terminal look of the app. Rather than run a second Tailwind
         * build, its palette lives here alongside the app's.
         *
         * PURELY ADDITIVE. Every name below was grepped across all 35 app
         * source files before being added and appears in none of them, so no
         * existing class changes meaning. Do not reuse these inside the
         * dashboard/admin — use the vega-* / ink-* scales there.
         */
        primary: '#2563eb',
        secondary: '#0ea5e9',
        accent: '#f59e0b',
        background: '#f8fafc',
        card: '#ffffff',
        border: '#e5e7eb',
        text: '#111827',
        muted: '#6b7280',
        success: '#16a34a',
        danger: '#dc2626',
        gold: '#f59e0b',
      },

      fontFamily: {
        sans: ['Inter', '"Segoe UI Variable"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', '"Cascadia Mono"', 'monospace'],
        // Public website only. `sans` stays the app's default, so adding these
        // two changes nothing until a component opts in with font-display /
        // font-body.
        display: ['Poppins', 'Inter', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },

      // Public website gradients. No `backgroundImage` key existed before, so
      // this adds utilities rather than replacing any.
      backgroundImage: {
        'grid-glow':
          'radial-gradient(circle at 20% 20%, rgba(37,99,235,0.06), transparent 45%), radial-gradient(circle at 80% 0%, rgba(14,165,233,0.06), transparent 40%)',
        'primary-gradient': 'linear-gradient(135deg, #2563eb 0%, #0ea5e9 100%)',
        'gold-gradient': 'linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%)',
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
        // Public website elevation — softer and wider than the app's, which is
        // tuned for dense panels sitting edge to edge.
        glow: '0 8px 24px rgba(37,99,235,0.18)',
        'glow-emerald': '0 8px 24px rgba(14,165,233,0.15)',
        card: '0 4px 20px rgba(15,23,42,0.06)',
        'card-hover': '0 12px 32px rgba(15,23,42,0.10)',
      },

      transitionProperty: {
        width: 'width',
      },

      keyframes: {
        'vega-shimmer': {
          '100%': { transform: 'translateX(100%)' },
        },
        // Public website hero motion.
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        pulseGlow: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.6 },
        },
      },

      // The app declares its own animations directly in index.css, so this key
      // is new and cannot shadow one of them.
      animation: {
        float: 'float 6s ease-in-out infinite',
        pulseGlow: 'pulseGlow 2.5s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
