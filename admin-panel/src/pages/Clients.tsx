import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  ShieldAlert,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import FormError, { FieldError } from '@/components/FormError';
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

/**
 * THE MERCHANT ROLL — set as a ledger on the page.
 *
 * Every column earns its place: who they are, how they got here, whether they
 * can trade, and how much they have put through. The source filter is a request
 * to the SERVER, and the page says so, because "no clients match" means two
 * different things depending on which.
 */
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

  const { data, isLoading, isError, error, refetch } = useQuery({
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
      key: 'signupSource',
      header: 'Source',
      hideOnMobile: true,
      sortValue: (c) => c.signupSource ?? 'admin',
      render: (c) => <SignupSource client={c} />,
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
      hideOnMobile: true,
      render: (c) => <code className="code">{shortHash(c.apiKey, 8, 4)}</code>,
    },
    {
      key: 'volume',
      header: 'Volume',
      numeric: true,
      sortValue: (c) => Number(c.volume ?? 0),
      render: (c) => (
        <span className="font-medium text-slate-900 dark:text-slate-100">
          {formatUsdt(c.volume)}
          <span className="font-normal text-slate-500 dark:text-slate-400"> USDT</span>
        </span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      hideOnMobile: true,
      sortValue: (c) => c.createdAt,
      render: (c) => (
        <span className="whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDate(c.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (c) => (
        // The row navigates to the client; these do something to it. Without the
        // stop, approving a merchant also opened their record.
        <div className="flex justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
          {c.status !== 'active' && (
            <button
              type="button"
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
              type="button"
              className="btn-secondary !px-2 !py-1 text-xs"
              disabled={!isSuper || mutate.isPending}
              title={isSuper ? 'Suspend client' : 'Requires super admin'}
              onClick={() => mutate.mutate({ id: c.id, action: 'suspend' })}
            >
              <ShieldAlert className="h-3.5 w-3.5" /> Suspend
            </button>
          )}
          <button
            type="button"
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
        eyebrow="Merchants"
        title="Clients"
        subtitle="Every merchant account on the gateway, however it got here."
        actions={
          isSuper ? (
            <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" /> New client
            </button>
          ) : (
            <span className="runhead">Read-only · ops role</span>
          )
        }
        meta={
          isLoading
            ? undefined
            : `${rows.length.toLocaleString()} client${rows.length === 1 ? '' : 's'}${
                sourceFilter === 'all' ? '' : ` · ${SOURCE_LABEL[sourceFilter]}`
              }`
        }
      />

      {/* The source filter, set as ruled tabs rather than a pill group.
          Self-registered merchants are approved by verifying their email, so
          nothing here gates anyone going live — this is for review. Suspending
          from the row actions is still the kill switch.

          Brand on the active underline is the sanctioned decorative use: it is
          drawn on something you can genuinely click, and `aria-current` carries
          the same fact for anyone who cannot see it. */}
      <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-slate-200 pb-2 dark:border-slate-800">
        {(['all', 'self', 'admin'] as const).map((value) => {
          const active = sourceFilter === value;
          return (
            <button
              key={value}
              type="button"
              aria-current={active ? 'true' : undefined}
              onClick={() => setSourceFilter(value)}
              className={`-mb-2.5 border-b-2 pb-2 text-sm outline-none transition-colors duration-[var(--dur-press)] focus-visible:ring-2 focus-visible:ring-brand-500 ${
                active
                  ? 'border-brand-600 font-medium text-slate-900 dark:border-brand-400 dark:text-slate-50'
                  : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
              }`}
            >
              {SOURCE_LABEL[value]}
            </button>
          );
        })}
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          Asked of the server
        </span>
      </div>

      {actionError && (
        <div className="rule mb-5 pt-3">
          <span className="runhead text-red-600 dark:text-red-400">Action failed</span>
          <p className="measure mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            {actionError}
          </p>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id}
        loading={isLoading}
        error={isError ? apiErrorMessage(error) : null}
        onRetry={() => refetch()}
        emptyMessage={
          sourceFilter === 'all'
            ? 'No clients onboarded yet.'
            : `No ${SOURCE_LABEL[sourceFilter].toLowerCase()} clients.`
        }
        emptyHint={
          sourceFilter === 'all'
            ? 'A merchant appears here as soon as they register through the public panel, or when you create one.'
            : 'The source filter is asked of the server — clear it to see every account.'
        }
        emptyAction={
          sourceFilter !== 'all' ? (
            <button type="button" className="btn-secondary" onClick={() => setSourceFilter('all')}>
              Show all clients
            </button>
          ) : isSuper ? (
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(true)}>
              Onboard a client
            </button>
          ) : undefined
        }
        onRowClick={(c) => navigate(`/clients/${c.id}`)}
        label="Clients"
        maxHeight="70vh"
        skeletonRows={8}
        pageSize={12}
        renderMobile={(c) => (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate font-medium text-slate-900 dark:text-slate-50">{c.name}</p>
              <p className="truncate text-xs text-slate-500 dark:text-slate-400">{c.email}</p>
            </div>
            <div className="shrink-0 text-right">
              <p className="num text-sm font-medium text-slate-900 dark:text-slate-50">
                {formatUsdt(c.volume)} USDT
              </p>
              <span className="mt-1 flex justify-end">
                <Badge status={c.status} />
              </span>
            </div>
          </div>
        )}
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

const SOURCE_LABEL: Record<'all' | 'self' | 'admin', string> = {
  all: 'All',
  self: 'Self-registered',
  admin: 'Operator-created',
};

/**
 * How the merchant got here, as words rather than as a brand-tinted chip.
 *
 * The chip was painted in the brand hue on a row you cannot click, which spends
 * the one colour reserved for actions on a fact. An UNVERIFIED self-registration
 * is the only part of this that anyone needs to act on, so that is the only part
 * that takes an ink — amber, because it is waiting on the merchant.
 */
function SignupSource({ client }: { client: Client }) {
  if (client.signupSource !== 'self') {
    return <span className="text-slate-500 dark:text-slate-400">Operator</span>;
  }
  return (
    <span className="whitespace-nowrap">
      <span className="font-medium text-slate-800 dark:text-slate-200">Self</span>
      {client.emailVerified ? (
        <span className="text-slate-500 dark:text-slate-400"> · email verified</span>
      ) : (
        <span className="font-medium text-amber-600 dark:text-amber-400">
          {' '}
          · email not verified
        </span>
      )}
    </span>
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
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={mutation.isPending}
            onClick={handleSubmit((v) =>
              mutation.mutate({ ...v, password: v.password?.trim() ? v.password : undefined })
            )}
          >
            {mutation.isPending ? (
              <Loader2 className="motion-keep h-4 w-4 animate-spin" />
            ) : (
              <UserPlus className="h-4 w-4" />
            )}
            Create
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <FormError>{error}</FormError>}
        <div>
          <label className="label">Business name</label>
          <input className="input" placeholder="Acme Corp" {...register('name', { required: 'Required' })} />
          {errors.name && <FieldError>{errors.name.message}</FieldError>}
        </div>
        <div>
          <label className="label">Email</label>
          <input
            type="email"
            className="input"
            placeholder="ops@acme.com"
            {...register('email', { required: 'Required' })}
          />
          {errors.email && <FieldError>{errors.email.message}</FieldError>}
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
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
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
        <button type="button" className="btn-primary" onClick={onClose}>
          I've saved it
        </button>
      }
    >
      <div className="space-y-5">
        {/* Amber, because this is waiting on the operator to do something, and
            it stops being true the moment they do. The WORD carries it. */}
        <div className="border-l-2 border-amber-600 pl-3 dark:border-amber-400">
          <span className="runhead text-amber-600 dark:text-amber-400">Shown once</span>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            Save these credentials now. The API secret
            {client.temporaryPassword ? ' and temporary password are' : ' is'} shown
            only once and cannot be retrieved again.
          </p>
        </div>

        <Credential
          label="API key"
          value={client.apiKey}
          copied={copiedField === 'apiKey'}
          onCopy={() => copy('apiKey', client.apiKey)}
        />
        {client.apiSecret && (
          <Credential
            label="API secret"
            value={client.apiSecret}
            copied={copiedField === 'apiSecret'}
            onCopy={() => copy('apiSecret', client.apiSecret)}
          />
        )}
        {client.temporaryPassword && (
          <Credential
            label="Temporary password"
            value={client.temporaryPassword}
            copied={copiedField === 'temporaryPassword'}
            onCopy={() => copy('temporaryPassword', client.temporaryPassword)}
          />
        )}
      </div>
    </Modal>
  );
}

/** One secret, its label, and the one thing you can do with it. */
function Credential({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <span className="runhead">{label}</span>
      <div className="mt-1.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto rounded bg-slate-100 px-3 py-2 font-mono text-xs text-slate-800 dark:bg-slate-800 dark:text-slate-200">
          {value}
        </code>
        <button
          type="button"
          className="btn-secondary shrink-0 !px-2"
          onClick={onCopy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>
      {/* Emerald: it worked. `role="status"` so the confirmation is announced
          rather than only seen. */}
      {copied && (
        <p role="status" className="mt-1 text-xs text-emerald-600 dark:text-emerald-400">
          Copied to clipboard.
        </p>
      )}
    </div>
  );
}

