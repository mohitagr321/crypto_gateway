import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  KeyRound,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  createApiKey,
  errorMessage,
  getSettings,
  listApiKeys,
  regenerateApiKeys,
  revokeApiKey,
} from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { ApiKeyAuthMode, ApiKeySummary, CreatedApiKey } from '@/types';
import PageHeader from '@/components/PageHeader';
import DataTable, { type Column } from '@/components/DataTable';
import CopyButton from '@/components/CopyButton';
import CodeBlock from '@/components/CodeBlock';
import Modal from '@/components/Modal';
import Section from '@/components/Section';
import Spinner from '@/components/Spinner';

/**
 * Multi-key management.
 *
 * Two things here are load-bearing rather than decorative, and neither was
 * touched by the redesign:
 *  1. The one-time secret modal is not dismissable by clicking away — a merchant
 *     who loses the secret has to revoke and re-issue, so closing must be a
 *     deliberate "I have saved it".
 *  2. The mode picker states the payout consequence up front. Bearer keys are
 *     the easy choice, and someone picking one should know before they create it
 *     that it cannot move funds — not discover it from a 403 in production.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE REDESIGN CHANGED, AND WHAT IT DELIBERATELY DID NOT
 *
 * The page is now built from lit surfaces rather than from ruled bands: the
 * ledger of keys, the compromise block and the exposure warning each sit on
 * their own `.surface`, and the page is the space between them. Nothing about
 * what any of them SAYS changed.
 *
 * THE WARNINGS GOT LOUDER, NOT QUIETER, and that was the constraint the
 * conversion was held to. The bearer-without-allowlist notice used to be ink on
 * the bare canvas between two rules; it is now a surface of its own, above the
 * ledger, carrying the same amber ink, the same icon and the same words. A
 * warning that survives a redesign by being visually demoted has not survived
 * it.
 *
 * BRAND IS ABSENT FROM STATE. The "Signed" mode marker is an icon, a word and a
 * neutral ink — never a brand pill, because brand means "you can act on this"
 * and an attribute of a credential is not something you press. Amber is
 * reserved for the weaker posture.
 *
 * THE SECRET IS THE POINT OF THIS PAGE. It exists for exactly one render and
 * never again, so in the one-time dialog it is the heaviest thing on screen: set
 * in a `.well` at reading size in mono, broken at any character so no part of it
 * can be scrolled out of sight, and copied by a full-width control rather than
 * an icon tucked in a corner. That is the same treatment the hosted checkout
 * gives a deposit address, for the same reason — it is the one string that must
 * not be misread or missed.
 */
