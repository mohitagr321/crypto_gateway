import { KeyRound, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router-dom';
import FormError, { FieldError } from '@/components/FormError';
import PayCrypoMark from '@/components/PayCrypoMark';
import ThemeToggle from '@/components/ThemeToggle';
import { useAuth } from '@/context/AuthContext';
import { apiErrorMessage } from '@/lib/api';
import { BRAND_CONSOLE_LABEL, BRAND_NAME } from '@/lib/brand';

interface FormValues {
  email: string;
  password: string;
  mfaToken?: string;
}

/**
 * THE DOOR.
 *
 * The one screen in this app that is genuinely a single surface floating on the
 * page, so it keeps its card — everything behind it is set on the sheet. The
 * masthead above it is the same flag the spine carries, so signing in and being
 * signed in look like the same product.
 *
 * MFA IS THE POINT OF THIS FORM AND ITS BEHAVIOUR IS UNCHANGED: the token field
 * is always present but quiet, the server decides when it becomes required, and
 * `mfaRequired` both switches on the validation rule and says so on screen.
 */
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
    <div className="flex min-h-full items-center justify-center bg-slate-50 px-4 py-12 dark:bg-slate-950">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm">
        {/* Asset-neutral mark. This screen kept a ₮ tile and a "USDT (BEP20)"
            subtitle long after the gateway grew past one asset on one chain. */}
        <div className="mb-8">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-white">
              <PayCrypoMark size={21} />
            </div>
            <div className="min-w-0">
              <p className="runhead">{BRAND_CONSOLE_LABEL}</p>
              <h1 className="mt-0.5 text-xl font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
                {BRAND_NAME}
              </h1>
            </div>
          </div>
          <p className="measure mt-4 border-t-2 border-slate-900 pt-3 text-sm leading-relaxed text-slate-500 dark:border-slate-100 dark:text-slate-400">
            Sign in to the operator console.
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} className="card space-y-4 p-6">
          {error && <FormError title="Could not sign in">{error}</FormError>}

          <div>
            <label className="label" htmlFor="login-email">
              Email
            </label>
            <div className="relative">
              <Mail
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                className="input pl-9"
                placeholder="admin@example.com"
                {...register('email', { required: 'Email is required' })}
              />
            </div>
            {errors.email && <FieldError>{errors.email.message}</FieldError>}
          </div>

          <div>
            <label className="label" htmlFor="login-password">
              Password
            </label>
            <div className="relative">
              <Lock
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                className="input pl-9"
                placeholder="••••••••"
                {...register('password', { required: 'Password is required' })}
              />
            </div>
            {errors.password && <FieldError>{errors.password.message}</FieldError>}
          </div>

          <div className={mfaRequired ? '' : 'opacity-70'}>
            <label className="label flex items-center gap-1.5" htmlFor="login-mfa">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> MFA token
              {/* Amber: the sign-in is now waiting on something only the operator
                  has. The WORD is what says so. */}
              {mfaRequired && (
                <span className="text-xs font-medium uppercase tracking-[0.1em] text-amber-600 dark:text-amber-400">
                  Required
                </span>
              )}
            </label>
            <div className="relative">
              <KeyRound
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
                aria-hidden
              />
              <input
                id="login-mfa"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="input num pl-9 tracking-widest"
                placeholder="123 456"
                {...register('mfaToken', {
                  required: mfaRequired ? 'MFA token is required' : false,
                })}
              />
            </div>
            {errors.mfaToken && <FieldError>{errors.mfaToken.message}</FieldError>}
            {mfaRequired && (
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Enter the 6-digit code from your authenticator app.
              </p>
            )}
          </div>

          <button type="submit" disabled={isSubmitting} className="btn-primary w-full">
            {isSubmitting && <Loader2 className="motion-keep h-4 w-4 animate-spin" aria-hidden />}
            {mfaRequired ? 'Verify & sign in' : 'Sign in'}
          </button>
        </form>

        <p className="measure mt-6 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
          Admin access requires TOTP MFA. Contact a super admin if you are locked
          out.
        </p>
      </div>
    </div>
  );
}
