import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface CopyButtonProps {
  value: string;
  className?: string;
  label?: string;
  size?: number;
}

/**
 * COPY, AND IT IS VISIBLE BEFORE YOU TOUCH IT.
 *
 * The outgoing version was a bare glyph with `hover:bg-slate-100` and nothing
 * at rest — an affordance that exists only under a pointer. On a phone there is
 * no pointer: the button had no border, no fill and no shadow until the moment
 * it was already being pressed, so the single most important control on a
 * screen full of wallet addresses was indistinguishable from the address beside
 * it. That was a real audit finding.
 *
 * At rest it now wears `.btn-secondary`'s exact treatment — a `--surface` fill,
 * a `--line` hairline and the soft shadow — spelled in utilities rather than
 * borrowed, because `.btn` carries a 44px floor AND `px-4 text-sm` sizing that
 * would be wrong inside a 13px ledger cell. Taking the SURFACE fill rather than
 * the inset one is what makes it survive both of its grounds: on a card it is
 * the same colour as the card and the hairline draws the edge; sitting on a
 * `.well` — the address block, the code block header — it is one step lighter
 * than what is under it and reads as raised, which is what a control should do.
 *
 * 44px BELOW `sm`, relaxing at `sm`, the same floor `.btn` enforces. It was
 * `px-2 py-1` around a 16px glyph, which computes to roughly 24px — the
 * smallest touch target in the product, on the control a customer taps while
 * copying an address they are about to send money to.
 *
 * THE CONFIRMATION IS A WORD AND A SHAPE, not just a colour: the glyph becomes
 * a tick, the label becomes "Copied", and a polite live region announces it, so
 * a screen-reader user gets the same feedback a sighted one does. Emerald at
 * the 600/400 steps is correct here and is not decoration — this is the
 * "verified, it worked" ink, the same one a settled payment wears.
 */
export default function CopyButton({
  value,
  className = '',
  label,
  size = 16,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for insecure contexts.
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title="Copy to clipboard"
      aria-label={copied ? 'Copied to clipboard' : 'Copy to clipboard'}
      className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 select-none items-center justify-center gap-1.5 rounded-lg border border-[var(--line)] bg-[var(--surface)] px-2.5 text-xs font-medium text-slate-600 shadow-soft transition-[transform,border-color,color] duration-[var(--dur-press)] ease-[var(--ease-out)] hover:border-brand-500/50 hover:text-slate-900 active:scale-[0.975] sm:min-h-[34px] sm:min-w-[34px] dark:text-slate-300 dark:hover:text-slate-50 ${className}`}
    >
      {copied ? (
        <Check size={size} className="text-emerald-600 dark:text-emerald-400" aria-hidden />
      ) : (
        <Copy size={size} aria-hidden />
      )}
      {label && <span>{copied ? 'Copied' : label}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}
