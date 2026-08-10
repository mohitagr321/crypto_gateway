/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * BRAND — identity and "this is the action to take". Deliberately NOT
         * green.
         *
         * The palette used to be green, which put the primary button in the same
         * hue as the `confirmed` payment badge: on a payments screen the CTA and
         * "your money arrived" were the same colour, so colour carried no
         * information. Indigo is semantically empty in a money product, which
         * frees green and red to mean only what they mean below.
         *
         * Rule: brand = interactive. It never indicates state.
         */
        brand: {
          50: '#eef2ff',
          100: '#e0e7ff',
          200: '#c7d2fe',
          300: '#a5b4fc',
          400: '#818cf8',
          500: '#6366f1',
          600: '#4f46e5',
          700: '#4338ca',
          800: '#3730a3',
          900: '#312e81',
          950: '#1e1b4b',
        },
        /**
         * Secondary hue, used ONLY to give the brand gradient somewhere to
         * travel (headline accents, hero mesh). Never on a control — two
         * interactive colours would undo the point of the rule above.
         */
        accent: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },

        /**
         * GROUND — a warm ink/paper ramp shipped under Tailwind's `slate` name.
         *
         * Keeping the NAME is the whole trick: every existing `bg-slate-50`,
         * `text-slate-600` and `dark:bg-slate-900` re-grounds with zero component
         * edits — 1,175 utility usages across 51 files.
         *
         * ALL ELEVEN STEPS MUST SHIP TOGETHER. `theme.extend.colors.slate`
         * deep-merges at the STEP level, so overriding only some leaves the rest
         * at Tailwind's cool defaults and the ramp ends up half warm, half blue.
         *
         * PLUM, hue 270, carrying REAL chroma (18-27% saturation at the ends).
         *
         * It was a warm near-neutral, and warm could never be made colourful:
         * adding chroma at hue ~45 walks the page straight into amber. Measured,
         * a saturated warm ground lands 16 degrees from amber-600, where
         * "pending" stops being separable from the paper it sits on. That is why
         * the warm version had to stay near-zero saturation, and why it read as
         * beige rather than as a colour.
         *
         * Hue 270 is the seat that is free. Every semantic hue is far away —
         * amber 116 degrees, red 90, emerald 107 — so the ground can carry
         * visible colour without ever competing with a status. And it sits 27
         * degrees off brand indigo: close enough to read as one family, far
         * enough that a primary button is still its own hue against the page
         * rather than a slightly brighter patch of it.
         *
         * Every ratio below measured with the WCAG relative-luminance formula
         * against 50 (light) and 950 (dark), not eyeballed. Text steps clear AA
         * in both themes: secondary 5.23/5.86, body 7.70/11.62, settled
         * 5.27/9.80, pending 4.83/11.29, failed 4.64/6.81, brand 6.04/6.32.
         */
        slate: {
          50: '#FBFAFC', //  page
          100: '#F4F1F7', //  inset
          200: '#E7E2EC', //  hairline rules
          300: '#D0C8D9', //  dividers
          400: '#948CA1', //  3.09:1 — input borders + decorative icons ONLY, never text
          500: '#6E667D', //  5.23:1 — secondary text
          600: '#554D61', //  7.70:1 — body text
          700: '#403A4A', // 10.50:1
          800: '#292431', //  dark raised
          900: '#1C1823', //  dark card
          950: '#131017', //  dark ground
        },

        /**
         * STATE — overridden in place so existing `text-emerald-700`,
         * `bg-amber-100`, `dark:text-red-400` inherit the corrected values.
         *
         * THE 500 STEP NEVER CARRIES TEXT: measured, emerald-500 lands at 4.27:1
         * and amber-500 at 3.25:1 on paper — both AA failures, on the money
         * figure that is the entire point of the screen. Light text takes the
         * 600 step, dark text takes the 400 step.
         */
        emerald: {
          400: '#34D399', //  9.04:1 on the dark ground
          600: '#047857', //  5.25:1 on paper
        },
        amber: {
          400: '#FBBF24', // 10.41:1 on the dark ground
          // Pulled to hue 26 — 34 degrees off the warm ground, where the stock
          // amber-600 would have sat almost on top of it.
          600: '#B45309', //  4.81:1 on paper
        },
        red: {
          400: '#F87171', //  6.28:1 on the dark ground
          600: '#DC2626', //  4.62:1 on paper
        },

        /**
         * Semantic aliases, so NEW code names the meaning rather than the hue.
         * The existing rule still stands and is load-bearing: brand = the action
         * you can take, and it never indicates state.
         */
        state: {
          settled: '#047857',
          pending: '#B45309',
          failed: '#DC2626',
          neutral: '#6F6C66',
        },
      },
      fontFamily: {
        // 'Inter Variable' is the family name @fontsource-variable/inter
        // actually registers. Asking for plain 'Inter' silently fell through to
        // system-ui on every screen — see the note at the top of src/index.css.
        sans: ['Inter Variable', 'Inter', 'system-ui', 'sans-serif'],
        /**
         * THE MONO. Declared and explained at the top of src/index.css.
         *
         * `zero` and `tnum` are switched on for EVERY font-mono call site, not
         * left to the individual page. A slashed zero is the difference between
         * 0 and O on a wallet address, and `tnum` keeps hashes and ids from
         * jittering in a column. On a product where a misread address loses the
         * money for good, both are free once a real mono is loaded — and they
         * are exactly the kind of detail that never gets applied consistently
         * if it has to be remembered per usage.
         */
        mono: [
          ['JetBrains Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
          { fontFeatureSettings: '"zero", "tnum"' },
        ],
        /**
         * THE DISPLAY SERIF. Newsreader Variable, latin subset, declared and
         * explained at the top of src/index.css.
         *
         * Routed through the SAME custom property the three display classes
         * read, rather than repeating the stack here — two copies of a font
         * stack is how one of them ends up stale, and the point of this phase
         * is that the whole bet reverts by editing one line.
         *
         * `font-display` is for DISPLAY TYPE: a headline, a masthead figure,
         * the two or three words at the top of a page. It is not for body
         * copy, labels, controls, tables, or any figure a merchant reads to
         * make a decision — those stay on Inter, deliberately. If you are
         * about to put this on a number in a table, you want `.num`.
         */
        display: ['var(--font-display)'],
      },
      // Elevation is expressed as soft, low-opacity shadows rather than the
      // default hard grey — on a dark surface the stock Tailwind shadows are
      // invisible, which is why the dashboard read flat.
      boxShadow: {
        soft: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        lift: '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 8px 24px -4px rgb(15 23 42 / 0.10)',
        float: '0 8px 16px -4px rgb(15 23 42 / 0.10), 0 24px 48px -12px rgb(15 23 42 / 0.18)',
        'glow-brand': '0 0 0 1px rgb(79 70 229 / 0.20), 0 8px 24px -6px rgb(79 70 229 / 0.35)',
      },
      /**
       * RADIUS — collapsed onto a real three-step scale.
       *
       * The codebase had five radii coexisting (rounded-lg 56 uses, full 40,
       * xl 29, 2xl 14, md 8, 3xl 2), which is what made surfaces read as
       * assembled from different kits. Remapping the SCALE rather than editing
       * call sites collapses them with zero component edits.
       *
       * `borderRadius` merges per-key exactly like colours, so every key the
       * codebase actually uses is overridden — leaving one out is what would
       * reintroduce the problem it fixes. `rounded-full` is untouched and stays
       * correct on status dots, avatars and chips.
       */
      borderRadius: {
        sm: '3px',
        DEFAULT: '5px',
        md: '6px',
        lg: '8px',
        xl: '8px',
        '2xl': '10px',
        '3xl': '12px',
        '4xl': '12px',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};
