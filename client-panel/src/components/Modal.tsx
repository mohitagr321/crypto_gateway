import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** When false, clicking the backdrop / Esc won't close (e.g. one-time secret). */
  dismissable?: boolean;
}

const sizes = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
};

/**
 * A DIALOG ON DESKTOP, A SHEET ON A PHONE — one component, because they are the
 * same thing wearing the size it fits into.
 *
 * The outgoing version was a centred card at every width. On a 360px viewport
 * that produced a floating box with 16px of dead margin on each side, its own
 * 24px of padding inside that, and a `max-h-[90vh]` that measured against a
 * viewport TALLER than the visible one — so the footer, which is where the
 * confirm button lives, could sit under the browser's own toolbar. A merchant
 * could not reach "Save".
 *
 * What it does now:
 *
 *   BELOW `sm`   full-bleed, pinned to the bottom edge, rounded at the top
 *                only. It enters by travelling, which is the whole point of a
 *                sheet: it tells you which direction it came from and
 *                therefore where it will go back to.
 *   FROM `sm`    a centred dialog that scales in from 0.98. It does NOT
 *                travel — a modal that slides on a desktop reads as a
 *                notification rather than as the thing you just asked for.
 *
 * `100dvh` RATHER THAN `100vh`, throughout. On mobile Safari `vh` is the
 * viewport WITHOUT the collapsing toolbar, i.e. always taller than what you can
 * see, and it is the direct cause of the unreachable-footer bug above.
 *
 * THE BODY IS THE ONLY SCROLLER. Header and footer are pinned, so the title
 * stays visible while a long form scrolls and the primary action never leaves
 * the screen. `pb-[env(safe-area-inset-bottom)]` on the footer keeps that
 * action clear of the iOS home indicator.
 */
export default function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = 'md',
  dismissable = true,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * FOCUS MANAGEMENT, SCROLL LOCK AND ESCAPE — all three, because a dialog with
   * only some of them is a dialog that fails a keyboard user in a way nobody
   * notices with a mouse.
   *
   * The trap is the part that was missing. Without it, Tab walks straight out of
   * the panel and into the page behind it: the user is still looking at a modal,
   * their focus ring has vanished somewhere under the scrim, and on a sheet that
   * holds a one-time API secret they can tab to controls they were never meant
   * to reach while it is open. `aria-modal` tells assistive tech the rest of the
   * page is inert; it does not make it inert for the Tab key, which is a common
   * and reasonable thing to assume and is wrong.
   *
   * FOCUS IS RESTORED to whatever opened the dialog. Losing it to `<body>` on
   * close means the next Tab starts from the top of the document, which on this
   * product means crossing the whole navigation rail to get back to the button
   * the user just pressed.
   *
   * The selector deliberately excludes `[tabindex="-1"]` — programmatically
   * focusable, but not part of the tab ring — and the panel itself takes
   * `tabIndex={-1}` so it can receive focus when it contains no focusable child
   * at all, which is the case for a purely informational dialog.
   */
  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Focus the first control rather than the panel where there is one: on a
    // form dialog that puts the caret in the first field, which is what the
    // user came to do.
    const first = focusable()[0];
    (first ?? panelRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissable) {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstItem = items[0];
      const lastItem = items[items.length - 1];
      const active = document.activeElement;

      // Wrap at both ends, and also catch the case where focus has somehow
      // already escaped the panel — pull it back rather than letting Tab
      // continue through the page.
      if (e.shiftKey && (active === firstItem || !panelRef.current?.contains(active))) {
        e.preventDefault();
        lastItem.focus();
      } else if (!e.shiftKey && (active === lastItem || !panelRef.current?.contains(active))) {
        e.preventDefault();
        firstItem.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      previouslyFocused?.focus?.();
    };
  }, [open, onClose, dismissable]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={dismissable ? onClose : undefined}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`surface relative z-10 flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-b-none rounded-t-3xl shadow-float outline-none sm:max-h-[88dvh] sm:rounded-2xl ${sizes[size]} motion-safe:animate-[sheet-in_var(--dur-modal)_var(--ease-out)] sm:motion-safe:animate-[dialog-in_var(--dur-modal)_var(--ease-out)]`}
      >
        {(title || dismissable) && (
          <div className="flex shrink-0 items-start justify-between gap-4 px-5 pb-3 pt-5 sm:px-6">
            {/* The grabber says "this is a sheet and it came from down there".
                Purely a signifier, so it is hidden from assistive tech and is
                not a control — it is not draggable and must not look like it
                on a surface where a mis-drag would dismiss unsaved input. */}
            <span
              className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-slate-300 sm:hidden dark:bg-slate-700"
              aria-hidden
            />
            {title && (
              <h2 className="min-w-0 text-lg font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-100">
                {title}
              </h2>
            )}
            {dismissable && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 -mt-1 grid h-10 w-10 shrink-0 place-items-center rounded-full text-slate-400 transition-colors hover:bg-[var(--hover)] hover:text-slate-600 dark:hover:text-slate-300"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-1 sm:px-6">{children}</div>

        {footer && (
          <div
            className="flex shrink-0 flex-col-reverse gap-2 border-t border-[var(--line-soft)] bg-[var(--surface-2)] px-5 py-4 sm:flex-row sm:justify-end sm:px-6"
            style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
