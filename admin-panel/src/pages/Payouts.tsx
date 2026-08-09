import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Send } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import { apiErrorMessage, listClients, listPayouts, triggerPayout } from '@/lib/api';
import { addrLink, formatDate, formatUsdt, networkTone, shortHash, txLink } from '@/lib/format';
import type { Payout, TriggerPayoutInput } from '@/types';

export default function Payouts() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['payouts'],
    queryFn: () => listPayouts(),
  });

  const columns: Column<Payout>[] = [
    {
      key: 'createdAt',
      header: 'Requested',
      sortValue: (p) => p.createdAt,
      render: (p) => <span className="text-xs text-gray-500">{formatDate(p.createdAt)}</span>,
    },
    {
      key: 'client',
      header: 'Client',
      sortValue: (p) => p.clientName ?? '',
      render: (p) => <span>{p.clientName ?? shortHash(p.clientId, 6, 4)}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      sortValue: (p) => Number(p.amount ?? 0),
      render: (p) => (
        <span className="tabular-nums">
          {formatUsdt(p.amount)} {p.currency ?? 'USDT'}
        </span>
      ),
    },
    {
      key: 'network',
      header: 'Network',
      sortValue: (p) => p.network ?? 'BEP20',
      render: (p) => <Badge tone={networkTone(p.network)}>{p.network ?? 'BEP20'}</Badge>,
    },
    { key: 'status', header: 'Status', sortValue: (p) => p.status, render: (p) => <Badge status={p.status} /> },
    {
      key: 'to',
      header: 'Destination',
      render: (p) =>
        p.toAddress ? (
          <a
            href={addrLink(p.toAddress, p.network)}
            target="_blank"
            rel="noreferrer"
            className="text-brand-600 hover:underline"
          >
            <code className="text-xs">{shortHash(p.toAddress, 8, 4)}</code>
          </a>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
    {
      key: 'tx',
      header: 'Tx',
      render: (p) =>
        p.txHash ? (
          <a
            href={txLink(p.txHash, p.network)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-brand-600 hover:underline"
          >
            {shortHash(p.txHash)} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          <span className="text-gray-400">—</span>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Payouts"
        subtitle="Settlement history and manual triggers"
        actions={
          <button className="btn-primary" onClick={() => setOpen(true)}>
            <Send className="h-4 w-4" /> Trigger payout
          </button>
        }
      />

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(p) => p.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        emptyMessage="No payouts yet."
        pageSize={15}
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
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={mutation.isPending}
            onClick={handleSubmit((v) => mutation.mutate(v))}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Queue payout
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {mutation.isError && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {apiErrorMessage(mutation.error)}
          </div>
        )}
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
          {errors.clientId && <p className="mt-1 text-xs text-red-600">{errors.clientId.message}</p>}
        </div>
        <div>
          <label className="label">Amount (USDT)</label>
          <input
            className="input"
            placeholder="100.00"
            {...register('amount', { required: 'Required' })}
          />
          {errors.amount && <p className="mt-1 text-xs text-red-600">{errors.amount.message}</p>}
        </div>
        <div>
          <label className="label">Note (optional)</label>
          <input className="input" placeholder="Reason / reference" {...register('note')} />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          The payout is queued and sent to the client's configured payout wallet by the settlement worker.
        </p>
      </div>
    </Modal>
  );
}
