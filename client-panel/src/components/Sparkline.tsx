/**
 * A 44px trend line for the inside of a metric tile.
 *
 * DELIBERATELY NOT RECHARTS. The dashboard already pays for recharts on its two
 * real charts; a sparkline needs a path and an area under it, and rendering one
 * through a charting library costs a ResponsiveContainer, a resize observer and
 * a render pass per tile to draw twelve line segments. This is one `<svg>` and
 * a string.
 *
 * IT IS DECORATION, AND IT SAYS SO. `aria-hidden`, no axes, no labels, no
 * tooltip: the figure above it is the information, and this is the shape of
 * that figure. Anyone who needs to read the values has the full series one
 * section down. That is also why it is safe for it to carry no scale — a
 * sparkline with no y-axis is honest about being a silhouette, whereas one with
 * ticks would be a chart that is lying about its precision.
 *
 * `preserveAspectRatio="none"` lets the path stretch to whatever width the tile
 * ends up at, which is the whole reason the viewBox can be a fixed 100x32 and
 * the component can take no measurements.
 */
export default function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;

  const max = Math.max(...points);
  const min = Math.min(...points);
  // A flat series would divide by zero and, worse, would draw along the very
  // top edge where the stroke is half clipped. Falling back to 1 puts a flat
  // line through the middle of the box, which is the truthful picture.
  const span = max - min || 1;

  const W = 100;
  const H = 32;
  const step = W / (points.length - 1);
  const xy = points.map((v, i) => [i * step, H - ((v - min) / span) * H]);

  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `${line} L${W},${H} L0,${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block h-11 w-full overflow-visible text-emerald-600 dark:text-emerald-400"
      aria-hidden
    >
      <defs>
        <linearGradient id="spark-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.28} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#spark-fill)" />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinecap="round"
        strokeLinejoin="round"
        // The stroke must not stretch with the box, or a wide tile draws a
        // hairline and a narrow one draws a slab.
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
