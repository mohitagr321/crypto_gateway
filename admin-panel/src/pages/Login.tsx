import { KeyRound, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router-dom';
import ThemeToggle from '@/components/ThemeToggle';
import { useAuth } from '@/context/AuthContext';
import { apiErrorMessage } from '@/lib/api';

interface FormValues {
  email: string;
  password: string;
  mfaToken?: string;
}

export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>();

  if (isAuthenticated) {
    navigate('/', { replace: true });
  }

  const onSubmit = async (values: FormValues) => {
    setError(null);
    try {
      const res = await login(values.email, values.password, values.mfaToken);
      if (res.mfaRequired) {
        setMfaRequired(true);
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-gray-50 px-4 py-12 dark:bg-gray-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {/* Same asset-neutral mark as the sidebar. This screen kept the ₮ tile
              and a "USDT (BEP20)" subtitle long after the gateway grew to seven
              assets across four chains. */}
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-brand-700 text-white">
            <ShieldCheck size={24} strokeWidth={2.25} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">SecuriPay Admin</h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Sign in to the admin console
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="card space-y-4 p-6">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
              {error}
            </div>
          )}

          <div>
            <label className="label">Email</label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="email"
                autoComplete="username"
                className="input pl-9"
                placeholder="admin@example.com"
                {...register('email', { required: 'Email is required' })}
              />
            </div>
            {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
          </div>

          <div>
            <label className="label">Password</label>
            <div className="relative">
              <Lock className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="password"
                autoComplete="current-password"
                className="input pl-9"
                placeholder="••••••••"
                {...register('password', { required: 'Password is required' })}
              />
            </div>
            {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
          </div>

          <div className={mfaRequired ? '' : 'opacity-70'}>
            <label className="label flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5" /> MFA token
              {mfaRequired && <span className="text-xs font-normal text-brand-600">(required)</span>}
            </label>
            <div className="relative">
              <KeyRound className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="input pl-9 tracking-widest"
                placeholder="123 456"
                {...register('mfaToken', {
                  required: mfaRequired ? 'MFA token is required' : false,
                })}
              />
            </div>
            {errors.mfaToken && <p className="mt-1 text-xs text-red-600">{errors.mfaToken.message}</p>}
            {mfaRequired && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Enter the 6-digit code from your authenticator app.
              </p>
            )}
          </div>

          <button type="submit" disabled={isSubmitting} className="btn-primary w-full">
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {mfaRequired ? 'Verify & sign in' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-xs text-gray-400">
          Admin access requires TOTP MFA. Contact a super admin if you are locked out.
        </p>
      </div>
    </div>
  );
}
