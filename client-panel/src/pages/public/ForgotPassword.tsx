import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Mail, MailCheck } from 'lucide-react';
import AuthShell from '@/components/AuthShell';
import Spinner from '@/components/Spinner';
import { errorMessage, forgotPassword } from '@/lib/api';

/**
 * Password reset request.
 *
 * Always shows the same success state, because the API always answers the same
 * way — anything else would turn this form into an account-existence oracle.
 * The only failure surfaced is a transport/rate-limit error, which says nothing
 * about the address.
 */
export default function ForgotPassword() {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<{ email: string }>();

  const onSubmit = handleSubmit(async ({ email }) => {
    setError(null);
    setSubmitting(true);
    try {
      await forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      setError(errorMessage(err, 'Could not send the reset email. Try again shortly.'));
    } finally {
      setSubmitting(false);
    }
  });

  if (sent) {
    return (
      <AuthShell
        title="Check your inbox"
        subtitle="If that address has an account, we've sent it a link to choose a new password. It expires in an hour."
        footer={
          <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Back to sign in
          </Link>
        }
      >
        <div className="flex items-center justify-center rounded-2xl border border-brand-200 bg-brand-50/60 py-12 dark:border-brand-900/60 dark:bg-brand-900/15">
          <MailCheck className="text-brand-600 animate-float dark:text-brand-400" size={44} />
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the email on your account and we'll send you a link to set a new password."
      footer={
        <>
          Remembered it?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && (
          <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="email">
            Email address
          </label>
          <div className="relative">
            <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400" />
            <input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              className="input pl-9"
              placeholder="you@yourcompany.com"
              {...register('email', {
                required: 'Email is required',
                pattern: { value: /^\S+@\S+\.\S+$/, message: 'Enter a valid email address' },
              })}
            />
          </div>
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>

        <button type="submit" className="btn-primary w-full" disabled={submitting}>
          {submitting ? <Spinner size={16} /> : 'Send reset link'}
        </button>
      </form>
    </AuthShell>
  );
}
