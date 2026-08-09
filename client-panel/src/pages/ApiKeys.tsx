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
import CopyButton from '@/components/CopyButton';
import CodeBlock from '@/components/CodeBlock';
import Modal from '@/components/Modal';
import Spinner, { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';

/**
 * Multi-key management.
 *
 * Two things here are load-bearing rather than decorative:
 *  1. The one-time secret modal is not dismissable by clicking away — a merchant
 *     who loses the secret has to revoke and re-issue, so closing must be a
 *     deliberate "I have saved it".
 *  2. The mode picker states the payout consequence up front. Bearer keys are
 *     the easy choice, and someone picking one should know before they create it
 *     that it cannot move funds — not discover it from a 403 in production.
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

  const hasBearerKey = keys.data?.some((k) => k.authMode === 'simple') ?? false;
  const noIpAllowlist = (settings.data?.ipWhitelist ?? []).length === 0;

  return (
    <>
      <PageHeader
        title="API Keys"
        description="Credentials your server uses to talk to the gateway. Give each integration its own key."
        actions={
          <button className="btn-primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> New key
          </button>
        }
      />

      {hasBearerKey && noIpAllowlist && (
        <div className="mb-6 flex gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-900/20 dark:text-amber-200">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" />
          <p>
            You have a <strong>bearer-token key</strong> and no IP allowlist. That
            token works from anywhere it leaks. Add your server's IP under{' '}
            <a href="/settings" className="font-semibold underline">
              Settings
            </a>{' '}
            to contain that.
          </p>
        </div>
      )}

      {keys.isLoading ? (
        <LoadingPanel />
      ) : keys.isError ? (
        <ErrorState message={errorMessage(keys.error)} onRetry={() => keys.refetch()} />
      ) : keys.data && keys.data.length === 0 ? (
        <div className="card flex flex-col items-center px-6 py-16 text-center">
          <KeyRound size={34} className="text-slate-300 dark:text-slate-700" />
          <h3 className="mt-4 text-base font-semibold text-slate-900 dark:text-slate-100">
            No API keys yet
          </h3>
          <p className="mt-1.5 max-w-sm text-sm text-slate-500">
            Create one to start taking payments from your own server. The secret is
            shown once, at creation.
          </p>
          <button className="btn-primary mt-6" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Create your first key
          </button>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:border-slate-800 dark:bg-slate-800/50">
                <tr>
                  <th className="px-5 py-3 font-medium">Key</th>
                  <th className="px-5 py-3 font-medium">Mode</th>
                  <th className="px-5 py-3 font-medium">Scopes</th>
                  <th className="px-5 py-3 font-medium">Last used</th>
                  <th className="px-5 py-3 font-medium">Created</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
                {keys.data?.map((k) => (
                  <tr key={k.id}>
                    <td className="px-5 py-4">
                      <div className="flex items-center gap-2">
                        <code className="font-mono text-[13px] text-slate-700 dark:text-slate-200">
                          {k.apiKey}
                        </code>
                        {k.authMode === 'hmac' && <CopyButton value={k.apiKey} />}
                      </div>
                      {k.label && (
                        <span className="mt-0.5 block text-xs text-slate-500">{k.label}</span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      {k.authMode === 'hmac' ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700 dark:bg-brand-900/25 dark:text-brand-300">
                          <ShieldCheck size={12} /> Signed
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 dark:bg-amber-900/25 dark:text-amber-300">
                          <KeyRound size={12} /> Bearer
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4">
                      <div className="flex flex-wrap gap-1">
                        {k.scopes.map((s) => (
                          <code
                            key={s}
                            className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                          >
                            {s}
                          </code>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-400">
                      {k.lastUsedAt ? formatDate(k.lastUsedAt) : 'Never'}
                    </td>
                    <td className="px-5 py-4 text-slate-600 dark:text-slate-400">
                      {formatDate(k.createdAt)}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <button
                        className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/20"
                        onClick={() => setRevoking(k)}
                        aria-label={`Revoke key ${k.apiKey}`}
                      >
                        <Trash2 size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Danger zone. Last on the page and visually separated, because the one
          action in it revokes every credential the account has. It was
          previously unreachable from the UI entirely — the endpoint existed and
          nothing called it, so a merchant with a leaked key of unknown identity
          had no way to shut the door. */}
      <section className="mt-8 rounded-2xl border border-red-200 bg-red-50/50 p-5 dark:border-red-900/40 dark:bg-red-950/20">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex gap-3">
            <ShieldAlert size={18} className="mt-0.5 shrink-0 text-red-600 dark:text-red-400" />
            <div>
              <h2 className="text-sm font-semibold text-red-900 dark:text-red-200">
                Think a key has leaked?
              </h2>
              <p className="mt-1 max-w-xl text-sm leading-relaxed text-red-800/90 dark:text-red-300/90">
                Revoke every active key at once and issue a single new
                HMAC-signed key. Your integrations will fail with 401 until you
                deploy the new credentials — that is the point.
              </p>
            </div>
          </div>
          <button
            className="btn-danger shrink-0"
            onClick={() => setRegenOpen(true)}
          >
            Revoke all keys
          </button>
        </div>
      </section>

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
        <div className="space-y-5">
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
            <p className="mt-1 text-xs text-slate-500">
              So you know which integration to revoke later.
            </p>
          </div>

          <fieldset>
            <legend className="label">Authentication</legend>
            <div className="space-y-2.5">
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

          {authMode === 'simple' && (
            <p className="flex gap-2.5 rounded-lg bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
              <ShieldAlert size={15} className="mt-0.5 shrink-0" />
              <span>
                This key will get <code className="font-mono">payments:read</code> and{' '}
                <code className="font-mono">payments:write</code> only. Add an IP
                allowlist in Settings so the token is useless from anywhere else.
              </span>
            </p>
          )}

          {create.isError && (
            <p className="text-sm text-red-600">{errorMessage(create.error)}</p>
          )}
        </div>
      </Modal>

      {/* ---------------- One-time secret ---------------- */}
      <Modal
        open={Boolean(created)}
        onClose={() => setCreated(null)}
        dismissable={false}
        title="Save your API credentials"
        footer={
          <button className="btn-primary" onClick={() => setCreated(null)}>
            I have saved them
          </button>
        }
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>
              This is the only time the secret is shown. Copy it into your secret
              manager now — if you lose it you will have to revoke this key and
              create another.
            </span>
          </div>

          {created?.authMode === 'hmac' ? (
            <>
              <SecretRow label="API Key (public id)" value={created.apiKey} />
              <SecretRow label="API Secret" value={created.apiSecret} highlight />
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
            </>
          ) : (
            created && (
              <>
                <SecretRow label="Bearer token" value={created.apiSecret} highlight />
                <CodeBlock
                  tabs={[
                    {
                      label: 'Headers',
                      code: `X-Api-Key: ${created.apiSecret}`,
                    },
                  ]}
                />
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
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Use this if you think a key has leaked and you are not sure which one.
        </p>
        <ul className="mt-3 space-y-1.5 text-sm text-slate-600 dark:text-slate-300">
          <li className="flex gap-2">
            <span aria-hidden>•</span>
            <span>
              <strong>Every active key is revoked immediately</strong>, including
              bearer keys. Every integration you run will start failing with 401
              until you deploy the new credentials.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden>•</span>
            <span>
              One new <strong>HMAC-signed</strong> key is issued. Its secret is
              shown once and never again.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden>•</span>
            <span>This cannot be undone.</span>
          </li>
        </ul>
        <p className="mt-4 text-sm text-slate-600 dark:text-slate-300">
          For ordinary rotation, create a new key, move your integration across,
          then revoke the old one — no downtime.
        </p>

        <label className="label mt-5" htmlFor="regen-confirm">
          Type <code className="font-mono text-xs">REVOKE ALL</code> to confirm
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
          <p className="mt-3 text-sm text-red-600">{errorMessage(regenerate.error)}</p>
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
        <p className="text-sm text-slate-600 dark:text-slate-300">
          <code className="font-mono text-xs">{revoking?.apiKey}</code> stops working
          immediately. Any integration still using it will start failing with 401.
          This cannot be undone.
        </p>
        {revoke.isError && (
          <p className="mt-3 text-sm text-red-600">{errorMessage(revoke.error)}</p>
        )}
      </Modal>
    </>
  );
}

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
      className={`flex cursor-pointer gap-3 rounded-xl border p-4 transition ${
        selected
          ? 'border-brand-500 bg-brand-50/60 ring-1 ring-brand-500/30 dark:bg-brand-900/15'
          : 'border-slate-200 hover:border-slate-300 dark:border-slate-700 dark:hover:border-slate-600'
      }`}
    >
      <input
        type="radio"
        name="authMode"
        className="mt-1 h-4 w-4 shrink-0 border-slate-300 text-brand-600 focus:ring-brand-500"
        checked={selected}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="flex items-center gap-2">
          <Icon size={15} className="text-slate-500" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {title}
          </span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400">
            {badge}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-relaxed text-slate-600 dark:text-slate-400">
          {body}
        </span>
      </span>
    </label>
  );
}

function SecretRow({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="label">{label}</p>
      <div
        className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
          highlight
            ? 'border-brand-300 bg-brand-50 dark:border-brand-700 dark:bg-brand-900/20'
            : 'border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/60'
        }`}
      >
        <code
          className={`min-w-0 flex-1 break-all font-mono text-sm ${
            highlight ? 'text-brand-800 dark:text-brand-200' : ''
          }`}
        >
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
