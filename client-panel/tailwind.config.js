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
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
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
      borderRadius: {
        '4xl': '2rem',
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
