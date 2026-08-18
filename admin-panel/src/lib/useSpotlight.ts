import { useEffect } from 'react';

/**
 * THE SPOTLIGHT — a cursor-follow highlight on every `.spot` surface.
 *
 * Byte-identical to client-panel/src/lib/useSpotlight.ts on purpose. The two
 * panels are one product and an operator with both open must not be able to
 * tell which window they are in from the way a tile lights.
 *
 * WITHOUT THIS HOOK MOUNTED, `.spot` FAILS SILENTLY, which is the reason it is
 * a hard requirement rather than a nicety: `--mx`/`--my` keep their 50%
 * defaults, so a spotlit surface lights from its own centre on hover instead of
 * under the pointer. The surface still paints, nothing errors, and the effect
 * is simply wrong in a way nobody reports. index.css says as much in the
 * SPOTLIGHT block — this file is what that comment was waiting for.
 *
 * ONE DELEGATED LISTENER FOR THE WHOLE APPLICATION, not one per card. This
 * console puts a dozen spotlit tiles on screen at once, and a dozen
 * `pointermove` handlers is a dozen closures firing on every mouse move; this
 * is one, attached at the document, that walks up from the event target.
 *
 * IT WRITES CUSTOM PROPERTIES, NOT STYLES. `--mx` / `--my` feed the radial
 * gradient in `.spot::after` (see index.css), so the browser repaints a
 * background and never touches layout. Nothing here reads geometry except
 * `getBoundingClientRect` on the one element under the pointer.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO:
 *
 *   - It does not run on touch. `pointermove` with `pointerType === 'touch'`
 *     fires only while a finger is down, so on a phone the effect would appear
 *     under the thumb mid-tap and then freeze there. A hover effect on a device
 *     with no hover is noise.
 *   - It does not run for `prefers-reduced-motion`. The gradient itself does not
 *     move, but it tracks the pointer, and tracking IS motion.
 *   - It does not clear on leave. The gradient fades out via the `:hover` rule
 *     in CSS, so the last position is where it fades FROM, which is correct —
 *     resetting to 50% would make it slide to the centre as it disappears.
 */
export function useSpotlight() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const target = e.target as Element | null;
      const el = target?.closest?.('.spot') as HTMLElement | null;
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${((e.clientX - r.left) / r.width) * 100}%`);
      el.style.setProperty('--my', `${((e.clientY - r.top) / r.height) * 100}%`);
    };

    document.addEventListener('pointermove', onMove, { passive: true });
    return () => document.removeEventListener('pointermove', onMove);
  }, []);
}
