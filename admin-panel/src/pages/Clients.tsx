import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Copy, KeyRound, Loader2, Plus, ShieldAlert, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import Badge from '@/components/Badge';
import DataTable, { type Column } from '@/components/DataTable';
import FormError, { FieldError, FormNote } from '@/components/FormError';
import Modal from '@/components/Modal';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import { useAuth } from '@/context/AuthContext';
import { apiErrorMessage, createClient, listClients, updateClient } from '@/lib/api';
import { formatDate, formatUsdt, shortHash } from '@/lib/format';
import type { Client, ClientAction, CreateClientInput } from '@/types';

/**
 * THE MERCHANT ROLL — a ledger on its own surface.
 *
 * Every column earns its place: who they are, how they got here, whether they
 * can trade, and how much they have put through. The source filter is a request
 * to the SERVER, and the page says so, because "no clients match" means two
 * different things depending on which.
 *
 * THE MOBILE ROW CARRIES THE ACTIONS, and that is the reason this file was
 * touched at all. The desktop ledger is `hidden md:block`, so the Approve /
 * Suspend / Regenerate-keys column simply did not exist below `md` — an operator
 * away from their desk could read the roll and could not approve a merchant,
 * suspend one, or rotate a leaked key. That is functional loss rather than a
 * layout complaint, and it lands on the three verbs this console exists to
 * perform. Both layouts now render the SAME `ClientActions` component, so they
 * cannot drift apart again.
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
    queryFn: () => listClients(sourceFilter === 'all' ? undefined : { signupSource: sourceFilter }),
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

  /** One place both layouts get their verbs from. */
  const actionsFor = (c: Client) => (
    <ClientActions
      client={c}
      canAct={isSuper}
      pending={mutate.isPending}
      onAction={(action) => mutate.mutate({ id: c.id, action })}
    />
  );

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
      // `dot` is explicit now that Badge defaults it off: this is a row-level
      // status readout, which is exactly the case the lit mark exists for — and
      // a merchant still awaiting verification pulses, which is how an operator
      // finds the rows that are waiting on someone.
      render: (c) => <Badge status={c.status} dot />,
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
      render: (c) => actionsFor(c),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Merchants"
        title="Clients"
        description="Every merchant account on the gateway, however it got here."
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

      {/* THE SOURCE FILTER, ON A SURFACE.
          It was a row of ruled tabs printed straight onto the page, which is the
          gesture this redesign replaces everywhere — and a control floating on
          the bare canvas reads as unfinished next to the lit ledger below it.

          The selected source is a RAISED control and the rest are ghosts —
          the segmented-control idiom spelled in the control vocabulary this
          product already has, so both states inherit the 44px touch floor
          `.btn` enforces rather than the ~36px the hand-rolled tabs computed
          to. `aria-current` carries the same fact for anyone who cannot see
          which one is raised.

          Self-registered merchants are approved by verifying their email, so
          nothing here gates anyone going live — this is for review. Suspending
          from the row actions is still the kill switch. */}
      <div className="surface mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4">
        <span className="runhead shrink-0">Source</span>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['all', 'self', 'admin'] as const).map((value) => {
            const active = sourceFilter === value;
            return (
              <button
                key={value}
                type="button"
                aria-current={active ? 'true' : undefined}
                onClick={() => setSourceFilter(value)}
                className={
                  active ? 'btn-secondary px-3 text-xs font-semibold' : 'btn-ghost px-3 text-xs'
                }
              >
                {SOURCE_LABEL[value]}
              </button>
            );
          })}
        </div>
        <span className="ml-auto text-xs text-slate-500 dark:text-slate-400">
          Asked of the server
        </span>
      </div>

      {/* A failed action, in the form every other whole-block failure in this
          console takes: an inset well with the state ink on its left edge and a
          running head naming the failure. It used to be a hairline band printed
          on the canvas, which is the one idiom the redesign removes. */}
      {actionError && (
        <div className="mb-4">
          <FormError title="Action failed">{actionError}</FormError>
        </div>
      )}

      <Section flush title="Merchant accounts">
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
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSourceFilter('all')}
              >
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
          // `dvh`, never `vh`: on mobile Safari `vh` measures the viewport
          // WITHOUT the collapsing toolbar, so a 70vh cap is taller than 70% of
          // what the operator can actually see.
          maxHeight="70dvh"
          skeletonRows={8}
          pageSize={12}
          renderMobile={(c) => (
            <div>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-slate-900 dark:text-slate-50">{c.name}</p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{c.email}</p>
                </div>
                <div className="min-w-0 break-words text-right">
                  <p className="num text-sm font-medium text-slate-900 dark:text-slate-50">
                    {formatUsdt(c.volume)} USDT
                  </p>
                  <span className="mt-1 flex justify-end">
                    <Badge status={c.status} dot />
                  </span>
                </div>
              </div>
              {/* The verbs, on the row rather than only in the desktop table.
                  Full-size controls: this is a thumb, and approving or
                  suspending a merchant is the wrong place to save 6px. */}
              {actionsFor(c)}
            </div>
          )}
        />
      </Section>

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
 * THE THREE OPERATOR VERBS, rendered identically in the ledger cell and in the
 * stacked mobile row.
 *
 * ONE COMPONENT FOR BOTH LAYOUTS is the whole point. The mobile row used to be a
 * hand-written subset of the desktop row and it silently dropped every control,
 * which is how a phone ended up able to read the merchant roll and unable to act
 * on it. A second copy of these buttons would be free to lose one again.
 *
 * NO PADDING OVERRIDE. These were `!px-2 !py-1 text-xs`, which forced them under
 * the touch floor back when `.btn` carried no `min-height`; the class enforces
 * 44px below `sm` and 38px above it now, so only the horizontal padding is
 * trimmed — three verbs have to fit one ledger cell — and the height is left to
 * the primitive.
 *
 * THE ROW NAVIGATES AND THESE ACT, so the wrapper stops the click. Without it,
 * approving a merchant also opened their record.
 *
 * Regenerating keys is destructive in the way that matters here — every live
 * integration the merchant runs stops working the moment it succeeds — but it is
 * not painted `.btn-danger`, because it sits beside Suspend in a row an operator
 * scans, and two red controls in one cell is a colour that has stopped meaning
 * anything. The confirmation is the sheet that follows it.
 */
