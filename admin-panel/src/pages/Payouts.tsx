import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import Badge, { NetworkLabel } from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import FormError, { FieldError } from '@/components/FormError';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import { apiErrorMessage, listClients, listPayouts, triggerPayout } from '@/lib/api';
import { addrLink, formatDate, formatUsdt, shortHash, txLink } from '@/lib/format';
import type { Payout, TriggerPayoutInput } from '@/types';

/**
 * MONEY OUT — settlement history, and the manual override.
 *
 * `sent` is amber rather than green throughout, and that is not a styling
 * choice: broadcast is not yet confirmed, and an operator who reads "sent" as
 * "done" is the person who pays a merchant twice. The word does the work; the
 * hollow ring is the shape that backs it up.
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
      render: (p) => <Badge status={p.status} />,
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
        subtitle="Every settlement the gateway has sent, and the manual trigger for the ones it has not."
        actions={
          <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
            <Send className="h-4 w-4" /> Trigger payout
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
        maxHeight="70vh"
        skeletonRows={10}
        pageSize={15}
        renderMobile={(p) => (
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
              <p className="num text-sm font-medium text-slate-900 dark:text-slate-50">
                {formatUsdt(p.amount)} {p.currency ?? 'USDT'}
              </p>
              <span className="mt-1 flex justify-end">
                <Badge status={p.status} />
              </span>
            </div>
          </div>
        )}
      />

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
            {mutation.isPending ? (
              <Loader2 className="motion-keep h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            Queue payout
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {mutation.isError && <FormError>{apiErrorMessage(mutation.error)}</FormError>}
        <div>
          <label className="label">Client</label>
          <select className="input" {...register('clientId', { required: 'Required' })}>
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
          <label className="label">Amount (USDT)</label>
          <input
            className="input"
            inputMode="decimal"
            placeholder="100.00"
            {...register('amount', { required: 'Required' })}
          />
          {errors.amount && <FieldError>{errors.amount.message}</FieldError>}
        </div>
        <div>
          <label className="label">Note (optional)</label>
          <input className="input" placeholder="Reason / reference" {...register('note')} />
        </div>
        <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          The payout is queued and sent to the client's configured payout wallet
          by the settlement worker. On-chain transfers are irreversible.
        </p>
      </div>
    </Modal>
  );
}