export default function ApiKeys() {
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeySummary | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenConfirm, setRegenConfirm] = useState('');

  const [label, setLabel] = useState('');
  const [authMode, setAuthMode] = useState<ApiKeyAuthMode>('hmac');

  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => listApiKeys() });
  const settings = useQuery({ queryKey: ['settings'], queryFn: getSettings });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    queryClient.invalidateQueries({ queryKey: ['onboarding'] });
  };

  const create = useMutation({
    mutationFn: () =>
      createApiKey({ label: label.trim() || 'default', authMode }),
    onSuccess: (data) => {
      setCreated(data);
      setCreateOpen(false);
      setLabel('');
      setAuthMode('hmac');
      invalidate();
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id),
    onSuccess: () => {
      setRevoking(null);
      invalidate();
    },
  });

  /**
   * The compromise button. This is NOT "roll one key" — the endpoint revokes
   * EVERY active key on the account and issues a single new HMAC key, which is
   * what you want when you do not know which credential leaked and cannot
   * afford to guess. It is deliberately separated from the per-key revoke
   * above, gated behind typing the confirmation phrase, and never the default
   * path for ordinary rotation (create a new key, migrate, revoke the old one).
   */
  const regenerate = useMutation({
    mutationFn: () => regenerateApiKeys(),
    onSuccess: (data) => {
      // Reuse the one-time secret modal: the new secret is shown exactly once
      // here and never again, same as a freshly created key.
      setCreated({
        id: '',
        apiKey: data.apiKey,
        apiSecret: data.apiSecret,
        // The endpoint always issues an HMAC key with the full default scopes;
        // it has no mode or scope parameter. See routes/account.ts.
        authMode: 'hmac',
        scopes: [],
        createdAt: data.createdAt,
      });
      setRegenOpen(false);
      setRegenConfirm('');
      invalidate();
    },
  });

  const rows = keys.data ?? [];
  const bearerCount = rows.filter((k) => k.authMode === 'simple').length;
  const hasBearerKey = bearerCount > 0;
  const noIpAllowlist = (settings.data?.ipWhitelist ?? []).length === 0;

  const columns: Column<ApiKeySummary>[] = [
    {
      key: 'key',
      header: 'Key',
      sortValue: (k) => k.label ?? k.apiKey,
      render: (k) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {/* `break-all`, NOT `whitespace-nowrap`. A public key id is a long
                unbreakable string, and refusing to break it is what sets the
                ledger's minimum width — it dragged the whole table sideways on
                anything narrow, to protect a line break nobody minds. */}
            <code className="min-w-0 break-all font-mono text-[13px] text-slate-900 dark:text-slate-100">
              {k.apiKey}
            </code>
            {/* Bearer keys are shown as a masked prefix, so there is nothing
                copyable there — only the HMAC public id is a real value. */}
            {k.authMode === 'hmac' && <CopyButton value={k.apiKey} size={13} />}
          </div>
          {k.label && (
            <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
              {k.label}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'mode',
      header: 'Mode',
      sortValue: (k) => k.authMode,
      render: (k) => <AuthModeMark mode={k.authMode} />,
    },
    {
      key: 'scopes',
      header: 'Scopes',
      hideOnMobile: true,
      render: (k) => (
        // Plain mono ranged down the column, not three grey chips per row: a
        // scope is a literal you may need to type, and a box around each one
        // just fights the hairlines. Allowed to wrap for the same reason the
        // key id is allowed to break — a scope list is the second-widest thing
        // in this table and nothing is lost by setting it on two lines.
        <span className="block break-words font-mono text-[11px] text-slate-500 dark:text-slate-400">
          {k.scopes.length > 0 ? k.scopes.join('  ·  ') : '—'}
        </span>
      ),
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      hideOnMobile: true,
      // Never-used sorts to the bottom of a descending sort, which is where a
      // key nobody has called belongs when you are looking for dead credentials.
      sortValue: (k) => k.lastUsedAt ?? '',
      render: (k) =>
        k.lastUsedAt ? (
          <span className="num whitespace-nowrap">{formatDate(k.lastUsedAt)}</span>
        ) : (
          <span className="text-slate-500 dark:text-slate-400">Never</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      hideOnMobile: true,
      sortValue: (k) => k.createdAt,
      render: (k) => (
        <span className="num whitespace-nowrap text-slate-500 dark:text-slate-400">
          {formatDate(k.createdAt)}
        </span>
      ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (k) => (
        // 44px square, not a 28px `p-1.5` glyph. This is the control that takes
        // a credential out of service, it is the only control in the row, and
        // the rows are tall enough to hold a real target without growing — so
        // there was never anything bought by making it thumb-sized-adjacent.
        <button
          type="button"
          className="-my-1 inline-grid h-11 w-11 place-items-center rounded-lg text-slate-500 outline-none transition-colors duration-[var(--dur-press)] hover:bg-[var(--hover)] hover:text-red-600 focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-slate-400 dark:hover:text-red-400"
          onClick={() => setRevoking(k)}
          aria-label={`Revoke key ${k.apiKey}`}
        >
          <Trash2 size={16} aria-hidden />
        </button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Developers"
        title="API Keys"
        description="Credentials your server uses to talk to the gateway. Give each integration its own key, so you can revoke one without taking the rest down."
        meta={
          keys.data
            ? `${rows.length} ${rows.length === 1 ? 'key' : 'keys'}${
                bearerCount > 0 ? ` · ${bearerCount} bearer` : ''
              }`
            : undefined
        }
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} aria-hidden /> New key
          </button>
        }
      />

      {/* THE EXPOSURE NOTICE.
          On its own surface, above the ledger — it used to be ink on the bare
          canvas, which on a page now made of lit surfaces would have read as
          the least important thing on the screen rather than the most. Same
          words, same amber ink, same icon; only the standing changed, and it
          went up. */}
      {hasBearerKey && noIpAllowlist && (
        <div className="surface mb-4 flex gap-3 p-4">
          <ShieldAlert
            size={16}
            className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
            aria-hidden
          />
          <div className="min-w-0">
            <span className="runhead text-amber-600 dark:text-amber-400">
              Bearer key, no allowlist
            </span>
            <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
              A bearer token works from anywhere it leaks. Add your server's IP
              under{' '}
              <a href="/settings" className="link-ink font-medium">
                Settings
              </a>{' '}
              to contain that.
            </p>
          </div>
        </div>
      )}

      {/* `flush`: a ledger ranges to the edges of its own surface. */}
      <Section flush title="Issued keys">
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(k) => k.id}
          loading={keys.isLoading}
          error={keys.isError ? errorMessage(keys.error) : null}
          onRetry={() => keys.refetch()}
          label="API keys"
          skeletonRows={3}
          defaultSortKey="created"
          // Column one is the credential's identity, which is the thing you
          // scroll sideways to keep looking at.
          stickyFirstColumn
          emptyLabel="No API keys yet."
          emptyHint="Create one to start taking payments from your own server. The secret is shown once, at creation, and never again."
          emptyAction={
            <button className="btn-primary" onClick={() => setCreateOpen(true)}>
              <Plus size={16} aria-hidden /> Create your first key
            </button>
          }
          renderMobile={(k) => (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <code className="min-w-0 break-all font-mono text-[13px] text-slate-900 dark:text-slate-100">
                  {k.apiKey}
                </code>
                <AuthModeMark mode={k.authMode} />
              </div>
              {k.label && (
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {k.label}
                </span>
              )}
              <span className="break-words font-mono text-[11px] text-slate-500 dark:text-slate-400">
                {k.scopes.length > 0 ? k.scopes.join('  ·  ') : '—'}
              </span>
              <div className="flex items-center justify-between gap-3">
                <span className="num text-xs text-slate-500 dark:text-slate-400">
                  {k.lastUsedAt ? `Last used ${formatDate(k.lastUsedAt)}` : 'Never used'}
                </span>
                {/* A real 44px target rather than a 12px word: this is the one
                    destructive control on a phone row, and a thumb has to be
                    able to hit it deliberately — and to miss it deliberately. */}
                <button
                  type="button"
                  className="-mr-2 -my-2 inline-flex min-h-[44px] shrink-0 items-center rounded-lg px-2 text-xs font-medium text-red-600 outline-none transition-colors duration-[var(--dur-press)] focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-red-400"
                  onClick={() => setRevoking(k)}
                  aria-label={`Revoke key ${k.apiKey}`}
                >
                  Revoke
                </button>
              </div>
            </div>
          )}
        />
      </Section>

      {/* THE COMPROMISE BLOCK.
          Last on the page, on its own surface, opened by a red running head
          rather than wrapped in a red-tinted box — the ink says which register
          this block is in and the button says what it does. It was previously
          unreachable from the UI entirely: the endpoint existed and nothing
          called it, so a merchant with a leaked key of unknown identity had no
          way to shut the door. */}
      <Section
        className="mt-4"
        title={<span className="text-red-600 dark:text-red-400">Compromise</span>}
      >
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-50">
          Think a key has leaked?
        </h2>
        <p className="measure mt-2 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
          Revoke every active key at once and issue a single new HMAC-signed key.
          Your integrations will fail with 401 until you deploy the new
          credentials — that is the point.
        </p>
        <button className="btn-danger mt-5" onClick={() => setRegenOpen(true)}>
          Revoke all keys
        </button>
      </Section>

      {/* ---------------- Create ---------------- */}
      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create an API key"
        footer={
          <>
            <button
              className="btn-secondary"
              onClick={() => setCreateOpen(false)}
              disabled={create.isPending}
            >
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              {create.isPending ? <Spinner size={16} /> : 'Create key'}
            </button>
          </>
        }
      >
        <div className="space-y-6">
          <div>
            <label className="label" htmlFor="key-label">
              Label
            </label>
            <input
              id="key-label"
              className="input"
              placeholder="Production server"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
            />
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              So you know which integration to revoke later.
            </p>
          </div>

          <fieldset>
            <legend className="runhead">Authentication</legend>
            <div className="mt-3">
              <ModeOption
                selected={authMode === 'hmac'}
                onSelect={() => setAuthMode('hmac')}
                icon={ShieldCheck}
                title="HMAC-signed"
                badge="Recommended"
                body="A public id plus a secret that never leaves your server. Every request is signed. Required for payouts."
              />
              <ModeOption
                selected={authMode === 'simple'}
                onSelect={() => setAuthMode('simple')}
                icon={KeyRound}
                title="Bearer token"
                badge="Simplest"
                body="One token in X-Api-Key, no signing. Easier to integrate, but it travels on every request — so it cannot be granted payout permission."
              />
            </div>
          </fieldset>

          {/* The consequence of the weaker choice, stated at the moment it is
              made. On a `.well` rather than a hairline: inside a dialog the
              surrounding surface is already lit, so an inset is what reads as
              "this is a note about the choice above" — and it is more, not
              less, visible than the rule it replaces. */}
          {authMode === 'simple' && (
            <div className="well flex gap-3 p-3.5">
              <ShieldAlert
                size={15}
                className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden
              />
              <p className="measure text-xs leading-relaxed text-slate-700 dark:text-slate-300">
                This key will get <code className="code">payments:read</code> and{' '}
                <code className="code">payments:write</code> only. Add an IP allowlist
                in Settings so the token is useless from anywhere else.
              </p>
            </div>
          )}

          {create.isError && (
            <p className="text-sm text-red-600 dark:text-red-400">
              {errorMessage(create.error)}
            </p>
          )}
        </div>
      </Modal>

      {/* ---------------- One-time secret ----------------
          `lg` because this dialog carries the only render of a 64-character
          secret; a narrow sheet would wrap it three times and bury the copy
          control below the fold. */}
      <Modal
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        dismissable={false}
        size="lg"
        title="Save your API credentials"
        footer={
          <button className="btn-primary" onClick={() => setCreated(null)}>
            I have saved them
          </button>
        }
      >
        <div>
          <div className="flex gap-3">
            <AlertTriangle
              size={16}
              className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden
            />
            <div className="min-w-0">
              <span className="runhead text-amber-600 dark:text-amber-400">
                Shown once
              </span>
              <p className="measure mt-1.5 text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                This is the only time the secret is shown. Copy it into your secret
                manager now — if you lose it you will have to revoke this key and
                create another.
              </p>
            </div>
          </div>

          {created?.authMode === 'hmac' ? (
            <>
              <SecretRow label="API key · public id" value={created.apiKey} copyLabel="Copy key" />
              <SecretRow
                label="API secret"
                value={created.apiSecret}
                copyLabel="Copy secret"
                emphasis
              />
              <div className="mt-8">
                <span className="runhead">Request headers</span>
                <div className="mt-2.5">
                  <CodeBlock
                    tabs={[
                      {
                        label: 'Headers',
                        code: `X-Api-Key: ${created.apiKey}
X-Timestamp: <unix seconds>
X-Signature: hmac_sha256(apiSecret, timestamp + "." + rawBody)`,
                      },
                    ]}
                  />
                </div>
              </div>
            </>
          ) : (
            created && (
              <>
                <SecretRow
                  label="Bearer token"
                  value={created.apiSecret}
                  copyLabel="Copy token"
                  emphasis
                />
                <div className="mt-8">
                  <span className="runhead">Request headers</span>
                  <div className="mt-2.5">
                    <CodeBlock
                      tabs={[
                        {
                          label: 'Headers',
                          code: `X-Api-Key: ${created.apiSecret}`,
                        },
                      ]}
                    />
                  </div>
                </div>
              </>
            )
          )}
        </div>
      </Modal>

      {/* ---------------- Compromise / reset all ---------------- */}
      <Modal
        open={regenOpen}
        onClose={() => {
          setRegenOpen(false);
          setRegenConfirm('');
        }}
        title="Revoke every key and issue a new one?"
        footer={
          <>
            <button
              className="btn-secondary"
              onClick={() => {
                setRegenOpen(false);
                setRegenConfirm('');
              }}
              disabled={regenerate.isPending}
            >
              Cancel
            </button>
            <button
              className="btn-danger"
              onClick={() => regenerate.mutate()}
              // Typing the phrase is the guard. This revokes every credential
              // the account has, so a mis-click must not be able to do it.
              disabled={regenerate.isPending || regenConfirm.trim() !== 'REVOKE ALL'}
            >
              {regenerate.isPending ? <Spinner size={16} /> : 'Revoke all and reissue'}
            </button>
          </>
        }
      >
        <p className="measure text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          Use this if you think a key has leaked and you are not sure which one.
        </p>

        {/* The consequences, numbered and ruled — the same ordered list the
            public pages set their claims in. A merchant about to break every
            integration they run should be able to count what happens. */}
        <ul className="mt-5">
          {CONSEQUENCES.map((c, i) => (
            <li key={c.head} className="rule flex gap-4 py-3">
              <span className="runhead num w-6 shrink-0 pt-0.5">
                {String(i + 1).padStart(2, '0')}
              </span>
              <span className="measure text-sm leading-relaxed text-slate-700 dark:text-slate-300">
                <strong className="font-semibold text-slate-900 dark:text-slate-100">
                  {c.head}
                </strong>{' '}
                {c.body}
              </span>
            </li>
          ))}
        </ul>

        <p className="measure mt-5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
          For ordinary rotation, create a new key, move your integration across, then
          revoke the old one — no downtime.
        </p>

        <label className="label mt-6" htmlFor="regen-confirm">
          Type <code className="code">REVOKE ALL</code> to confirm
        </label>
        <input
          id="regen-confirm"
          className="input"
          value={regenConfirm}
          onChange={(e) => setRegenConfirm(e.target.value)}
          placeholder="REVOKE ALL"
          autoComplete="off"
        />

        {regenerate.isError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {errorMessage(regenerate.error)}
          </p>
        )}
      </Modal>

      {/* ---------------- Revoke ---------------- */}
      <Modal
        open={Boolean(revoking)}
        onClose={() => setRevoking(null)}
        title="Revoke this key?"
        footer={
          <>
            <button
              className="btn-secondary"
              onClick={() => setRevoking(null)}
              disabled={revoke.isPending}
            >
              Cancel
            </button>
            <button
              className="btn-danger"
              onClick={() => revoking && revoke.mutate(revoking.id)}
              disabled={revoke.isPending}
            >
              {revoke.isPending ? <Spinner size={16} /> : 'Revoke key'}
            </button>
          </>
        }
      >
        {/* WHICH key, quoted verbatim on an inset surface. A confirmation
            dialog that names the thing it is about in the same treatment the
            product uses for every other literal is how a merchant checks they
            are killing the credential they meant to. */}
        <div className="well p-3.5">
          <span className="runhead">Key</span>
          <code className="mt-1.5 block break-all font-mono text-sm text-slate-900 dark:text-slate-50">
            {revoking?.apiKey}
          </code>
        </div>
        <p className="measure mt-4 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
          It stops working immediately. Any integration still using it will start
          failing with 401. This cannot be undone.
        </p>
        {revoke.isError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">
            {errorMessage(revoke.error)}
          </p>
        )}
      </Modal>
    </>
  );
}

