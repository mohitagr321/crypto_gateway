/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /**
         * Kept byte-identical to the client panel's brand ramp on purpose: the
         * two panels are one product and an operator moving between them should
         * not see two different indigos.
         *
         * Indigo, not green, because green means "funds arrived" on every
         * status badge in both panels. Brand = the action you can take; it never
         * indicates state. See client-panel/tailwind.config.js for the full note.
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
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      // Same elevation scale as the client panel. Stock Tailwind shadows are
      // invisible on a dark surface, which is why this panel read flat.
      boxShadow: {
        soft: '0 1px 2px 0 rgb(15 23 42 / 0.04), 0 1px 3px 0 rgb(15 23 42 / 0.06)',
        lift: '0 2px 4px -1px rgb(15 23 42 / 0.06), 0 8px 24px -4px rgb(15 23 42 / 0.10)',
        float: '0 8px 16px -4px rgb(15 23 42 / 0.10), 0 24px 48px -12px rgb(15 23 42 / 0.18)',
      },
      keyframes: {
        shimmer: { '100%': { transform: 'translateX(100%)' } },
      },
      animation: {
        shimmer: 'shimmer 1.6s infinite',
      },
    },
  },
  plugins: [],
};
