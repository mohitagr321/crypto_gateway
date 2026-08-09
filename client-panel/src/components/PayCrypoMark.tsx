interface PayCrypoMarkProps {
  /** Rendered box, in px. Matches the lucide `size` prop it replaced. */
  size?: number;
  className?: string;
}

/**
 * The PayCrypo glyph: a "P" whose bowl is a hexagon.
 *
 * It replaced a generic lucide `ShieldCheck`, which was a placeholder rather
 * than a logo — every second fintech ships that same icon, and it said nothing
 * about this product. The hexagon is the blockchain-node shape crypto products
 * are read against; the letter carries the name. Still asset-neutral, which was
 * the point of dropping the original ₮ tile: the gateway settles seven assets
 * across four chains, so a Tether glyph on a Bitcoin checkout is just wrong.
 *
 * Fills with `currentColor` so the caller's tile owns the colour — every use
 * site puts it on the brand gradient in white.
 *
 * GEOMETRY IS DUPLICATED in public/favicon.svg and in admin-panel's copy of
 * this file, because neither a static asset nor a separate Vite app can import
 * from here. Change all three together.
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