const CONSEQUENCES = [
  {
    head: 'Every active key is revoked immediately,',
    body: 'including bearer keys. Every integration you run will start failing with 401 until you deploy the new credentials.',
  },
  {
    head: 'One new HMAC-signed key is issued.',
    body: 'Its secret is shown once and never again.',
  },
  { head: 'This cannot be undone.', body: '' },
];

/**
 * The credential's auth mode, as an icon, a word and an ink — never a fill.
 *
 * `Signed` is neutral because it is the correct, unremarkable default; `Bearer`
 * takes amber because it is the posture that wants attention (it cannot hold
 * payout scope and it is only as safe as the network it travels on). Brand is
 * deliberately absent: this is an attribute of a key, not something you click.
 */
function AuthModeMark({ mode }: { mode: ApiKeyAuthMode }) {
  const signed = mode === 'hmac';
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.1em] ${
        signed
          ? 'text-slate-600 dark:text-slate-400'
          : 'text-amber-600 dark:text-amber-400'
      }`}
    >
      {signed ? (
        <ShieldCheck size={12} className="shrink-0" aria-hidden />
      ) : (
        <KeyRound size={12} className="shrink-0" aria-hidden />
      )}
      {signed ? 'Signed' : 'Bearer'}
    </span>
  );
}

/**
 * A choice in the mode picker, set as a ruled row.
 *
 * The selected row is marked by INK WEIGHT — its opening rule goes from the
 * hairline to slate-900 — rather than by a brand fill. Both rows carry a 2px
 * border at all times and only the colour changes, so selecting one cannot
 * shift the layout by a pixel. The radio itself is still the primary carrier,
 * as it is in every radio group ever built.
 *
 * The whole row is the label, so the target is the row rather than the 16px
 * dot: at `py-4` around three lines of content that is well over 44px, which is
 * the floor a radio in a sheet has to clear on a phone.
 */
function ModeOption({
  selected,
  onSelect,
  icon: Icon,
  title,
  badge,
  body,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: typeof KeyRound;
  title: string;
  badge: string;
  body: string;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-3 border-t-2 py-4 transition-colors duration-[var(--dur-press)] ${
        selected
          ? 'border-slate-900 dark:border-slate-100'
          : 'border-[var(--line)]'
      }`}
    >
      <input
        type="radio"
        name="authMode"
        className="mt-0.5 h-4 w-4 shrink-0 border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
        checked={selected}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Icon size={14} className="shrink-0 text-slate-500 dark:text-slate-400" aria-hidden />
          <span
            className={`text-sm ${
              selected
                ? 'font-semibold text-slate-900 dark:text-slate-50'
                : 'font-medium text-slate-700 dark:text-slate-300'
            }`}
          >
            {title}
          </span>
          <span className="runhead">{badge}</span>
        </span>
        <span className="measure mt-1.5 block text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          {body}
        </span>
      </span>
    </label>
  );
}

