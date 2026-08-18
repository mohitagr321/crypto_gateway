/** @type {import('tailwindcss').Config} */

/* ===========================================================================
 * "INSTRUMENT" — the design system this panel is set in.
 *
 * WHAT CHANGED, AND WHY THE COLOURS ARE NOW CUSTOM PROPERTIES.
 *
 * Every colour below resolves to `oklch(var(--x) / <alpha-value>)` rather than
 * to a hex literal. Three things fall out of that, and all three are the reason
 * it is worth the indirection:
 *
 *   1. OKLCH IS PERCEPTUALLY UNIFORM. A hex ramp hand-picked step by step drifts
 *      in lightness and chroma — that is why the previous ramp needed a
 *      paragraph of measured WCAG ratios to defend it. Here the L channel IS the
 *      lightness, so "one step darker" means the same thing at every point on
 *      the ramp, and a hue rotation cannot accidentally change how dark a step
 *      reads.
 *   2. GRADIENTS INTERPOLATE WITHOUT GREY MUD. sRGB interpolation between two
 *      saturated hues passes through a desaturated middle; the brand -> accent
 *      gradient this design leans on is the exact case where that shows.
 *   3. WHITE-LABELLING IS ONE DECLARATION. This gateway ships under an
 *      operator's own brand (see VITE_BRAND_NAME). Re-hueing the whole product
 *      is now `--b-500: <L> <C> <their hue>` in one place, not a rebuild of a
 *      hex ramp.
 *
 * THE `<alpha-value>` PLACEHOLDER is what keeps `bg-brand-500/20` working:
 * Tailwind substitutes the opacity into that slot. It means the custom property
 * must hold the OKLCH COMPONENTS ("0.575 0.205 269") and NOT a finished
 * `oklch(...)` string — a finished colour has nowhere for Tailwind to put the
 * alpha, and every `/N` utility in the codebase would silently render opaque.
 *
 * A CONSEQUENCE WORTH KNOWING BEFORE YOU EDIT src/index.css: `theme('colors.x')`
 * now returns the string `oklch(var(--n-900) / <alpha-value>)`, which is not a
 * valid colour outside a Tailwind utility. index.css therefore references the
 * custom properties directly. Do not reintroduce `theme()` for a colour.
 * ======================================================================== */

/**
 * Wrap a custom property as a Tailwind-consumable colour.
 * The property holds "L C H"; this adds the function and the alpha slot.
 */
const oklch = (v) => `oklch(var(${v}) / <alpha-value>)`;

