interface PayCrypoMarkProps {
  /** Rendered box, in px. Matches the lucide `size` prop it replaced. */
  size?: number;
  className?: string;
}

/**
 * The PayCrypo glyph: a "P" whose bowl is a hexagon.
 *
 * Byte-identical to client-panel/src/components/PayCrypoMark.tsx on purpose —
 * the two panels are one product, and an operator moving between them must not
 * see two different marks. They are separate Vite apps with no shared package,
 * so the duplication is the only way to say it; keep them in step, along with
 * public/favicon.svg in both apps.
 *
 * Fills with `currentColor` so the caller's tile owns the colour.
 */
export default function PayCrypoMark({ size = 21, className }: PayCrypoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="7 4 19 24"
      fill="currentColor"
      className={className}
      aria-hidden
      focusable="false"
    >
      <rect x="8.5" y="6" width="4" height="20" rx="2" />
      <path
        fillRule="evenodd"
        d="M18.5 6L24.56 9.5L24.56 16.5L18.5 20L12.44 16.5L12.44 9.5Z M18.5 9.8L15.73 11.4L15.73 14.6L18.5 16.2L21.27 14.6L21.27 11.4Z"
      />
    </svg>
  );
}
