import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getCommission } from '@/lib/api';
import { errorMessage } from '@/lib/api';
import { formatAmount, formatRate, formatDate } from '@/lib/format';
import type { CommissionTier } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import Section from '@/components/Section';

/**
 * The merchant's own commission — the authoritative one.
 *
 * The public /pricing page deliberately shows the MODEL and never a number,
 * because rates are per-account and versioned. This page is where the number
 * lives, so it is set to read as definitive: ONE figure, larger than anything
 * else on the screen, on the first surface of the page, with everything that
 * qualifies it — the fixed fee, who pays gas, the formula, the worked example —
 * subordinate to it on surfaces of their own.
 *
 * WHAT CHANGED IN THE REDESIGN. The page used to be one continuous ruled spread:
 * a margin column of running heads against a wide column of content, divided by
 * hairlines. That is a broadsheet gesture, and on a page whose whole job is to
 * make ONE number unmissable it gave the rate no more standing than the prose
 * three inches under it. The rate now sits on its own lit surface, the schedule
 * sits on another, and the method sits on a third — so the eye lands on the
 * figure first and everything else is visibly an annotation of it.
 *
 * `effectiveFrom` is stated in the masthead rather than in a badge beside a
 * heading: it is a fact about the page, which is what PageHeader's `meta` is.
 *
 * NOTHING HERE IS A STATE, so nothing here carries a state colour. The old
 * version painted "network fee paid by" emerald or amber, which claimed that
 * the operator paying gas is money arriving and that you paying it is something
 * being waited on. Neither is true — it is a term of an agreement. The WORD
 * carries it, in ink.
 */

/** Human range label for a tier, e.g. "0.10 – 10.00 USDT" or "1,000.00+ USDT". */
function tierRange(tier: CommissionTier, currency: string): string {
  const min = formatAmount(tier.minAmount);
  if (tier.maxAmount === null) return `${min}+ ${currency}`;
  return `${min} – ${formatAmount(tier.maxAmount)} ${currency}`;
}

/** The charge as a bare quantity — "1%" or "1.00 USDT" — with no qualifier. */
function tierCharge(tier: CommissionTier, currency: string): string {
  if (tier.type === 'fixed') return `${formatAmount(tier.value)} ${currency}`;
  return `${formatRate(tier.value)}%`;
}

/** A ruled key/value row. The label ranges left, the value right, same rule. */
function SpineRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="spine-row">
      <dt className="spine-label">{label}</dt>
      <dd className="spine-value">{children}</dd>
    </div>
  );
}

/**
 * The one figure on the page. Deliberately larger than `.figure-lg`'s working
 * clamp and deliberately far smaller than `.figure-xl`'s marketing clamp: this
 * is the number the merchant came to read, and it should settle the question at
 * a glance without costing a screen of height on a tool.
 *
 * THE SIZE IS A CLAMP, NOT A BREAKPOINT PAIR, and that is a bug fix rather than
 * a preference. This used to read `text-[2.5rem] sm:text-[3rem]`, which pins the
 * figure to a fixed 40px at every width below 640 — including the 360px phone
 * where "1,000.00 USDT" then has nowhere to go. A clamp scales continuously with
 * the viewport, so there is no width at which the figure is wrong. It is set
 * inline rather than as a utility because an inline style is the only thing
 * guaranteed to beat `.figure-lg`'s own clamp without an `!important`, and
 * because a utility that pins a size is exactly what went wrong here before.
 */
function Figure({ children }: { children: ReactNode }) {
  return (
    <span
      className="figure-lg mt-3 break-words"
      style={{ fontSize: 'clamp(2.25rem, 1.6rem + 2vw, 3rem)' }}
    >
      {children}
    </span>
  );
}

/** Page-level load failure, set the way DataTable sets its own: no icon, no box. */
function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="surface p-5">
      <span className="runhead text-red-600 dark:text-red-400">Could not load</span>
      <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
        {message}
      </p>
      <button type="button" className="btn-secondary mt-5" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Static placeholder in the shape of the real page, so nothing jumps when the
 * rate lands — including the surfaces themselves, which is the part a bare
 * ghost strip used to miss: the blocks appearing under the placeholders was a
 * bigger movement than the text landing in them.
 *
 * `.ghost`, never a shimmer — the frequency boundary bans loops on a dashboard
 * route.
 */