export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * GROUND — a violet-tinted ink/paper ramp, shipped under Tailwind's
         * `slate` name.
         *
         * KEEPING THE NAME IS THE WHOLE TRICK, and it is the same trick the
         * previous ramp used: ~1,175 existing `bg-slate-50`, `text-slate-600`,
         * `dark:bg-slate-950` utilities across 51 files re-ground with zero
         * component edits.
         *
         * ALL STEPS MUST SHIP TOGETHER. `theme.extend.colors.slate` deep-merges
         * at the STEP level, so overriding only some leaves the rest at
         * Tailwind's cool defaults and the ramp ends up half violet, half blue.
         *
         * HUE 285. Far from every semantic hue (emerald 160, amber 55-80, red
         * 22-25), so the ground can carry visible colour without ever competing
         * with a status, and close enough to brand indigo (268) to read as one
         * family. The chroma is deliberately LOW at the ends and highest in the
         * middle: a tinted mid-grey reads as a designed neutral, while a tinted
         * white or a tinted black just reads as a colour cast.
         *
         * DARK GROUND IS NOT BLACK. 950 sits at L 0.152, not at 0 — an
         * "elevated black". True black gives a surface nowhere to be raised
         * above, which is the single most common reason a dark dashboard reads
         * flat, and it is the defect this redesign exists to fix. The elevation
         * ladder in dark is 950 (page) -> 900 (card) -> 850 (raised) -> 800
         * (border), and in light it is 50 (page) -> white (card) -> 100 (inset)
         * -> 200 (hairline).
         *
         * CONTRAST, measured rather than eyeballed — WCAG 2.1 relative
         * luminance, computed from the OKLCH triplets by
         * scratch/contrast.mjs, against the page ground of each theme:
         *
         *              light page (50)   dark page (950)
         *   300              1.68             10.86   <- dark body text
         *   400              2.74              6.67   <- dark secondary text;
         *                                              LIGHT: decorative only
         *   500              4.57              4.00   <- light secondary text
         *   600              6.95              2.63   <- light body text
         *
         * So: light text takes 600 (body) and 500 (secondary); dark text takes
         * 300 (body) and 400 (secondary). 400 NEVER carries text on the light
         * ground — it is for input borders and decorative icons, exactly as
         * before.
         */
        slate: {
          0: oklch('--n-0'), //    pure white — light-mode surface
          50: oklch('--n-50'), //  light page
          100: oklch('--n-100'), // light inset
          200: oklch('--n-200'), // light hairline
          300: oklch('--n-300'), // light divider / DARK body text
          400: oklch('--n-400'), // decorative + input borders / DARK secondary
          500: oklch('--n-500'), // light secondary text
          600: oklch('--n-600'), // light body text
          700: oklch('--n-700'),
          800: oklch('--n-800'), // dark hairline
          850: oklch('--n-850'), // dark raised surface
          900: oklch('--n-900'), // dark card
          950: oklch('--n-950'), // dark page
          975: oklch('--n-975'), // dark well — the one step BELOW the page
        },

        /**
         * BRAND — identity, and "this is the action you can take". Never a
         * state. That rule predates this redesign and survives it intact: green
         * means funds arrived, so a green CTA would put the button and "your
         * money is here" in one hue and colour would carry no information.
         *
         * THE STEPS ARE SPLIT BY JOB, and the split is a contrast result, not a
         * preference. White text on a fill needs 4.5:1, and that puts a hard
         * ceiling on how light the fill may be:
         *
         *   white on 500 (L .575)  4.60  <- the lightest fill that still passes
         *   white on 600 (L .510)  6.09
         *
         * which is why the primary button's gradient runs 500 -> 600 and never
         * reaches 400. 400 and 300 are for INK and LIGHT — dark-mode text
         * (8.20:1), focus rings, the glow under a lit control — never for a
         * surface that carries white type.
         */
        brand: {
          50: oklch('--b-50'),
          100: oklch('--b-100'),
          200: oklch('--b-200'),
          300: oklch('--b-300'), // dark-mode display ink, glow
          400: oklch('--b-400'), // dark-mode text/icon — 8.20:1 on the dark page
          500: oklch('--b-500'), // gradient top; lightest fill that holds white
          600: oklch('--b-600'), // light-mode text 5.66:1; gradient bottom
          700: oklch('--b-700'),
          800: oklch('--b-800'),
          900: oklch('--b-900'),
          950: oklch('--b-950'),
        },

        /**
         * ACCENT — cyan. The far end of the brand gradient and nothing else:
         * headline sweeps, the active-nav rail, a progress track, the mark.
         * NEVER on a control, because two interactive colours would undo the
         * rule above, and never as text on the light ground (2.29:1 — it is a
         * dark-mode and decorative hue only).
         */
        accent: {
          300: oklch('--a-300'),
          400: oklch('--a-400'),
          500: oklch('--a-500'),
          600: oklch('--a-600'),
        },

        /**
         * STATE — overridden in place so every existing `text-emerald-700`,
         * `bg-amber-100`, `dark:text-red-400` inherits the corrected values.
         *
         * THE 500 STEP NEVER CARRIES TEXT, unchanged from the previous system
         * and for the same measured reason. Light text takes 600, dark text
         * takes 400:
         *
         *            light page   dark page
         *   ok-600      4.73         —
         *   ok-400        —        10.81
         *   warn-600    4.54         —
         *   warn-400      —        11.49
         *   bad-600     5.45         —
         *   bad-400       —         7.64
         *
         * Amber sits at hue 55 on the 600 step rather than the 80 it uses at
         * 400. Pulling it orange is what buys the contrast: a true yellow
         * cannot reach 4.5:1 on paper without going brown.
         */
        emerald: {
          50: oklch('--ok-50'),
          300: oklch('--ok-300'),
          400: oklch('--ok-400'), // dark text — 10.81:1
          500: oklch('--ok-500'), // dots and fills only
          600: oklch('--ok-600'), // light text — 4.73:1
          700: oklch('--ok-700'),
          950: oklch('--ok-950'),
        },
        amber: {
          50: oklch('--warn-50'),
          300: oklch('--warn-300'),
          400: oklch('--warn-400'), // dark text — 11.49:1
          500: oklch('--warn-500'),
          600: oklch('--warn-600'), // light text — 4.54:1
          700: oklch('--warn-700'),
          950: oklch('--warn-950'),
        },
        red: {
          50: oklch('--bad-50'),
          300: oklch('--bad-300'),
          400: oklch('--bad-400'), // dark text — 7.64:1
          500: oklch('--bad-500'),
          600: oklch('--bad-600'), // light text — 5.45:1
          700: oklch('--bad-700'),
          950: oklch('--bad-950'),
        },

        /**
         * CATEGORICAL SERIES hues, for chart dimensions that carry NO status
         * meaning (per asset, per network, per client). Kept off every semantic
         * hue on purpose, so a series can never be mistaken for a state.
         * chartTheme.ts is the only thing that should reach for these.
         */
        cyan: { 400: oklch('--a-400'), 600: oklch('--a-600') },
        teal: { 400: oklch('--s-teal-400'), 600: oklch('--s-teal-600') },
        fuchsia: { 400: oklch('--s-fuchsia-400'), 600: oklch('--s-fuchsia-600') },
        sky: { 300: oklch('--s-sky-300'), 700: oklch('--s-sky-700') },

        /** Semantic aliases, so new code can name the meaning, not the hue. */
        state: {
          settled: oklch('--ok-600'),
          pending: oklch('--warn-600'),
          failed: oklch('--bad-600'),
        },
      },

      fontFamily: {
        /**
         * GEIST. Replaces Inter as the UI face and Newsreader as the display
         * face, and collapsing two families into one is most of why the product
         * now reads as a single instrument rather than as a newspaper.
         *
         * Geist is drawn for interfaces at small sizes AND holds up set large
         * and tight, which is exactly the range this product needs: an 11px
         * uppercase running head, a 13px table cell, and a 3.4rem money figure
         * on the checkout. Its digits are the reason it wins over the
         * alternatives here — near-monospaced by default, with a genuine
         * `tnum`, on a product where every screen is a column of amounts.
         *
         * THE FAMILY NAME IS 'Geist Variable', NOT 'Geist'. Read out of
         * node_modules/@fontsource-variable/geist/wght.css, not guessed — this
         * repo has been bitten three times by exactly this, and the failure is
         * SILENT: the page renders in system-ui and merely looks a bit plain.
         */
        sans: ['Geist Variable', 'Geist', 'Inter Variable', 'system-ui', 'sans-serif'],

        /**
         * GEIST MONO, on 55+ call sites carrying wallet addresses, transaction
         * hashes, API keys and order ids.
         *
         * `zero` and `tnum` are switched on for EVERY font-mono site rather than
         * left to the page. A slashed zero is the difference between 0 and O on
         * an address, and `tnum` keeps hashes from jittering down a column. On a
         * product where a misread address loses the money permanently, both are
         * free once a real mono is loaded, and both are exactly the kind of
         * detail that never gets applied consistently if it must be remembered.
         */
        mono: [
          ['Geist Mono Variable', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
          { fontFeatureSettings: '"zero", "tnum"' },
        ],

        /**
         * DISPLAY. Routed through one custom property rather than repeating a
         * stack, so the whole display bet reverts by editing one line in
         * index.css — the same discipline the outgoing serif was held to.
         * It now points AT Geist: this design gets its display presence from
         * size, weight and tracking, not from a second typeface.
         */
        display: ['var(--font-display)'],
      },

      /**
       * ELEVATION — rim light, not drop shadow.
       *
       * A drop shadow is how a surface floats on PAPER. On the near-black ground
       * this design is built on there is nothing for a shadow to fall on, which
       * is precisely why the old dark theme read flat: every card was a slightly
       * different grey rectangle with an invisible shadow under it.
       *
       * What replaces it is how a real object reads in a dark room — it catches
       * light on its top edge. Every shadow below therefore leads with an INSET
       * highlight and only then casts. The cast half still does its job in light
       * mode; the inset half is what makes the dark mode look built.
       */
      boxShadow: {
        soft: 'var(--shadow-soft)',
        lift: 'var(--shadow-lift)',
        float: 'var(--shadow-float)',
        rim: 'var(--shadow-rim)',
        /**
         * A lit control: a brand ring plus the bloom it throws. This one is NOT
         * theme-split, because it is not elevation — it is the light the button
         * itself emits, and a light source looks the same in both rooms.
         */
        'glow-brand':
          '0 0 0 1px oklch(var(--b-400) / 0.45), 0 6px 20px -8px oklch(var(--b-500) / 0.85), inset 0 1px 0 oklch(var(--n-0) / 0.22)',
      },

      /**
       * RADIUS — one scale, three real steps, remapped rather than re-called.
       *
       * The codebase names six radii across ~150 call sites. Remapping the SCALE
       * collapses them with zero component edits, which is the same move the
       * previous system made — only the values are new. They are LARGER here:
       * the outgoing 3-10px scale was drawn for a hairline-and-rules design
       * where a radius was an apology, and this one is drawn for surfaces that
       * are meant to read as objects.
       *
       * Every key the codebase uses must be overridden. Leaving one out is what
       * reintroduces the mixed-kit look this fixes. `rounded-full` is untouched
       * and stays correct on dots, avatars and pills.
       */
      borderRadius: {
        sm: '6px',
        DEFAULT: '8px',
        md: '10px',
        lg: '12px',
        xl: '14px',
        '2xl': '18px',
        '3xl': '24px',
        '4xl': '28px',
      },

      keyframes: {
        /**
         * `halo`, `sheen` and `drift` are DELIBERATELY ABSENT from this map and
         * are declared as plain CSS in src/index.css instead. Putting them here
         * is what broke them: Tailwind emits an `@keyframes` block only when the
         * matching `animate-*` UTILITY appears in a scanned file, and all three
         * are used from inside `@layer components` via `theme('animation.x')`.
         * Nothing writes `animate-halo`, so the keyframes were never generated
         * and the shorthand referenced an animation that did not exist — a
         * silent no-op, because a missing keyframe does not error.
         *
         * The entries below are all reached through a real `animate-*` utility
         * in a .tsx file, which is what keeps them emitted. Check that before
         * adding a fourth.
         */

        /** Entry: never from scale(0), never travelling more than 8px on a
         *  dashboard surface. */
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to: { opacity: '1', transform: 'none' },
        },
        /**
         * The expanding ring under a "live" dot on the MARKETING surfaces.
         *
         * Distinct from `halo`, and both are needed. `halo` grows a box-shadow
         * on a 6px status dot inside a lozenge; this scales a whole element and
         * is what the landing page's live indicator and the checkout demo's
         * status dot are built from. They were written against a class that the
         * token rewrite dropped, which left two "live" indicators rendering an
         * invisible static span — a silent failure, since the dot underneath
         * still painted and nothing looked broken.
         *
         * It loops, which is only permissible because both call sites are
         * marketing routes. The reduced-motion catch-all in index.css covers it.
         */
        'pulse-ring': {
          '0%': { transform: 'scale(0.85)', opacity: '0.55' },
          '70%': { transform: 'scale(1.5)', opacity: '0' },
          '100%': { opacity: '0' },
        },
        marquee: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
        flow: { to: { strokeDashoffset: '-24' } },
        /**
         * The two modal entrances, and they are deliberately different shapes.
         * A SHEET travels, because that is what tells you which edge it came
         * from and therefore where dismissing it sends it back to. A DIALOG
         * does not: a modal that slides in on a desktop reads as a
         * notification arriving rather than as the thing you just asked for.
         * Never `scale(0)` — entry is 0.98 and opacity, per the craft rules.
         */
        'sheet-in': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'none' },
        },
        'dialog-in': {
          from: { opacity: '0', transform: 'scale(0.98)' },
          to: { opacity: '1', transform: 'none' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s cubic-bezier(0.22, 1, 0.36, 1) both',
        halo: 'halo 2.6s cubic-bezier(0, 0, 0.2, 1) infinite',
        sheen: 'sheen 0.75s cubic-bezier(0.22, 1, 0.36, 1)',
        'pulse-ring': 'pulse-ring 2.4s cubic-bezier(0, 0, 0.2, 1) infinite',
        drift: 'drift 34s ease-in-out infinite alternate',
        marquee: 'marquee 38s linear infinite',
        flow: 'flow 1.1s linear infinite',
      },
    },
  },
  plugins: [],
};
