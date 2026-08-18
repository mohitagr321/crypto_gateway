import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Check, KeyRound, Save, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  changePassword,
  getNetworks,
  getSettings,
  listApiKeys,
  updateSettings,
} from '@/lib/api';
import { errorMessage } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import { isValidBep20Address, isValidTrc20Address, isValidUrl } from '@/lib/format';
import type { ChangePasswordInput, UpdateAccountSettings } from '@/types';
import PageHeader from '@/components/PageHeader';
import Section from '@/components/Section';
import Spinner from '@/components/Spinner';
import IpAllowlistCard from '@/components/IpAllowlistCard';

/**
 * Account settings — one titled surface per group of related fields.
 *
 * WHAT THE REDESIGN CHANGED. The page was a ruled spread: a narrow margin
 * column of running heads against a wide column of fields, divided by
 * hairlines. That reads correctly in a design made of rules, and in one made of
 * lit surfaces it reads as a page that was never finished — a settings form
 * printed straight onto the depth field. Each group is a `Section` now, which
 * is the same primitive every other page in the product is assembled from, so
 * "these three fields belong together" is said by a surface rather than by an
 * indent.
 *
 * THE GLOSS MOVED UNDER THE HEAD instead of into a margin column beside it.
 * With the running head lifted into the Section's own head strip, a lone
 * sentence stranded in a narrow left column would be an annotation with nothing
 * to annotate. It reads in order now: what this group is, what it is for, then
 * the fields.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT. Every validation rule, every
 * `aria-describedby` wiring, every warning and its ink. This is the page where a
 * merchant types the address their money will be swept to, so:
 *
 *   HINTS SIT ABOVE THE INPUT, not below it. "On-chain transfers are
 *   irreversible" is not a footnote about what you typed, it is a warning to
 *   read before you type, and it is wired to the field with `aria-describedby`
 *   so it is announced in that order too.
 *
 *   THE SIGNING-SECRET STATE IS A SENTENCE AND AN ICON, never colour alone —
 *   "no signing secret set" is the configuration a merchant most needs to
 *   notice, and it must survive greyscale.
 */

interface FormValues {
  webhookUrl: string;
  payoutWallet: string;
  payoutWalletTrc20: string;
}

interface PasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/**
 * The gloss under a group's running head: what this block of settings is FOR,
 * on a real measure so it is read rather than skipped.
 */
function Gloss({ children }: { children: ReactNode }) {
  return (
    <p className="measure text-xs leading-relaxed text-slate-500 dark:text-slate-400">
      {children}
    </p>
  );
}

/**
 * The field stack inside a group. Hairlines BETWEEN rows only — never above the
 * first, which would double the Section's own head rule, and never under the
 * last, which would leave a stroke hanging inside the surface.
 */
function Fields({ children }: { children: ReactNode }) {
  return <div className="mt-4 divide-y divide-[var(--line-soft)]">{children}</div>;
}

/** One ruled field row: label, hint, control, error — in reading order. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <label className="label mb-0" htmlFor={id}>
        {label}
      </label>
      {hint && (
        <p
          id={`${id}-hint`}
          className="measure mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400"
        >
          {hint}
        </p>
      )}
      <div className="mt-2 max-w-xl">{children}</div>
      {error && (
        <p id={`${id}-error`} className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The result of a save, as a line of type rather than a tinted rounded box.
 *
 * Colour is never the only carrier: the icon and the sentence both say which it
 * is, so the message survives greyscale and a red/green-blind reader. Light
 * text takes the 600 step, dark text the 400 — the 500 step never carries text.
 */