function CommissionGhost() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="grid gap-3 lg:grid-cols-12" aria-busy="true">
        <div className="surface p-4 sm:p-5 lg:col-span-5">
          <span className="ghost h-3 w-32" aria-hidden />
          <span className="ghost mt-4 h-11 w-44" aria-hidden />
          <span className="ghost mt-4 h-3 w-full max-w-sm" aria-hidden />
          <span className="ghost mt-2 h-3 w-3/4 max-w-xs" aria-hidden />
          <div className="mt-8 space-y-4">
            <span className="ghost h-3 w-full max-w-sm" aria-hidden />
            <span className="ghost h-3 w-full max-w-sm" aria-hidden />
            <span className="ghost h-3 w-2/3 max-w-xs" aria-hidden />
          </div>
        </div>
        <div className="surface p-4 sm:p-5 lg:col-span-7">
          <span className="ghost h-3 w-48" aria-hidden />
          <div className="mt-6 space-y-4">
            <span className="ghost h-3 w-full max-w-md" aria-hidden />
            <span className="ghost h-3 w-full max-w-md" aria-hidden />
            <span className="ghost h-3 w-full max-w-md" aria-hidden />
          </div>
        </div>
      </div>
    </>
  );
}

export default function Commission() {
  const query = useQuery({ queryKey: ['commission'], queryFn: getCommission });
  const c = query.data;

  const tiers = c?.tiers ?? [];
  const isTiered = c?.type === 'tiered' || tiers.length > 0;
  const currency = c?.currency ?? 'USDT';

  const tierColumns: Column<CommissionTier>[] = [
    {
      key: 'range',
      header: 'Payment range',
      className: 'num',
      render: (t) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {tierRange(t, currency)}
        </span>
      ),
    },
    {
      // Right-ranged so the rates stack and can be compared down the column.
      // The qualifier is set BEFORE the figure for the same reason: trailing it
      // would push every number off the rule by a different amount.
      key: 'rate',
      header: 'Commission',
      numeric: true,
      render: (t) => (
        <>
          <span className="mr-2 text-xs font-normal text-slate-500 dark:text-slate-400">
            {t.type === 'fixed' ? 'flat' : 'of amount'}
          </span>
          <span className="font-medium text-slate-900 dark:text-slate-100">
            {tierCharge(t, currency)}
          </span>
        </>
      ),
    },
  ];

  /**
   * The stacked slab, for below `md`.
   *
   * DataTable now has a generic fallback, so this is no longer the difference
   * between a readable page and a sideways drag — but a slab is a RANGE and a
   * CHARGE, which is a sentence rather than a label/value pair, and the generic
   * fallback would set it as the latter. Two lines, the range leading and the
   * charge under it in the weight the number deserves, is what the row actually
   * says.
   */
  const tierMobileRow = (t: CommissionTier) => (
    <div className="flex items-baseline justify-between gap-4">
      <span className="num min-w-0 break-words text-[13.5px] font-medium text-slate-900 dark:text-slate-100">
        {tierRange(t, currency)}
      </span>
      <span className="min-w-0 shrink-0 text-right">
        <span className="num break-words text-sm font-semibold text-slate-900 dark:text-slate-100">
          {tierCharge(t, currency)}
        </span>
        <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">
          {t.type === 'fixed' ? 'flat' : 'of amount'}
        </span>
      </span>
    </div>
  );

  // Worked fee example on a 100 USDT payment (flat plans only).
  const example = 100;
  const pct = c ? Number(c.percent) : 0;
  const fixed = c?.fixedFee ? Number(c.fixedFee) : 0;
  const commissionFee = (example * pct) / 100 + fixed;
  const net = example - commissionFee;

  const gasPayer = c?.networkFeePaidBy === 'admin' ? 'The gateway operator' : 'You';

  return (
    <>
      <PageHeader
        eyebrow="Money"
        title="Commission"
        description="Your fee schedule exactly as the gateway applies it. Set by the operator and versioned — read-only here."
        meta={c ? <>In force since {formatDate(c.effectiveFrom)}</> : undefined}
      />

      {query.isLoading ? (
        <CommissionGhost />
      ) : query.isError ? (
        <LoadFailure
          message={errorMessage(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : c && isTiered ? (
        /* ============================================================
           TIERED. The schedule itself is the authoritative artefact, so it
           takes the wide surface; the narrow one states the one thing a slab
           table cannot say for itself — that rates do not stack.
           ============================================================ */
        <div className="grid gap-3 lg:grid-cols-12">
          <Section className="lg:col-span-4" title="Fee schedule">
            <Figure>{tiers.length}</Figure>
            <span className="figure-label measure">
              slabs. A payment falls into exactly one of them and the WHOLE
              amount is charged at that slab's rate — the rates are never
              stacked across tiers.
            </span>

            <dl className="mt-6">
              <SpineRow label="Network (gas) fee paid by">{gasPayer}</SpineRow>
              <SpineRow label="Charged in">{currency}</SpineRow>
            </dl>
          </Section>

          {/* `flush`: a ledger ranges to the edges of its own surface, and
              padding would inset the rows from the rules dividing them. */}
          <Section className="lg:col-span-8" flush title="The slabs">
            <DataTable
              columns={tierColumns}
              rows={tiers}
              rowKey={(t) => `${t.minAmount}-${t.maxAmount ?? 'max'}`}
              emptyLabel="No tiers configured."
              emptyHint="Your account is on a tiered plan but the operator has not published any slabs yet. Contact support before relying on a rate."
              label="Commission tiers"
              renderMobile={tierMobileRow}
            />
          </Section>

          <Section className="lg:col-span-12" title="How it is applied">
            <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              The whole payment amount is charged at the rate of the slab it
              falls into. A 900 {currency} payment is not billed partly at one
              rate and partly at another — it is billed entirely at the rate of
              the band it lands in.
            </p>
            <p className="measure mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              {c.networkFeePaidBy === 'client'
                ? 'You also cover the on-chain network (gas) fee for the sweep and payout. It is deducted from your side in addition to the commission above.'
                : 'The gateway operator covers the on-chain network (gas) fee for the sweep and payout, so nothing beyond the commission above is deducted from you.'}
            </p>
          </Section>
        </div>
      ) : c ? (
        /* ============================================================
           FLAT / PERCENTAGE. The rate is the page. It opens the first surface
           at display size; the worked example proves it on the second, set as
           a ledger with an ink rule above the total.
           ============================================================ */
        <div className="grid gap-3 lg:grid-cols-12">
          <Section className="lg:col-span-5" title="Your commission">
            <Figure>{formatRate(c.percent)}%</Figure>
            <span className="figure-label measure">
              of every settled payment
              {c.fixedFee
                ? `, plus a flat ${formatAmount(c.fixedFee)} ${currency} per transaction`
                : ''}
              . This is the rate in force right now, not an indicative one.
            </span>

            <dl className="mt-6">
              <SpineRow label="Fixed fee per transaction">
                {c.fixedFee ? (
                  <span className="num">
                    {formatAmount(c.fixedFee)} {currency}
                  </span>
                ) : (
                  'None'
                )}
              </SpineRow>
              <SpineRow label="Network (gas) fee paid by">{gasPayer}</SpineRow>
              <SpineRow label="Charged in">{currency}</SpineRow>
            </dl>
          </Section>

          <Section
            className="lg:col-span-7"
            title={
              <>
                Worked example · {formatAmount(example)} {currency} payment
              </>
            }
          >
            {/* A ledger, not a tinted panel: hairlines between the lines and an
                ink rule above the total, which is how a statement is set. No
                state colour — a worked example is an illustration, and painting
                a hypothetical payout emerald would claim funds arrived. */}
            <dl>
              <div className="spine-row">
                <dt className="spine-label">Gross received</dt>
                <dd className="spine-value num">
                  {formatAmount(example)} {currency}
                </dd>
              </div>
              <div className="spine-row">
                <dt className="spine-label">
                  Commission at {formatRate(c.percent)}%
                  {c.fixedFee ? ` + ${formatAmount(c.fixedFee)} ${currency}` : ''}
                </dt>
                <dd className="spine-value num">
                  − {formatAmount(commissionFee)} {currency}
                </dd>
              </div>
              <div className="rule-strong mt-1 flex items-baseline justify-between gap-4 pt-3">
                <dt className="shrink-0 text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Net payout
                </dt>
                <dd className="num min-w-0 break-words text-right text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {formatAmount(net)} {currency}
                </dd>
              </div>
            </dl>

            {c.networkFeePaidBy === 'client' && (
              <p className="measure mt-4 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                The on-chain network (gas) fee for the sweep and payout is
                deducted from your side on top of this, so the figure actually
                landing in your wallet is a little below {formatAmount(net)}{' '}
                {currency}.
              </p>
            )}
          </Section>

          <Section className="lg:col-span-12" title="Method">
            <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-400">
              For each settled payment the gateway deducts the commission before
              paying out to your wallet:
            </p>
            {/* The formula goes in a `.well` — the inset surface, not a raised
                one. It is a literal you might copy, and light does not catch on
                the top edge of a hole, which is exactly the depth cue a quoted
                snippet inside a surface wants. `break-words` because a long
                currency label must wrap rather than push the well sideways. */}
            <div className="well mt-3 px-3.5 py-3">
              <div className="space-y-1.5 break-words font-mono text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                <p>
                  commission = amount × {formatRate(c.percent)}%
                  {c.fixedFee ? ` + ${formatAmount(c.fixedFee)} ${currency}` : ''}
                </p>
                <p>
                  net_payout = amount − commission
                  {c.networkFeePaidBy === 'client' ? ' − network_fee' : ''}
                </p>
              </div>
            </div>
          </Section>
        </div>
      ) : null}
    </>
  );
}
