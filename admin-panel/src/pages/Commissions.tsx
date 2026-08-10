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
import FormError from '@/components/FormError';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import { apiErrorMessage, listClients, setCommission } from '@/lib/api';
import type { Client, SetCommissionInput } from '@/types';

/**
 * THE RATE CARD — what every merchant is charged, in one ledger.
 *
 * This screen sets real money rates, so the whole route is behind the
 * super_admin guard in App.tsx and nothing here softens that. What changed is
 * only how it reads: rates ranged right on tabular figures so they can be
 * compared down the column, which is the entire reason an operator opens a page
 * of rates rather than editing them one merchant at a time.
 */
export default function Commissions() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<Client | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['clients'],
    queryFn: () => listClients(),
  });

  const rows = data?.data ?? [];

  const columns: Column<Client>[] = [
    {
      key: 'name',
      header: 'Client',
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-slate-900 dark:text-slate-100">{c.name}</p>
          <p className="truncate text-xs text-slate-500 dark:text-slate-400">{c.email}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (c) => c.status,
      render: (c) => <Badge status={c.status} />,
    },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      render: (c) =>
        c.commission?.type === 'tiered' ? (
          <span className="num text-slate-700 dark:text-slate-300">
            Tiered · {c.commission.tiers?.length ?? 0} slab
            {(c.commission.tiers?.length ?? 0) === 1 ? '' : 's'}
          </span>
        ) : (
          <CommissionSummary commission={c.commission} />
        ),
    },
    {
      key: 'type',
      header: 'Type',
      hideOnMobile: true,
      sortValue: (c) => c.commission?.type ?? '',
      render: (c) =>
        c.commission?.type ? (
          <span className="capitalize">{c.commission.type}</span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Not set</span>
        ),
    },
    {
      key: 'feePayer',
      header: 'Fee payer',
      hideOnMobile: true,
      sortValue: (c) => c.commission?.feePayer ?? '',
      render: (c) =>
        c.commission?.feePayer ? (
          <span className="capitalize">{c.commission.feePayer}</span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Not set</span>
        ),
    },
    {
      key: 'version',
      header: 'Version',
      numeric: true,
      hideOnMobile: true,
      sortValue: (c) => c.commission?.version ?? 0,
      render: (c) =>
        c.commission?.version ?? <span className="text-slate-500 dark:text-slate-400">—</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (c) => (
        <button
          type="button"
          className="btn-secondary !px-2 !py-1 text-xs"
          onClick={() => setEditing(c)}
        >
          Edit rate
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Merchants"
        title="Commissions"
        subtitle="What each merchant is charged. Every change is saved as a new version and kept for audit."
        meta={
          isLoading
            ? undefined
            : `${rows.length.toLocaleString()} client${rows.length === 1 ? '' : 's'}`
        }
      />

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        onRetry={() => refetch()}
        emptyMessage="No clients to configure."
        emptyHint="Onboard a merchant first — a rate can only be set against an existing account."
        label="Commission rates"
        maxHeight="70vh"
        skeletonRows={8}
        pageSize={15}
        renderMobile={(c) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900 dark:text-slate-50">{c.name}</p>
              <p className="mt-0.5 text-xs capitalize text-slate-500 dark:text-slate-400">
                {c.commission?.type ?? 'no rate set'}
              </p>
            </div>
            <div className="shrink-0 text-right">
              {c.commission?.type === 'tiered' ? (
                <span className="num text-sm text-slate-900 dark:text-slate-50">
                  Tiered · {c.commission.tiers?.length ?? 0} slabs
                </span>
              ) : (
                <CommissionSummary commission={c.commission} />
              )}
              <button
                type="button"
                className="btn-secondary mt-2 !px-2 !py-1 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditing(c);
                }}
              >
                Edit rate
              </button>
            </div>
          </div>
        )}
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
          <Percent className="h-4 w-4 shrink-0" aria-hidden /> {client?.name} — commission
        </span>
      }
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={mutation.isPending || !client}
            onClick={onSubmit}
          >
            {mutation.isPending ? (
              <Loader2 className="motion-keep h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save version
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {mutation.isError && (
          <FormError title="Commission not saved">{apiErrorMessage(mutation.error)}</FormError>
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
        <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Saving creates a new versioned commission row; historical versions are
          preserved for audit.
        </p>
      </div>
    </Modal>
  );
}
