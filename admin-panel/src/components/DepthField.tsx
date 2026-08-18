/**
 * THE DEPTH FIELD — the layer everything else in the console floats on.
 *
 * Two fixed, pointer-events-none elements behind every route: a slowly drifting
 * aurora with a masked grid, and a grain tile over the top of it. Together they
 * are the difference between "a dark theme" and "a lit room", and they are the
 * reason a flat surface reads as an object here. index.css already ships both
 * classes and has since the foundation landed; nothing mounted them, so the
 * console was running the new palette on a bare ground.
 *
 * WHY IT IS A COMPONENT AND NOT A `body::before`. It has to sit BEHIND the app
 * but ABOVE the page background, and it has to be mountable per shell — the
 * sign-in screen is a different shell from the console and can decide for
 * itself whether it wants atmosphere behind a password field.
 *
 * COST. Both layers are static paints. The aurora animates `transform` only, on
 * an element with `contain: strict`, so it composites and cannot invalidate
 * layout for the app in front of it. The grain is a 180x180 data-URI tile, not
 * a live SVG filter — the distinction is roughly two orders of magnitude of
 * paint cost on a phone.
 *
 * Byte-identical to client-panel/src/components/DepthField.tsx. Keep it that
 * way: the field is the single most visible thing the two panels share, and a
 * console whose aurora sits at a different opacity from the merchant panel's is
 * a seam an operator sees every time they switch windows.
 */
export default function DepthField() {
  return (
    <>
      <div className="depth-field" aria-hidden />
      <div className="grain" aria-hidden />
    </>
  );
}
