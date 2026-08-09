/**
 * The hero illustration: an actual payment moving through the gateway.
 *
 * Inline SVG rather than an image so it inherits the theme (every colour is
 * `currentColor` or a Tailwind class), stays sharp at any size, costs no extra
 * request, and can animate the connectors with pure CSS. The dashes travelling
 * along the paths are the whole point — they show direction of flow, which a
 * static box diagram cannot.
 *
 * Decorative: the surrounding section carries the real text, so this is hidden
 * from assistive tech via role/aria on the wrapper.
 */
export default function PaymentFlowDiagram() {
  return (
    <div className="glass-card p-5 sm:p-7">
      <div className="mb-5 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Payment lifecycle
        </span>
        <span className="chip">
          <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />
          live
        </span>
      </div>

      <svg
        viewBox="0 0 420 260"
        className="w-full"
        role="img"
        aria-label="Diagram: a customer sends crypto to a unique deposit address; the gateway confirms it on-chain, notifies your server by signed webhook, and settles the funds to your wallet."
      >
        <defs>
          <linearGradient id="cg-node" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" className="[stop-color:theme(colors.brand.500)]" stopOpacity="0.16" />
            <stop offset="100%" className="[stop-color:theme(colors.brand.600)]" stopOpacity="0.06" />
          </linearGradient>
        </defs>

        {/* ---- connectors (drawn first so nodes sit on top) ---- */}
        <g
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          className="stroke-brand-500/60"
        >
          <path d="M104 62 H 210" className="animate-flow" />
          <path d="M210 62 V 122" className="animate-flow" style={{ animationDelay: '.25s' }} />
          <path d="M210 138 V 190" className="animate-flow" style={{ animationDelay: '.5s' }} />
          <path d="M186 198 H 116" className="animate-flow" style={{ animationDelay: '.75s' }} />
          <path d="M258 198 H 320" className="animate-flow" style={{ animationDelay: '.75s' }} />
        </g>

        {/* ---- 1. customer ---- */}
        <Node x={16} y={40} w={88} label="Customer" sub="sends crypto" />

        {/* ---- 2. deposit address ---- */}
        <g>
          <rect
            x={150}
            y={40}
            width={120}
            height={44}
            rx={11}
            fill="url(#cg-node)"
            className="stroke-brand-500/40"
            strokeWidth="1.5"
          />
          <text x={210} y={58} textAnchor="middle" className="fill-slate-900 dark:fill-slate-100" fontSize="11" fontWeight="650">
            Deposit address
          </text>
          <text x={210} y={72} textAnchor="middle" className="fill-slate-500" fontSize="9.5" fontFamily="ui-monospace, monospace">
            0x8842…2FCB
          </text>
        </g>

        {/* ---- 3. confirmations ---- */}
        <g>
          <rect
            x={150}
            y={116}
            width={120}
            height={40}
            rx={11}
            className="fill-white stroke-slate-200 dark:fill-slate-900 dark:stroke-slate-700"
            strokeWidth="1.5"
          />
          <text x={210} y={133} textAnchor="middle" className="fill-slate-900 dark:fill-slate-100" fontSize="11" fontWeight="650">
            Confirming
          </text>
          {/* Confirmation pips, filling left to right. */}
          <g>
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <circle
                key={i}
                cx={182 + i * 11}
                cy={146}
                r={3}
                className={i < 4 ? 'fill-brand-500' : 'fill-slate-300 dark:fill-slate-600'}
              >
                {i < 4 && (
                  <animate
                    attributeName="opacity"
                    values="0.35;1;0.35"
                    dur="1.8s"
                    begin={`${i * 0.22}s`}
                    repeatCount="indefinite"
                  />
                )}
              </circle>
            ))}
          </g>
        </g>

        {/* ---- 4. gateway ---- */}
        <g>
          <rect
            x={186}
            y={178}
            width={72}
            height={40}
            rx={11}
            fill="url(#cg-node)"
            className="stroke-brand-500/50"
            strokeWidth="1.5"
          />
          <text x={222} y={195} textAnchor="middle" className="fill-slate-900 dark:fill-slate-100" fontSize="11" fontWeight="650">
            Gateway
          </text>
          <text x={222} y={208} textAnchor="middle" className="fill-slate-500" fontSize="9">
            confirmed
          </text>
        </g>

        {/* ---- 5a. your server (webhook) ---- */}
        <Node x={16} y={176} w={100} label="Your server" sub="signed webhook" />

        {/* ---- 5b. your wallet (settlement) ---- */}
        <Node x={320} y={176} w={84} label="Your wallet" sub="settled" accent />

        {/* ---- labels on the wires ----
             x=127 is the midpoint of the exposed span between the customer box
             (ends at 104) and the deposit box (starts at 150). Centring on the
             whole connector instead would put this on top of the box. */}
        <text x={127} y={54} textAnchor="middle" className="fill-slate-400" fontSize="8.5">
          pays
        </text>
        <text x={66} y={236} textAnchor="middle" className="fill-slate-400" fontSize="8.5">
          payment.confirmed
        </text>
        <text x={362} y={236} textAnchor="middle" className="fill-slate-400" fontSize="8.5">
          net amount
        </text>
      </svg>
    </div>
  );
}

function Node({
  x,
  y,
  w,
  label,
  sub,
  accent = false,
}: {
  x: number;
  y: number;
  w: number;
  label: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={44}
        rx={11}
        className={
          accent
            ? 'fill-brand-600/10 stroke-brand-500/50 dark:fill-brand-400/10'
            : 'fill-white stroke-slate-200 dark:fill-slate-900 dark:stroke-slate-700'
        }
        strokeWidth="1.5"
      />
      <text
        x={x + w / 2}
        y={y + 19}
        textAnchor="middle"
        className="fill-slate-900 dark:fill-slate-100"
        fontSize="11"
        fontWeight="650"
      >
        {label}
      </text>
      <text
        x={x + w / 2}
        y={y + 32}
        textAnchor="middle"
        className="fill-slate-500"
        fontSize="9"
      >
        {sub}
      </text>
    </g>
  );
}
