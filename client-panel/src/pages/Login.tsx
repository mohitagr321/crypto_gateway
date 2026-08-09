import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Lock, Mail, ShieldCheck, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/context/AuthContext';
import AuthShell from '@/components/AuthShell';
import Spinner from '@/components/Spinner';
import { getSignupStatus } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import type { LoginInput } from '@/types';

interface LocationState {
  from?: { pathname?: string };
}

export default function Login() {
  const { isAuthenticated, login, mfaRequired } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const { data: signupEnabled } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>();

  if (isAuthenticated) {
    const to = (location.state as LocationState)?.from?.pathname ?? '/dashboard';
    return <Navigate to={to} replace />;
  }

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await login(values);
      if (res.mfaRequired) {
        setError('Enter the 6-digit code from your authenticator app.');
        return;
      }
      // A merchant who signed up but never clicked their confirmation link goes
      // to the onboarding checklist, whose first step is exactly that. Sending
      // them to a dashboard they cannot transact from would just confuse.
      if (!res.emailVerified) {
        navigate('/onboarding', { replace: true });
        return;
      }
      const to = (location.state as LocationState)?.from?.pathname ?? '/dashboard';
      navigate(to, { replace: true });
    } catch (err) {
      setError((err as ApiError).message || 'Invalid credentials.');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to your merchant dashboard."
      footer={
        signupEnabled ? (
          <>
            Don't have an account?{' '}
            <Link to="/signup" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
              Create one
            </Link>
          </>
        ) : (
          <span className="text-xs text-slate-400">
            Accounts on this gateway are provisioned by your operator.
          </span>
        )
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
          >
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="email">
            Email
          </label>
          <div className="relative">
            <Mail
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
            />
            <input
              id="email"
              type="email"
              autoComplete="username"
              autoFocus
              className="input pl-9"
              placeholder="merchant@example.com"
              {...register('email', { required: 'Email is required' })}
            />
          </div>
          {errors.email && (
            <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label className="label" htmlFor="password">
              Password
            </label>
            <Link
              to="/forgot-password"
              className="mb-1.5 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
            >
              Forgot?
            </Link>
          </div>
          <div className="relative">
            <Lock
              size={16}
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
            />
            <input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              className="input pl-9 pr-10"
              placeholder="••••••••"
              {...register('password', { required: 'Password is required' })}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.password && (
            <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>
          )}
        </div>

        {mfaRequired && (
          <div>
            <label className="label" htmlFor="mfaToken">
              Two-factor code
            </label>
            <div className="relative">
              <ShieldCheck
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
              />
              <input
                id="mfaToken"
                inputMode="numeric"
                autoFocus
                className="input pl-9 tracking-widest"
                placeholder="123456"
                {...register('mfaToken')}
              />
            </div>
          </div>
        )}

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? (
            <Spinner size={16} />
          ) : (
            <>
              <KeyRound size={16} /> Sign in
            </>
          )}
        </button>
      </form>
    </AuthShell>
  );
}
