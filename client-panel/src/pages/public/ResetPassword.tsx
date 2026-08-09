import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Lock, Eye, EyeOff, CheckCircle2 } from 'lucide-react';
import AuthShell from '@/components/AuthShell';
import Spinner from '@/components/Spinner';
import { errorMessage, resetPassword } from '@/lib/api';

interface FormValues {
  newPassword: string;
  confirmPassword: string;
}

/**
 * Consumes the emailed reset token and sets a new password.
 *
 * Unlike VerifyEmail this does NOT auto-consume on mount — the token is spent
 * only when the form is submitted, so a link pre-fetched by a mail scanner
 * stays usable for the human who actually clicks it.
 *
 * Resetting also marks the address verified server-side (proving inbox control
 * is at least as strong as clicking the original link), so we send the user to
 * sign in rather than back through confirmation.
 */
export default function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';

  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [show, setShow] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>();

  const onSubmit = handleSubmit(async ({ newPassword }) => {
    setError(null);
    setSubmitting(true);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 1800);
    } catch (err) {
      setError(errorMessage(err, 'This reset link is invalid or has expired.'));
    } finally {
      setSubmitting(false);
    }
  });

  if (!token) {
    return (
      <AuthShell
        title="This link is incomplete"
        subtitle="The reset link is missing its token. Request a fresh one and use the newest email."
      >
        <Link to="/forgot-password" className="btn-primary w-full">
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell
        title="Password updated"
        subtitle="You can now sign in with your new password. Taking you there…"
      >
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-brand-200 bg-brand-50/60 py-12 dark:border-brand-900/60 dark:bg-brand-900/15">
          <CheckCircle2 className="text-brand-600 dark:text-brand-400" size={52} />
        </div>
        <Link to="/login" className="btn-primary mt-5 w-full">
          Sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Choose a new password"
      subtitle="Pick something you don't use anywhere else — this password guards your settlement settings."
      footer={
        <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
          Back to sign in
        </Link>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && (
          <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}{' '}
            <Link to="/forgot-password" className="font-medium underline">
              Request a new one
            </Link>
          </div>
        )}

        <div>
          <label className="label" htmlFor="newPassword">
            New password
          </label>
          <div className="relative">
            <Lock size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400" />
            <input
              id="newPassword"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus
              className="input pl-9 pr-10"
              placeholder="At least 10 characters"
              {...register('newPassword', {
                required: 'Password is required',
                minLength: { value: 10, message: 'Use at least 10 characters' },
              })}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
              aria-label={show ? 'Hide password' : 'Show password'}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {errors.newPassword && (
            <p className="mt-1 text-xs text-red-600">{errors.newPassword.message}</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="confirmPassword">
            Confirm new password
          </label>
          <div className="relative">
            <Lock size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400" />
            <input
              id="confirmPassword"
              type={show ? 'text' : 'password'}
              autoComplete="new-password"
              className="input pl-9"
              placeholder="Repeat it"
              {...register('confirmPassword', {
                required: 'Please confirm your password',
                validate: (v) => v === watch('newPassword') || 'Passwords do not match',
              })}
            />
          </div>
          {errors.confirmPassword && (
            <p className="mt-1 text-xs text-red-600">{errors.confirmPassword.message}</p>
          )}
        </div>

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? <Spinner size={16} /> : 'Update password'}
        </button>
      </form>
    </AuthShell>
  );
}
