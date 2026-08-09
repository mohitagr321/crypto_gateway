import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Percent, Save } from 'lucide-react';
import { useState } from 'react';
import Badge from '@/components/Badge';
import CommissionEditor, {
  buildCommissionInput,
  CommissionSummary,
  useCommissionDraft,
} from '@/components/CommissionEditor';
import DataTable, { type Column } from '@/components/DataTable';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import { apiErrorMessage, listClients, setCommission } from '@/lib/api';
import type { Client, SetCommissionInput } from '@/types';

export default function Commissions() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Client | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['clients'],
    queryFn: () => listClients(),
  });

  const columns: Column<Client>[] = [
    {
      key: 'name',
      header: 'Client',
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-gray-500">{c.email}</p>
        </div>
      ),
    },
    { key: 'status', header: 'Status', sortValue: (c) => c.status, render: (c) => <Badge status={c.status} /> },
    {
      key: 'rate',
      header: 'Rate',
      render: (c) =>
        c.commission?.type === 'tiered' ? (
          <span className="text-xs text-gray-500">Tiered ({c.commission.tiers?.length ?? 0} slabs)</span>
        ) : (
          <CommissionSummary commission={c.commission} />
        ),
    },
    {
      key: 'type',
      header: 'Type',
      render: (c) => <span className="capitalize">{c.commission?.type ?? '—'}</span>,
    },
    {
      key: 'feePayer',
      header: 'Fee payer',
      render: (c) => <span className="capitalize">{c.commission?.feePayer ?? '—'}</span>,
    },
    {
      key: 'version',
      header: 'Version',
      align: 'right',
      render: (c) => <span className="tabular-nums">{c.commission?.version ?? '—'}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      render: (c) => (
        <button className="btn-secondary !px-2 !py-1 text-xs" onClick={() => setEditing(c)}>
          Edit
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Commissions" subtitle="Per-client versioned commission configuration" />

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(c) => c.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        emptyMessage="No clients to configure."
        pageSize={15}
      />

      <EditCommissionModal
        client={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          qc.invalidateQueries({ queryKey: ['clients'] });
        }}
      />
    </>
  );
}

function EditCommissionModal({
  client,
  onClose,
  onSaved,
}: {
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { draft, setDraft, errors, setErrors } = useCommissionDraft(client?.commission);
  const [note, setNote] = useState('');

  const mutation = useMutation({
    mutationFn: (input: SetCommissionInput) => setCommission(input),
    onSuccess: onSaved,
  });

  const onSubmit = () => {
    if (!client) return;
    const result = buildCommissionInput(client.id, draft, note || undefined);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    mutation.mutate(result.input);
  };

  return (
    <Modal
      open={!!client}
      onClose={onClose}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Percent className="h-4 w-4" /> {client?.name} — commission
        </span>
      }
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={mutation.isPending || !client} onClick={onSubmit}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save version
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

        <CommissionEditor draft={draft} onChange={setDraft} errors={errors} />

        <div>
          <label className="label">Audit note</label>
          <input
            className="input"
            placeholder="Why is this changing? (stored with the versioned row)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Saving creates a new versioned commission row; historical versions are preserved for audit.
        </p>
      </div>
    </Modal>
  );
}
