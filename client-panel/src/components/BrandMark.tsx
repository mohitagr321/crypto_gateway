import { Link } from 'react-router-dom';
import PayCrypoMark from '@/components/PayCrypoMark';
import { BRAND_NAME, BRAND_TAGLINE } from '@/lib/brand';

interface BrandMarkProps {
  /** Wrap in a link to the public home page. Off inside the dashboard. */
  to?: string;
  size?: 'sm' | 'md';
  subtitle?: string;
}

/**
 * The mark + wordmark, shared by the marketing header, the auth screens and the
 * emails' visual language. Previously this markup was copy-pasted into Login
 * and Sidebar, which is how the two drifted apart.
 *
 * The tile used to be a ₮ glyph, then a stock lucide ShieldCheck. It is now the
 * PayCrypo mark: asset-neutral, because this gateway settles seven assets across
 * four chains and a Tether logo on a Bitcoin checkout is simply wrong, and
 * actually ours, because the shield was a placeholder half of fintech ships.
 * The name comes from lib/brand.ts, not from here.
 */
export default function BrandMark({
  to,
  size = 'md',
  subtitle = BRAND_TAGLINE,
}: BrandMarkProps) {
  const tile = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const glyph = size === 'sm' ? 17 : 21;

  const inner = (
    <span className="flex items-center gap-2.5">
      <span
        className={`flex ${tile} shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 text-white shadow-sm shadow-brand-600/30`}
        aria-hidden
      >
        <PayCrypoMark size={glyph} />
      </span>
      <span className="leading-tight">
        <span className="block text-[15px] font-semibold text-slate-900 dark:text-slate-50">
          {BRAND_NAME}
        </span>
        {subtitle && (
          <span className="block text-[11px] text-slate-500 dark:text-slate-400">
            {subtitle}
          </span>
        )}
      </span>
    </span>
  );

  return to ? (
    <Link to={to} className="inline-flex rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500">
      {inner}
    </Link>
  ) : (
    inner
  );
}