function Notice({ tone, children }: { tone: 'ok' | 'bad'; children: ReactNode }) {
  const Icon = tone === 'ok' ? Check : AlertCircle;
  return (
    <p
      role={tone === 'ok' ? 'status' : 'alert'}
      className={`inline-flex items-start gap-1.5 text-sm ${
        tone === 'ok'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-red-600 dark:text-red-400'
      }`}
    >
      <Icon size={15} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** Page-level load failure, set the way DataTable sets its own: no icon, no box. */
function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="surface p-5">
      <span className="runhead text-red-600 dark:text-red-400">Could not load</span>
      <p className="measure mt-3 text-base leading-relaxed text-slate-700 dark:text-slate-300">
        {message}
      </p>
      <button type="button" className="btn-secondary mt-5" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * Static placeholder in the shape of the real groups — surfaces included, since
 * the surfaces appearing under the placeholder text would be a larger movement
 * than the text landing in them. `.ghost`, not a shimmer: the frequency
 * boundary bans looping animation on a dashboard route.
 */
function SettingsGhost() {
  return (
    <>
      <span className="sr-only" role="status">
        Loading…
      </span>
      <div className="space-y-4" aria-busy="true">
        {[0, 1].map((g) => (
          <div key={g} className="surface p-4 sm:p-5">
            <span className="ghost h-3 w-28" aria-hidden />
            <span className="ghost mt-4 h-3 w-full max-w-sm" aria-hidden />
            <div className="mt-6 space-y-6">
              <div className="space-y-2">
                <span className="ghost h-3 w-32" aria-hidden />
                <span className="ghost h-10 w-full max-w-xl" aria-hidden />
              </div>
              <div className="space-y-2">
                <span className="ghost h-3 w-40" aria-hidden />
                <span className="ghost h-10 w-full max-w-xl" aria-hidden />
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PasswordSection() {
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<PasswordFormValues>({
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  const mutation = useMutation({
    mutationFn: (input: ChangePasswordInput) => changePassword(input),
    onSuccess: () => reset(),
  });

  const onSubmit = handleSubmit((v) =>
    mutation.mutate({
      currentPassword: v.currentPassword,
      newPassword: v.newPassword,
    }),
  );

  const errText =
    mutation.error && (mutation.error as unknown as ApiError).status === 401
      ? 'Current password is incorrect'
      : errorMessage(mutation.error);

  return (
    <form onSubmit={onSubmit}>
      <Section title="Password">
        <Gloss>
          Your dashboard sign-in. API keys are issued and revoked separately, on
          the API keys page.
        </Gloss>

        <Fields>
          <Field
            id="currentPassword"
            label="Current password"
            error={errors.currentPassword?.message}
          >
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              className="input"
              aria-invalid={errors.currentPassword ? true : undefined}
              aria-describedby={
                errors.currentPassword ? 'currentPassword-error' : undefined
              }
              {...register('currentPassword', {
                required: 'Enter your current password',
              })}
            />
          </Field>

          <Field
            id="newPassword"
            label="New password"
            hint="At least 8 characters."
            error={errors.newPassword?.message}
          >
            <input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              className="input"
              aria-invalid={errors.newPassword ? true : undefined}
              aria-describedby={`newPassword-hint${
                errors.newPassword ? ' newPassword-error' : ''
              }`}
              {...register('newPassword', {
                required: 'Enter a new password',
                minLength: {
                  value: 8,
                  message: 'Must be at least 8 characters',
                },
              })}
            />
          </Field>

          <Field
            id="confirmPassword"
            label="Confirm new password"
            error={errors.confirmPassword?.message}
          >
            <input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              className="input"
              aria-invalid={errors.confirmPassword ? true : undefined}
              aria-describedby={
                errors.confirmPassword ? 'confirmPassword-error' : undefined
              }
              {...register('confirmPassword', {
                required: 'Re-enter your new password',
                validate: (v) =>
                  v === watch('newPassword') || 'Passwords do not match',
              })}
            />
          </Field>
        </Fields>

        <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-[var(--line-soft)] pt-5">
          <button type="submit" className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? (
              <Spinner size={16} />
            ) : (
              <>
                <KeyRound size={16} /> Update password
              </>
            )}
          </button>
          {mutation.isError && <Notice tone="bad">{errText}</Notice>}
          {mutation.isSuccess && <Notice tone="ok">Password updated.</Notice>}
        </div>
      </Section>
    </form>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: getSettings });

  // Only surface the TRC20 payout wallet field when the gateway settles on Tron.
  const networksQuery = useQuery({
    queryKey: ['networks'],
    queryFn: getNetworks,
    staleTime: 5 * 60_000,
  });
  const trc20Enabled = (networksQuery.data ?? ['BEP20']).includes('TRC20');

  // Only needed so the allowlist card can say "you have a bearer key and no
  // allowlist" — the riskiest supported configuration.
  const keysQuery = useQuery({ queryKey: ['api-keys'], queryFn: () => listApiKeys() });
  const hasBearerKey =
    keysQuery.data?.some((k) => k.authMode === 'simple') ?? false;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    defaultValues: { webhookUrl: '', payoutWallet: '', payoutWalletTrc20: '' },
  });

  useEffect(() => {
    if (query.data) {
      reset({
        webhookUrl: query.data.webhookUrl ?? '',
        payoutWallet: query.data.payoutWallet ?? '',
        payoutWalletTrc20: query.data.payoutWalletTrc20 ?? '',
      });
    }
  }, [query.data, reset]);

  const mutation = useMutation({
    mutationFn: (input: UpdateAccountSettings) => updateSettings(input),
    onSuccess: (data) => {
      queryClient.setQueryData(['settings'], data);
      reset({
        webhookUrl: data.webhookUrl ?? '',
        payoutWallet: data.payoutWallet ?? '',
        payoutWalletTrc20: data.payoutWalletTrc20 ?? '',
      });
    },
  });

  const onSubmit = handleSubmit((v) =>
    mutation.mutate({
      webhookUrl: v.webhookUrl.trim() || null,
      payoutWallet: v.payoutWallet.trim() || null,
      payoutWalletTrc20: v.payoutWalletTrc20.trim() || null,
    }),
  );

  const secretSet = query.data?.webhookSecretSet;

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Settings"
        description="Where events are delivered, which wallets your money settles to, and who is allowed to call the API."
      />

      {query.isLoading ? (
        <SettingsGhost />
      ) : query.isError ? (
        <LoadFailure
          message={errorMessage(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="space-y-4">
          <form onSubmit={onSubmit} className="space-y-4">
            <Section title="Webhook">
              <Gloss>Where the gateway tells your server that money arrived.</Gloss>

              <Fields>
                <Field
                  id="webhookUrl"
                  label="Webhook URL"
                  hint={
                    <>
                      We POST <code className="code">payment.confirmed</code> events
                      here. Leave it empty to receive none.
                    </>
                  }
                  error={errors.webhookUrl?.message}
                >
                  <input
                    id="webhookUrl"
                    className="input"
                    placeholder="https://your-app.com/webhooks/gateway"
                    aria-invalid={errors.webhookUrl ? true : undefined}
                    aria-describedby={`webhookUrl-hint${
                      errors.webhookUrl ? ' webhookUrl-error' : ''
                    }`}
                    {...register('webhookUrl', {
                      validate: (v) =>
                        !v || isValidUrl(v) || 'Must be a valid http(s) URL',
                    })}
                  />
                </Field>

                {/* Not a field — a FACT about the account, which is why it is
                    stated as one line you can scan rather than buried at the end
                    of a paragraph in a tinted box, where it was before. */}
                <div className="py-4 first:pt-0 last:pb-0">
                  <span className="label mb-0 block">Payload signing</span>
                  <p className="measure mt-1 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                    Every webhook body is signed with your webhook secret using
                    HMAC-SHA256 (hex), sent in the{' '}
                    <code className="code">signature</code> field. Always verify it
                    before trusting a webhook — see the{' '}
                    <Link to="/docs" className="link-ink">
                      API docs
                    </Link>
                    .
                  </p>
                  <p
                    className={`mt-2.5 inline-flex items-center gap-2 text-sm ${
                      secretSet
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {secretSet ? (
                      <ShieldCheck size={15} className="shrink-0" aria-hidden />
                    ) : (
                      <ShieldAlert size={15} className="shrink-0" aria-hidden />
                    )}
                    <span>
                      {secretSet
                        ? 'Signing secret configured'
                        : 'No signing secret set — contact support to provision one'}
                    </span>
                  </p>
                </div>
              </Fields>
            </Section>

            <Section title={trc20Enabled ? 'Payout wallets' : 'Payout wallet'}>
              <Gloss>
                The addresses every settled payment is swept to. One per network —
                funds are never moved between chains.
              </Gloss>

              <Fields>
                <Field
                  id="payoutWallet"
                  label="BEP20 wallet address"
                  hint="BEP20 payouts are sent here. Check every character: on-chain transfers are irreversible and cannot be recalled."
                  error={errors.payoutWallet?.message}
                >
                  <input
                    id="payoutWallet"
                    className="input font-mono"
                    placeholder="0x…"
                    aria-invalid={errors.payoutWallet ? true : undefined}
                    aria-describedby={`payoutWallet-hint${
                      errors.payoutWallet ? ' payoutWallet-error' : ''
                    }`}
                    {...register('payoutWallet', {
                      validate: (v) =>
                        !v ||
                        isValidBep20Address(v) ||
                        'Must be a valid BEP20 (0x…40 hex) address',
                    })}
                  />
                </Field>

                {trc20Enabled && (
                  <Field
                    id="payoutWalletTrc20"
                    label="TRC20 (Tron) wallet address"
                    hint="Required only if you accept TRC20 payments; leave blank to disable TRC20 settlements. It must be a Tron (T…) address — never a BEP20 0x… one."
                    error={errors.payoutWalletTrc20?.message}
                  >
                    <input
                      id="payoutWalletTrc20"
                      className="input font-mono"
                      placeholder="T…"
                      aria-invalid={errors.payoutWalletTrc20 ? true : undefined}
                      aria-describedby={`payoutWalletTrc20-hint${
                        errors.payoutWalletTrc20 ? ' payoutWalletTrc20-error' : ''
                      }`}
                      {...register('payoutWalletTrc20', {
                        validate: (v) =>
                          !v ||
                          isValidTrc20Address(v) ||
                          'Must be a valid TRC20 (T…) address',
                      })}
                    />
                  </Field>
                )}
              </Fields>
            </Section>

            {/* THE ACTION, on a surface of its own.
                It commits BOTH groups above, so it cannot live inside either of
                them without implying it saves only that one. A bare button
                floating on the canvas would read as unfinished, so it gets the
                smallest surface on the page — enough to say "this belongs to
                the two blocks above" and nothing more. */}
            <div className="surface flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
              <button
                type="submit"
                className="btn-primary"
                disabled={mutation.isPending || !isDirty}
              >
                {mutation.isPending ? (
                  <Spinner size={16} />
                ) : (
                  <>
                    <Save size={16} /> Save changes
                  </>
                )}
              </button>
              {mutation.isError && (
                <Notice tone="bad">{errorMessage(mutation.error)}</Notice>
              )}
              {mutation.isSuccess && !isDirty && (
                <Notice tone="ok">Settings saved.</Notice>
              )}
            </div>
          </form>

          {/* Rendered bare, with no wrapper of its own — the same way Dashboard
              renders OnboardingChecklist. IpAllowlistCard draws its own block
              and its own running head, and it is not this page's file to
              convert; wrapping it here would either double the head or nest a
              surface inside a surface, depending on what its own conversion
              lands on. It is left to present itself. */}
          <IpAllowlistCard
            value={query.data?.ipWhitelist ?? []}
            hasBearerKey={hasBearerKey}
          />

          <PasswordSection />
        </div>
      )}
    </>
  );
}