function ClientActions({
  client,
  canAct,
  pending,
  onAction,
}: {
  client: Client;
  canAct: boolean;
  pending: boolean;
  onAction: (action: Extract<ClientAction, 'approve' | 'suspend' | 'regenerate_keys'>) => void;
}) {
  return (
    <div
      className="mt-3 flex flex-wrap justify-end gap-1.5 md:mt-0"
      onClick={(e) => e.stopPropagation()}
    >
      {client.status !== 'active' && (
        <button
          type="button"
          className="btn-secondary px-2.5 text-xs"
          disabled={!canAct || pending}
          title={canAct ? 'Approve client' : 'Requires super admin'}
          onClick={() => onAction('approve')}
        >
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Approve
        </button>
      )}
      {client.status === 'active' && (
        <button
          type="button"
          className="btn-secondary px-2.5 text-xs"
          disabled={!canAct || pending}
          title={canAct ? 'Suspend client' : 'Requires super admin'}
          onClick={() => onAction('suspend')}
        >
          <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Suspend
        </button>
      )}
      <button
        type="button"
        className="btn-secondary px-2.5 text-xs"
        disabled={!canAct || pending}
        title={canAct ? 'Regenerate API keys' : 'Requires super admin'}
        onClick={() => onAction('regenerate_keys')}
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden /> Keys
      </button>
    </div>
  );
}

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
              mutation.mutate({
                ...v,
                password: v.password?.trim() ? v.password : undefined,
              }),
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
          <label className="label" htmlFor="new-client-name">
            Business name
          </label>
          <input
            id="new-client-name"
            className="input"
            placeholder="Acme Corp"
            {...register('name', { required: 'Required' })}
          />
          {errors.name && <FieldError>{errors.name.message}</FieldError>}
        </div>
        <div>
          <label className="label" htmlFor="new-client-email">
            Email
          </label>
          <input
            id="new-client-email"
            type="email"
            className="input"
            placeholder="ops@acme.com"
            {...register('email', { required: 'Required' })}
          />
          {errors.email && <FieldError>{errors.email.message}</FieldError>}
        </div>
        <div>
          <label className="label" htmlFor="new-client-webhook">
            Webhook URL (optional)
          </label>
          <input
            id="new-client-webhook"
            className="input"
            placeholder="https://acme.com/webhooks/gateway"
            {...register('webhookUrl')}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-client-bep20">
            BEP20 payout wallet (optional)
          </label>
          {/* No `text-xs` on the field. `.input` sets 16px below `sm` on purpose
              — iOS Safari zooms the viewport on any focused control under that
              and does not zoom back — and a utility here would win the cascade
              and put the zoom straight back on an address field. `font-mono`
              alone is what this needed. */}
          <input
            id="new-client-bep20"
            className="input font-mono"
            placeholder="0x…"
            {...register('payoutWallet')}
          />
        </div>
        <div>
          <label className="label" htmlFor="new-client-trc20">
            TRC20 payout wallet (optional)
          </label>
          <input
            id="new-client-trc20"
            className="input font-mono"
            placeholder="T…"
            {...register('payoutWalletTrc20')}
          />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Tron (T…) address — never a 0x address. Leave blank if this merchant does not take TRC20
            payments.
          </p>
        </div>
        <div>
          <label className="label" htmlFor="new-client-password">
            Password (optional)
          </label>
          <input
            id="new-client-password"
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
        {/* Amber, because this is waiting on the operator to do something, and it
            stops being true the moment they do. The WORD carries it. This was a
            hand-rolled left rule; `FormNote` is the same statement in the shape
            every other note in the console takes. */}
        <FormNote title="Shown once" tone="waiting">
          Save these credentials now. The API secret
          {client.temporaryPassword ? ' and temporary password are' : ' is'} shown only once and
          cannot be retrieved again.
        </FormNote>

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

/**
 * One secret, its label, and the one thing you can do with it.
 *
 * `break-all` RATHER THAN `overflow-x-auto`, which is what this used to do. A
 * scrolling `<code>` is technically contained and hands the operator a 3px-tall
 * horizontal scrollbar to drag a 64-character secret through, inside a sheet on
 * a phone — and the value is only ever shown once, so a character they never
 * scrolled to is a character they never had. Wrapping is the correct treatment
 * for every unbreakable string in this product.
 *
 * The `.well` is the sanctioned inset surface: one step off the sheet, no rim
 * light, because light does not catch on the top edge of a hole.
 */
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
      <div className="mt-1.5 flex items-start gap-2">
        <code className="well block min-w-0 flex-1 break-all px-3 py-2 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200">
          {value}
        </code>
        {/* Square and at the touch floor: an icon-only control has no text to
            widen it, so the width has to be stated. */}
        <button
          type="button"
          className="btn-secondary w-11 shrink-0 px-0 sm:w-10"
          onClick={onCopy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          <Copy className="h-4 w-4" aria-hidden />
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
