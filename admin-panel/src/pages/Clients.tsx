import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldAlert,
  UserPlus,
  MailCheck,
  MailWarning,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import { useAuth } from '@/context/AuthContext';
import {
  apiErrorMessage,
  createClient,
  listClients,
  updateClient,
} from '@/lib/api';
import { formatDate, formatUsdt, shortHash } from '@/lib/format';
import type { Client, CreateClientInput } from '@/types';

export default function Clients() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { role } = useAuth();
  const isSuper = role === 'super_admin';

  // Self-registered merchants arrive already active, so there is no approval
  // queue to work. This filter is how an operator reviews who has signed up.
  const [sourceFilter, setSourceFilter] = useState<'all' | 'self' | 'admin'>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [secretModal, setSecretModal] = useState<{ client: Client } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['clients', sourceFilter],
    queryFn: () =>
      listClients(sourceFilter === 'all' ? undefined : { signupSource: sourceFilter }),
  });

  const mutate = useMutation({
    mutationFn: (vars: { id: string; action: 'approve' | 'suspend' | 'regenerate_keys' }) =>
      updateClient(vars.id, { action: vars.action }),
    onError: (e) => setActionError(apiErrorMessage(e)),
    onSuccess: (updated, vars) => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ['clients'] });
      // Secret is only returned once, right after regeneration — surface it.
      if (vars.action === 'regenerate_keys' && updated?.apiSecret) {
        setSecretModal({ client: updated });
      }
    },
  });

  const columns: Column<Client>[] = [
    {
      key: 'name',
      header: 'Client',
      sortValue: (c) => c.name.toLowerCase(),
      render: (c) => (
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="text-xs text-gray-500 dark:text-gray-400">{c.email}</p>
        </div>
      ),
    },
    {
      key: 'signupSource',
      header: 'Source',
      sortValue: (c) => c.signupSource ?? 'admin',
      render: (c) =>
        c.signupSource === 'self' ? (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 text-xs font-medium text-brand-700 dark:bg-brand-900/30 dark:text-brand-300"
            title={
              c.emailVerified
                ? 'Registered through the public panel; email verified'
                : 'Registered through the public panel; email NOT yet verified'
            }
          >
            {c.emailVerified ? <MailCheck size={11} /> : <MailWarning size={11} />}
            Self
          </span>
        ) : (
          <span className="text-xs text-gray-500 dark:text-gray-400">Operator</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (c) => c.status,
      render: (c) => <Badge status={c.status} />,
    },
    {
      key: 'apiKey',
      header: 'API key',
      render: (c) => (
        <code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs dark:bg-gray-800">
          {shortHash(c.apiKey, 8, 4)}
        </code>
      ),
    },
    {
      key: 'volume',
      header: 'Volume',
      align: 'right',
      sortValue: (c) => Number(c.volume ?? 0),
      render: (c) => <span className="tabular-nums">{formatUsdt(c.volume)} USDT</span>,
    },
    {
      key: 'createdAt',
      header: 'Created',
      sortValue: (c) => c.createdAt,
      render: (c) => <span className="text-xs text-gray-500">{formatDate(c.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (c) => (
        <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {c.status !== 'active' && (
            <button
              className="btn-secondary !px-2 !py-1 text-xs"
              disabled={!isSuper || mutate.isPending}
              title={isSuper ? 'Approve client' : 'Requires super admin'}
              onClick={() => mutate.mutate({ id: c.id, action: 'approve' })}
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve
            </button>
          )}
          {c.status === 'active' && (
            <button
              className="btn-secondary !px-2 !py-1 text-xs"
              disabled={!isSuper || mutate.isPending}
              title={isSuper ? 'Suspend client' : 'Requires super admin'}
              onClick={() => mutate.mutate({ id: c.id, action: 'suspend' })}
            >
              <ShieldAlert className="h-3.5 w-3.5" /> Suspend
            </button>
          )}
          <button
            className="btn-secondary !px-2 !py-1 text-xs"
            disabled={!isSuper || mutate.isPending}
            title={isSuper ? 'Regenerate API keys' : 'Requires super admin'}
            onClick={() => mutate.mutate({ id: c.id, action: 'regenerate_keys' })}
          >
            <KeyRound className="h-3.5 w-3.5" /> Keys
          </button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Clients"
        subtitle="Onboard and manage merchant accounts"
        actions={
          isSuper ? (
            <div className="flex items-center gap-2">
              {/* Self-registered merchants are approved by email verification, so
                  nothing here blocks them going live — this is for review, not
                  gating. Suspending from the row actions is still the kill switch. */}
              <div className="flex rounded-lg border border-gray-200 p-0.5 dark:border-gray-700">
                {([
                  ['all', 'All'],
                  ['self', 'Self-registered'],
                  ['admin', 'Operator'],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setSourceFilter(value)}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                      sourceFilter === value
                        ? 'bg-brand-600 text-white'
                        : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button className="btn-primary" onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" /> New client
              </button>
            </div>
          ) : (
            <span className="text-xs text-gray-400">Read-only (ops role)</span>
          )
        }
      />

      {actionError && (
        <div className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          {actionError}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={data?.data ?? []}
        rowKey={(c) => c.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        emptyMessage="No clients onboarded yet."
        onRowClick={(c) => navigate(`/clients/${c.id}`)}
        pageSize={12}
      />

      <CreateClientModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(client) => {
          setCreateOpen(false);
          qc.invalidateQueries({ queryKey: ['clients'] });
          if (client.apiSecret || client.temporaryPassword) setSecretModal({ client });
        }}
      />

      <SecretModal client={secretModal?.client ?? null} onClose={() => setSecretModal(null)} />
    </>
  );
}

// ---------------------------------------------------------------------------
function CreateClientModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (client: Client) => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateClientInput>();
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (input: CreateClientInput) => createClient(input),
    onError: (e) => setError(apiErrorMessage(e)),
    onSuccess: (client) => {
      reset();
      setError(null);
      onCreated(client);
    },
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Onboard new client"
      footer={
        <>
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={mutation.isPending}
            onClick={handleSubmit((v) =>
              mutation.mutate({ ...v, password: v.password?.trim() ? v.password : undefined })
            )}
          >
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
            Create
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            {error}
          </div>
        )}
        <div>
          <label className="label">Business name</label>
          <input className="input" placeholder="Acme Corp" {...register('name', { required: 'Required' })} />
          {errors.name && <p className="mt-1 text-xs text-red-600">{errors.name.message}</p>}
        </div>
        <div>
          <label className="label">Email</label>
          <input
            type="email"
            className="input"
            placeholder="ops@acme.com"
            {...register('email', { required: 'Required' })}
          />
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>
        <div>
          <label className="label">Webhook URL (optional)</label>
          <input className="input" placeholder="https://acme.com/webhooks/gateway" {...register('webhookUrl')} />
        </div>
        <div>
          <label className="label">BEP20 payout wallet (optional)</label>
          <input className="input font-mono text-xs" placeholder="0x…" {...register('payoutWallet')} />
        </div>
        <div>
          <label className="label">TRC20 payout wallet (optional)</label>
          <input
            className="input font-mono text-xs"
            placeholder="T…"
            {...register('payoutWalletTrc20')}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Tron (T…) address — never a 0x address. Leave blank if this merchant
            does not take TRC20 payments.
          </p>
        </div>
        <div>
          <label className="label">Password (optional)</label>
          <input
            type="password"
            className="input"
            placeholder="••••••••"
            autoComplete="new-password"
            {...register('password')}
          />
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Leave blank to auto-generate a temporary password.
          </p>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
export function SecretModal({ client, onClose }: { client: Client | null; onClose: () => void }) {
  const [copiedField, setCopiedField] = useState<string | null>(null);
  if (!client) return null;

  const copy = async (field: string, value?: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <Modal
      open={!!client}
      onClose={onClose}
      title="API credentials"
      footer={
        <button className="btn-primary" onClick={onClose}>
          I've saved it
        </button>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <strong>Save these credentials now.</strong> The API secret
          {client.temporaryPassword ? ' and temporary password are' : ' is'} shown only once and
          cannot be retrieved again.
        </div>

        <div>
          <label className="label">API key</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded-lg bg-gray-100 px-3 py-2 text-xs dark:bg-gray-800">
              {client.apiKey}
            </code>
            <button className="btn-secondary !px-2" onClick={() => copy('apiKey', client.apiKey)}>
              <Copy className="h-4 w-4" />
            </button>
          </div>
          {copiedField === 'apiKey' && <p className="mt-1 text-xs text-brand-600">Copied to clipboard.</p>}
        </div>

        {client.apiSecret && (
          <div>
            <label className="label">API secret</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-gray-100 px-3 py-2 text-xs dark:bg-gray-800">
                {client.apiSecret}
              </code>
              <button className="btn-secondary !px-2" onClick={() => copy('apiSecret', client.apiSecret)}>
                <Copy className="h-4 w-4" />
              </button>
            </div>
            {copiedField === 'apiSecret' && (
              <p className="mt-1 text-xs text-brand-600">Copied to clipboard.</p>
            )}
          </div>
        )}

        {client.temporaryPassword && (
          <div>
            <label className="label">Temporary password</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-lg bg-gray-100 px-3 py-2 text-xs dark:bg-gray-800">
                {client.temporaryPassword}
              </code>
              <button
                className="btn-secondary !px-2"
                onClick={() => copy('temporaryPassword', client.temporaryPassword)}
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
            {copiedField === 'temporaryPassword' && (
              <p className="mt-1 text-xs text-brand-600">Copied to clipboard.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
