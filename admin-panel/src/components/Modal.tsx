import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { classNames } from '@/lib/format';

/**
 * The dialog. A card is the right primitive here and one of the few places it
 * still is — a modal genuinely IS a separate surface floating over the page,
 * which is the thing a border, a radius and a shadow are for.
 *
 * NO ENTRANCE ANIMATION. Every modal in this panel is opened by a click on a
 * control the operator is already looking at, so they are ahead of any reveal;
 * on a surface opened dozens of times a day an entrance is a tax charged once
 * per open, forever. The scrim and the panel are simply there.
 *
 * FOCUS. Opening moves focus into the dialog and closing returns it to whatever
 * opened it — without that, an operator who dismisses "Withdraw commission" with
 * Escape lands back at the top of the document.
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      returnTo.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-3xl' }[size];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={classNames(
          'relative z-10 w-full rounded-2xl border border-slate-200 bg-white shadow-float outline-none dark:border-slate-800 dark:bg-slate-900',
          width,
        )}
      >
        {/* The dialog's own masthead: title over a hairline, same gesture as a
            page header one level down. */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4 dark:border-slate-800">
          <h3 className="min-w-0 text-base font-semibold text-slate-900 dark:text-slate-50">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost h-8 w-8 shrink-0 !p-0"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 dark:border-slate-800">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
