/**
 * THE DEPTH FIELD — the layer everything else in the product floats on.
 *
 * Two fixed, pointer-events-none elements behind every route: a slowly
 * drifting aurora with a masked grid, and a grain tile over the top of it.
 * Together they are the difference between "a dark theme" and "a lit room",
 * and they are the reason a flat surface reads as an object here.
 *
 * WHY IT IS A COMPONENT AND NOT A `body::before`. It has to sit BEHIND the app
 * but ABOVE the page background, and it has to be mountable per shell — the
 * hosted checkout deliberately does not get the grid (see Checkout), because a
 * stranger paying an invoice should be looking at an amount and an address,
 * not at atmosphere.
 *
 * COST. Both layers are static paints. The aurora animates `transform` only, on
 * an element with `contain: strict`, so it composites and cannot invalidate
 * layout for the app in front of it. The grain is a 180x180 data-URI tile, not
 * a live SVG filter — the distinction is roughly two orders of magnitude of
 * paint cost on a phone.
 */
export default function DepthField() {
  return (
    <>
      <div className="depth-field" aria-hidden />
      <div className="grain" aria-hidden />
    </>
  );
}
