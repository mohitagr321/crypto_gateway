import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Send } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import Badge, { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import FormError, { FieldError } from '@/components/FormError';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import Spinner from '@/components/Spinner';
import { apiErrorMessage, listClients, listPayouts, triggerPayout } from '@/lib/api';
import { addrLink, formatDate, formatUsdt, shortHash, txLink } from '@/lib/format';
import type { Payout, TriggerPayoutInput } from '@/types';

/**
 * MONEY OUT — settlement history, and the manual override.
 *
 * `sent` is amber rather than green throughout, and that is not a styling
 * choice: broadcast is not yet confirmed, and an operator who reads "sent" as
 * "done" is the person who pays a merchant twice. The word does the work; the
 * lozenge's pulsing dot is the shape that backs it up, which is why every status
 * on this page passes `dot`.
 *
 * THE ROW'S TWO LINKS SURVIVE ON A PHONE NOW. Destination and transaction were
 * both `hideOnMobile` and both absent from the stacked row, so below `md` the
 * page could tell an operator that a payout was `unresolved` and give them no
 * way to check the explorer — which is the single thing that state exists to
 * make them do. Same defect Clients had with its action buttons, in a quieter
 * shape.
 */
export default function Payouts() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['payouts'],
    queryFn: () => listPayouts(),
  });

  const rows = data?.data ?? [];

  const columns: Column<Payout>[] = [
    {
      key: 'createdAt',
      header: 'Requested',
      sortValue: (p) => p.createdAt,
      render: (p) => (
        <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDate(p.createdAt)}
        </span>
      ),
    },
    {
      key: 'client',
      header: 'Client',
      sortValue: (p) => p.clientName ?? '',
      render: (p) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {p.clientName ?? shortHash(p.clientId, 6, 4)}
        </span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      numeric: true,
      sortValue: (p) => Number(p.amount ?? 0),
      render: (p) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatUsdt(p.amount)}
          <span className="font-normal text-slate-500 dark:text-slate-400">
            {' '}
            {p.currency ?? 'USDT'}
          </span>
        </span>
      ),
    },
    {
      key: 'network',
      header: 'Network',
      hideOnMobile: true,
      sortValue: (p) => p.network ?? 'BEP20',
      render: (p) => <NetworkLabel network={p.network} />,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (p) => p.status,
      render: (p) => <Badge status={p.status} dot />,
    },
    {
      key: 'to',
      header: 'Destination',
      hideOnMobile: true,
      render: (p) =>
        p.toAddress ? (
          <a
            href={addrLink(p.toAddress, p.network)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="link-ink font-mono text-xs"
          >
            {shortHash(p.toAddress, 8, 4)}
          </a>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">not set</span>
        ),
    },
    {
      key: 'tx',
      header: 'Tx',
      hideOnMobile: true,
      render: (p) =>
        p.txHash ? (
          <a
            href={txLink(p.txHash, p.network)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="link-ink inline-flex items-center gap-1 font-mono text-xs"
          >
            {shortHash(p.txHash)} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">not broadcast</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Money out"
        title="Payouts"
        description="Every settlement the gateway has sent, and the manual trigger for the ones it has not."
        actions={
          <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
            <Send className="h-4 w-4" aria-hidden /> Trigger payout
          </button>
        }
        meta={
          isLoading
            ? undefined
            : `${rows.length.toLocaleString()} payout${rows.length === 1 ? '' : 's'}${
                isFetching ? ' · updating' : ''
              }`
        }
      />

      <Section flush title="Settlement history">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={isLoading}
          error={isError ? apiErrorMessage(error) : null}
          onRetry={() => refetch()}
          emptyMessage="No payouts yet."
          emptyHint="A payout appears here when a merchant requests one, or when you queue one from this page."
          emptyAction={
            <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
              Trigger a payout
            </button>
          }
          label="Payouts"
          defaultSortKey="createdAt"
          defaultSortDir="desc"
          // `dvh`, never `vh` — mobile Safari's `vh` excludes the collapsing
          // toolbar and is always taller than the visible viewport.
          maxHeight="70dvh"
          skeletonRows={10}
          pageSize={15}
          /**
           * THE STACKED ROW, WITH ITS LINKS. The chain, the destination and the
           * transaction all live on a second line under the money, each at the
           * 44px touch floor. The chain is printed beside them rather than
           * inferred, because an address or a hash without its network is a link
           * to the wrong explorer — and a TRC20 hash on BscScan is a dead page,
           * not an error.
           */
          renderMobile={(p) => (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900 dark:text-slate-50">
                    {p.clientName ?? shortHash(p.clientId, 6, 4)}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {formatDate(p.createdAt)}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="num break-words text-sm font-medium text-slate-900 dark:text-slate-50">
                    {formatUsdt(p.amount)} {p.currency ?? 'USDT'}
                  </p>
                  <span className="mt-1 flex justify-end">
                    <Badge status={p.status} dot />
                  </span>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs">
                <NetworkLabel network={p.network} />
                {p.toAddress ? (
                  <a
                    href={addrLink(p.toAddress, p.network)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="link-ink inline-flex min-h-[44px] items-center gap-1 font-mono"
                  >
                    to {shortHash(p.toAddress, 6, 4)}
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : (
                  <span className="inline-flex min-h-[44px] items-center text-slate-500 dark:text-slate-400">
                    no destination set
                  </span>
                )}
                {p.txHash ? (
                  <a
                    href={txLink(p.txHash, p.network)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="link-ink inline-flex min-h-[44px] items-center gap-1 font-mono"
                  >
                    {shortHash(p.txHash)} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : (
                  <span className="inline-flex min-h-[44px] items-center text-slate-500 dark:text-slate-400">
                    not broadcast
                  </span>
                )}
              </div>
            </div>
          )}
        />
      </Section>

      <TriggerPayoutModal
        open={open}
        onClose={() => setOpen(false)}
        onDone={() => {
          setOpen(false);
          qc.invalidateQueries({ queryKey: ['payouts'] });
        }}
      />
    </>
  );
}

function TriggerPayoutModal({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const clientsQuery = useQuery({ queryKey: ['clients'], queryFn: () => listClients(), enabled: open });
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<TriggerPayoutInput>();

  const mutation = useMutation({
    mutationFn: (input: TriggerPayoutInput) => triggerPayout(input),
    onSuccess: () => {
      reset();
      onDone();
    },
  });

  const clients = clientsQuery.data?.data ?? [];

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Trigger manual payout"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={mutation.isPending}
            onClick={handleSubmit((v) => mutation.mutate(v))}
          >
            {/* Spinner inherits `currentColor`, so inside a primary control it
                is the button's white without anything being passed. It carries
                `motion-keep` itself — a frozen spinner on a payout reads as a
                hung broadcast, which is the one thing an operator must not have
                to guess about. */}
            {mutation.isPending ? (
              <Spinner size={16} />
            ) : (
              <Send className="h-4 w-4" aria-hidden />
            )}
            Queue payout
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {mutation.isError && <FormError>{apiErrorMessage(mutation.error)}</FormError>}
        <div>
          <label className="label" htmlFor="payout-client">
            Client
          </label>
          <select
            id="payout-client"
            className="input"
            {...register('clientId', { required: 'Required' })}
          >
            <option value="">Select a client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {formatUsdt(c.availableBalance)} USDT available
              </option>
            ))}
          </select>
          {errors.clientId && <FieldError>{errors.clientId.message}</FieldError>}
        </div>
        <div>
          <label className="label" htmlFor="payout-amount">
            Amount (USDT)
          </label>
          <input
            id="payout-amount"
            className="input num"
            inputMode="decimal"
            placeholder="100.00"
            {...register('amount', { required: 'Required' })}
          />
          {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
        </div>
        <div>
          <label className="label" htmlFor="payout-note">
            Note (optional)
          </label>
          <input
            id="payout-note"
            className="input"
            placeholder="Reason / reference"
            {...register('note')}
          />
        </div>
        <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          The payout is queued and sent to the client's configured payout wallet
          by the settlement worker. On-chain transfers are irreversible.
        </p>
      </div>
    </Modal>
  );
}