/**
 * One credential, in the dialog that shows it for the only time.
 *
 * BOTH ROWS SIT IN A `.well`, which is the inset surface — the one that reads
 * as a hole rather than a raised object, and therefore as a quoted literal
 * inside the dialog's own surface. `emphasis` is the secret itself: set at
 * reading size, opened by the ink rule above the well, and copied by a
 * full-width control rather than an icon in a corner.
 *
 * `break-all` on both is not cosmetic. A 64-character secret that does not
 * break either overflows its container or gets a horizontal scrollbar, and a
 * secret with a scrollbar is a secret somebody copies three quarters of.
 *
 * `!text-sm` and `!rounded-lg` carry the important modifier ON PURPOSE, and it
 * is not belt-and-braces. CopyButton composes `${className}` onto a base that
 * already sets `text-xs` and `rounded-md`, and appending a class to a string
 * does not win a cascade — same specificity means the utility emitted LATER in
 * the stylesheet wins, and Tailwind emits `.text-xs` after `.text-sm` and
 * `.rounded-md` after `.rounded-lg`. I checked the compiled bundle rather than
 * assuming: without the bang, the label on the one control that must not be
 * missed renders at 12px, not 14px. The `!` escape hatch on this component is
 * already the house pattern — CodeBlock uses it on its own CopyButton. The
 * remaining overrides (colour, weight, padding, width) do win on source order,
 * verified the same way.
 */
function SecretRow({
  label,
  value,
  copyLabel,
  emphasis = false,
}: {
  label: string;
  value: string;
  copyLabel: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`mt-7 ${emphasis ? 'rule-strong pt-4' : 'rule pt-4'}`}>
      <span className="runhead">{label}</span>
      <div className="well mt-2 p-3.5">
        <code
          className={`block break-all font-mono ${
            emphasis
              ? 'text-[15px] leading-relaxed text-slate-900 dark:text-slate-50'
              : 'text-[13px] leading-relaxed text-slate-700 dark:text-slate-300'
          }`}
        >
          {value}
        </code>
      </div>
      {emphasis ? (
        <CopyButton
          value={value}
          label={copyLabel}
          size={15}
          className="mt-4 w-full justify-center !rounded-lg border border-[var(--line)] py-3 !text-sm font-semibold text-slate-900 hover:text-slate-900 dark:text-slate-100 dark:hover:text-slate-100"
        />
      ) : (
        <CopyButton value={value} label={copyLabel} className="-ml-2 mt-1.5" />
      )}
    </div>
  );
}
