/** @type {import('tailwindcss').Config} */

/**
 * THE GROUND, ported verbatim from client-panel/tailwind.config.js.
 *
 * The operator console and the merchant panel are ONE PRODUCT. Anything that
 * differs between the two files here shows up as a seam the moment somebody
 * has both open, which is most of an operator's day. Read that file before
 * editing this one; the long-form rationale lives there and is not duplicated.
 */

// ---------------------------------------------------------------------------
// GROUND — a warm ink/paper ramp.
//
// Low-chroma (hue ~60, near-zero saturation), NOT saturated bone. Saturated
// bone sits at hue ~40 and amber at 37.7 — two degrees apart, where the old
// cool ramp gave 172. Warm paper is the escape from the dark-indigo-Inter
// monoculture our own #6366f1 sits inside, but it only works if "pending" is
// still instantly separable from the page.
//
// Contrast measured with the WCAG relative-luminance formula, on 50.
//
// ALL ELEVEN STEPS MUST SHIP TOGETHER. `theme.extend.colors.<name>` deep-merges
// at the STEP level, so overriding only some leaves the rest at Tailwind's cool
// defaults and the ramp ends up half warm, half blue.
// ---------------------------------------------------------------------------
const ground = {
  50: '#FAFAF8', //  page
  100: '#F3F2EE', //  inset
  200: '#E5E3DD', //  hairline rules
  300: '#CFCCC4', //  dividers
  400: '#94918A', //  3.01:1 — input borders + decorative icons ONLY, never text
  500: '#6F6C66', //  5.01:1 — secondary text
  600: '#565350', //  7.31:1 — body text
  700: '#413F3C', // 10.04:1
  800: '#292826', //  dark raised
  900: '#1B1A19', //  dark card
  950: '#121211', //  dark ground
};

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * BRAND — identity and "this is the action to take". Byte-identical to
         * the client panel's ramp on purpose: an operator moving between the two
         * panels must not see two different indigos.
         *
         * Indigo, not green, because green means "funds arrived" on every status
         * badge in both panels. Brand = interactive; it never indicates state.
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
         * travel. Never on a control — two interactive colours would undo the
         * point of the rule above.
         */
        accent: {
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
        },

        /**
         * The ramp ships under BOTH names, and that is deliberate.
         *
         * The client panel remapped Tailwind's `slate` because that is the name
         * its 1,175 neutral utilities were already written against. This panel
         * was written against `gray` instead — 227 usages, and not one `slate-*`
         * anywhere in src/. Remapping only `slate` here would have re-grounded
         * exactly nothing and left the operator console cool while the merchant
         * panel went warm: the precise seam this phase exists to close.
         *
         * So `gray` carries the remap for the code that exists, and `slate`
         * carries it for the code being written now — the house rule is that new
         * work names `slate-*`, matching the client panel. Same eleven values,
         * two spellings, so a page part-way through the rename is still visually
         * whole and the rename itself is a pure no-op.
         */
        slate: ground,
        gray: ground,

        /**
         * STATE — overridden in place so existing `text-emerald-700`,
         * `bg-amber-100`, `dark:text-red-400` inherit the corrected values.
         *
         * THE 500 STEP NEVER CARRIES TEXT: measured, emerald-500 lands at 4.27:1
         * and amber-500 at 3.25:1 on paper — both AA failures, on the money
         * figure that is the entire point of the screen. Light text takes the
         * 600 step, dark text takes the 400 step. (Icons at 500 are fine.)
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
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Elevation as soft, low-opacity shadows rather than the default hard
      // grey — on a dark surface the stock Tailwind shadows are invisible,
      // which is why this panel read flat.
      boxShadow: {
        soft: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        lift: '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 8px 24px -4px rgb(15 23 42 / 0.10)',
        float: '0 8px 16px -4px rgb(15 23 42 / 0.10), 0 24px 48px -12px rgb(15 23 42 / 0.18)',
        'glow-brand': '0 0 0 1px rgb(79 70 229 / 0.20), 0 8px 24px -6px rgb(79 70 229 / 0.35)',
      },
      /**
       * RADIUS — collapsed onto a real three-step scale.
       *
       * Multiple radii coexisting is what makes surfaces read as assembled from
       * different kits. Remapping the SCALE rather than editing call sites
       * collapses them with zero component edits.
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
