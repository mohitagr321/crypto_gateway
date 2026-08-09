import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Save, ShieldCheck } from 'lucide-react';
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
import Spinner from '@/components/Spinner';
import { LoadingPanel } from '@/components/Spinner';
import ErrorState from '@/components/ErrorState';
import IpAllowlistCard from '@/components/IpAllowlistCard';

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

function PasswordCard() {
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
    <form onSubmit={onSubmit} className="card space-y-4 p-6">
      <div className="flex items-center gap-2">
        <KeyRound size={16} className="text-brand-600" />
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          Change password
        </h3>
      </div>

      {mutation.isError && (
        <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {errText}
        </div>
      )}
      {mutation.isSuccess && (
        <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          Password updated
        </div>
      )}

      <div>
        <label className="label" htmlFor="currentPassword">
          Current password
        </label>
        <input
          id="currentPassword"
          type="password"
          autoComplete="current-password"
          className="input"
          {...register('currentPassword', {
            required: 'Enter your current password',
          })}
        />
        {errors.currentPassword && (
          <p className="mt-1 text-xs text-red-600">
            {errors.currentPassword.message}
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="newPassword">
          New password
        </label>
        <input
          id="newPassword"
          type="password"
          autoComplete="new-password"
          className="input"
          {...register('newPassword', {
            required: 'Enter a new password',
            minLength: {
              value: 8,
              message: 'Must be at least 8 characters',
            },
          })}
        />
        {errors.newPassword && (
          <p className="mt-1 text-xs text-red-600">
            {errors.newPassword.message}
          </p>
        )}
      </div>

      <div>
        <label className="label" htmlFor="confirmPassword">
          Confirm new password
        </label>
        <input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          className="input"
          {...register('confirmPassword', {
            required: 'Re-enter your new password',
            validate: (v) =>
              v === watch('newPassword') || 'Passwords do not match',
          })}
        />
        {errors.confirmPassword && (
          <p className="mt-1 text-xs text-red-600">
            {errors.confirmPassword.message}
          </p>
        )}
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          className="btn-primary"
          disabled={mutation.isPending}
        >
          {mutation.isPending ? (
            <Spinner size={16} />
          ) : (
            <>
              <KeyRound size={16} /> Update password
            </>
          )}
        </button>
      </div>
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

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configure webhook delivery, your payout wallet and API access restrictions."
      />

      {query.isLoading ? (
        <LoadingPanel />
      ) : query.isError ? (
        <ErrorState
          message={errorMessage(query.error)}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="mx-auto max-w-2xl space-y-6">
        <form onSubmit={onSubmit} className="space-y-6">
          {mutation.isError && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {errorMessage(mutation.error)}
            </div>
          )}
          {mutation.isSuccess && !isDirty && (
            <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
              Settings saved.
            </div>
          )}

          <div className="card space-y-4 p-6">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Webhook
            </h3>
            <div>
              <label className="label" htmlFor="webhookUrl">
                Webhook URL
              </label>
              <input
                id="webhookUrl"
                className="input"
                placeholder="https://your-app.com/webhooks/gateway"
                {...register('webhookUrl', {
                  validate: (v) =>
                    !v || isValidUrl(v) || 'Must be a valid http(s) URL',
                })}
              />
              {errors.webhookUrl && (
                <p className="mt-1 text-xs text-red-600">
                  {errors.webhookUrl.message}
                </p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                We POST <code>payment.confirmed</code> events here.
              </p>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
              <ShieldCheck size={16} className="mt-0.5 shrink-0 text-brand-600" />
              <span>
                Every webhook body is signed with your{' '}
                <strong>webhook secret</strong> using HMAC-SHA256 (hex), sent in
                the <code>signature</code> field.{' '}
                {query.data?.webhookSecretSet
                  ? 'A signing secret is configured for your account.'
                  : 'No signing secret is set yet — contact support to provision one.'}{' '}
                Always verify it before trusting a webhook. See{' '}
                <a href="/docs" className="text-brand-600 hover:underline">
                  API Docs
                </a>
                .
              </span>
            </div>
          </div>

          <div className="card space-y-4 p-6">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">
              Payout wallet{trc20Enabled ? 's' : ''}
            </h3>
            <div>
              <label className="label" htmlFor="payoutWallet">
                BEP20 wallet address
              </label>
              <input
                id="payoutWallet"
                className="input font-mono"
                placeholder="0x…"
                {...register('payoutWallet', {
                  validate: (v) =>
                    !v ||
                    isValidBep20Address(v) ||
                    'Must be a valid BEP20 (0x…40 hex) address',
                })}
              />
              {errors.payoutWallet && (
                <p className="mt-1 text-xs text-red-600">
                  {errors.payoutWallet.message}
                </p>
              )}
              <p className="mt-1 text-xs text-slate-500">
                BEP20 payouts are sent here. Double-check — on-chain transfers are
                irreversible.
              </p>
            </div>

            {trc20Enabled && (
              <div>
                <label className="label" htmlFor="payoutWalletTrc20">
                  TRC20 (Tron) wallet address
                </label>
                <input
                  id="payoutWalletTrc20"
                  className="input font-mono"
                  placeholder="T…"
                  {...register('payoutWalletTrc20', {
                    validate: (v) =>
                      !v ||
                      isValidTrc20Address(v) ||
                      'Must be a valid TRC20 (T…) address',
                  })}
                />
                {errors.payoutWalletTrc20 && (
                  <p className="mt-1 text-xs text-red-600">
                    {errors.payoutWalletTrc20.message}
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  Required only if you accept TRC20 payments. Leave blank to
                  disable TRC20 settlements. Must be a Tron (T…) address — never a
                  BEP20 0x… address.
                </p>
              </div>
            )}
          </div>

          <div className="flex justify-end">
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
          </div>
        </form>

        <IpAllowlistCard
          value={query.data?.ipWhitelist ?? []}
          hasBearerKey={hasBearerKey}
        />

        <PasswordCard />
        </div>
      )}
    </>
  );
}
