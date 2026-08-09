import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  Globe,
  Lock,
  Mail,
  MapPin,
  Eye,
  EyeOff,
} from 'lucide-react';
import AuthShell from '@/components/AuthShell';
import Spinner from '@/components/Spinner';
import { LoadingPanel } from '@/components/Spinner';
import { errorMessage, getSignupStatus, register as registerApi } from '@/lib/api';
import { useAuth } from '@/context/AuthContext';
import type { RegisterInput } from '@/types';

/**
 * Two-step signup.
 *
 * Split because asking for six fields at once measurably costs completions, and
 * because step 1 is the only part we strictly need — the business details in
 * step 2 exist so an operator can recognise the account later.
 *
 * Validation is client-side only for immediacy; the API re-validates everything
 * (same 10-character password floor). The API's response is deliberately
 * identical whether or not the address is already registered, so this page can
 * never say "that email is taken" — it always routes to "check your inbox".
 */

interface FormValues extends RegisterInput {
  acceptTerms: boolean;
}

/** Cheap, honest strength signal — length first, then variety. */
function scorePassword(pw: string): { score: number; label: string; tone: string } {
  if (!pw) return { score: 0, label: '', tone: '' };
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 14) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  if (pw.length < 10) return { score: 1, label: 'Too short', tone: 'bg-red-500' };
  if (score <= 2) return { score: 2, label: 'Weak', tone: 'bg-amber-500' };
  if (score === 3) return { score: 3, label: 'Fair', tone: 'bg-amber-400' };
  if (score === 4) return { score: 4, label: 'Strong', tone: 'bg-brand-500' };
  return { score: 5, label: 'Very strong', tone: 'bg-brand-600' };
}

export default function Signup() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [step, setStep] = useState<1 | 2>(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const { data: enabled, isLoading: statusLoading } = useQuery({
    queryKey: ['signup-status'],
    queryFn: getSignupStatus,
    staleTime: 5 * 60_000,
  });

  const {
    register,
    handleSubmit,
    trigger,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ mode: 'onBlur' });

  const password = watch('password') ?? '';
  const strength = scorePassword(password);

  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  if (statusLoading) return <LoadingPanel />;
  if (enabled === false) {
    return (
      <AuthShell
        title="Registration is closed"
        subtitle="This gateway is not currently accepting new merchant accounts. If you were expecting an account, contact your operator — they can provision one for you directly."
      >
        <Link to="/login" className="btn-primary w-full">
          Back to sign in
        </Link>
      </AuthShell>
    );
  }

  const goToStep2 = async () => {
    setError(null);
    const ok = await trigger(['email', 'password']);
    if (ok) setStep(2);
  };

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    try {
      await registerApi({
        email: values.email.trim(),
        password: values.password,
        businessName: values.businessName.trim(),
        websiteUrl: values.websiteUrl?.trim() || undefined,
        country: values.country?.trim() || undefined,
      });
      // The response says nothing about whether the address was new. Always
      // route to "check your inbox" — that is the only honest next step.
      navigate('/check-email', {
        replace: true,
        state: { email: values.email.trim() },
      });
    } catch (err) {
      setError(errorMessage(err, 'Could not create your account. Please try again.'));
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <AuthShell
      title="Create your merchant account"
      subtitle="Confirm your email and you're active — no approval queue, no sales call."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-brand-600 hover:underline dark:text-brand-400">
            Sign in
          </Link>
        </>
      }
    >
      {/* Step indicator */}
      <div className="mb-6 flex items-center gap-3" aria-hidden>
        {[1, 2].map((n) => (
          <div key={n} className="flex flex-1 items-center gap-3">
            <span
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition ${
                step >= n
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
              }`}
            >
              {n}
            </span>
            <span className="h-1 flex-1 rounded-full bg-slate-200 dark:bg-slate-800">
              <span
                className={`block h-1 rounded-full bg-brand-600 transition-all duration-300 ${
                  step > n ? 'w-full' : 'w-0'
                }`}
              />
            </span>
          </div>
        ))}
      </div>
      <p className="sr-only" aria-live="polite">
        Step {step} of 2
      </p>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300"
          >
            {error}
          </div>
        )}

        {/* key={step} forces React to unmount step 1's inputs rather than
            reconcile them into step 2's. Without it the two steps' <input>
            elements occupy the same position in the tree, React reuses the DOM
            node, and the value typed into "email" reappears in
            "businessName" — the field arrives pre-filled with the address. */}
        {step === 1 ? (
          <div key="step-1" className="space-y-4">
            <Field
              id="email"
              label="Work email"
              icon={Mail}
              error={errors.email?.message}
            >
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
            </Field>

            <Field
              id="password"
              label="Password"
              icon={Lock}
              error={errors.password?.message}
            >
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="new-password"
                className="input pl-9 pr-10"
                placeholder="At least 10 characters"
                {...register('password', {
                  required: 'Password is required',
                  minLength: { value: 10, message: 'Use at least 10 characters' },
                })}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </Field>

            {password && (
              <div>
                <div className="flex gap-1" aria-hidden>
                  {[1, 2, 3, 4, 5].map((i) => (
                    <span
                      key={i}
                      className={`h-1 flex-1 rounded-full transition-colors ${
                        i <= strength.score ? strength.tone : 'bg-slate-200 dark:bg-slate-800'
                      }`}
                    />
                  ))}
                </div>
                <p className="mt-1.5 text-xs text-slate-500" aria-live="polite">
                  {strength.label}
                  {strength.score < 4 && ' — mix upper and lower case, digits and a symbol'}
                </p>
              </div>
            )}

            <button type="button" onClick={goToStep2} className="btn-primary w-full">
              Continue <ArrowRight size={16} />
            </button>
          </div>
        ) : (
          <div key="step-2" className="space-y-4">
            <Field
              id="businessName"
              label="Business name"
              icon={Building2}
              error={errors.businessName?.message}
            >
              <input
                id="businessName"
                autoFocus
                className="input pl-9"
                placeholder="Acme Commerce Ltd"
                {...register('businessName', {
                  required: 'Business name is required',
                  minLength: { value: 2, message: 'Enter your business name' },
                })}
              />
            </Field>

            <Field
              id="websiteUrl"
              label={<>Website <span className="font-normal text-slate-400">(optional)</span></>}
              icon={Globe}
              error={errors.websiteUrl?.message}
            >
              <input
                id="websiteUrl"
                type="url"
                className="input pl-9"
                placeholder="https://acme.com"
                {...register('websiteUrl', {
                  pattern: {
                    value: /^https?:\/\/.+\..+/,
                    message: 'Include http:// or https://',
                  },
                })}
              />
            </Field>

            <Field
              id="country"
              label={<>Country <span className="font-normal text-slate-400">(optional)</span></>}
              icon={MapPin}
            >
              <input
                id="country"
                className="input pl-9"
                placeholder="India"
                {...register('country')}
              />
            </Field>

            <label className="flex items-start gap-2.5 pt-1 text-sm text-slate-600 dark:text-slate-400">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800"
                {...register('acceptTerms', { required: true })}
              />
              <span>
                I understand that crypto transactions are irreversible and that
                settlement depends on network confirmations.
              </span>
            </label>
            {errors.acceptTerms && (
              <p className="text-xs text-red-600">Please confirm to continue</p>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="btn-secondary"
                disabled={submitting}
              >
                <ArrowLeft size={16} /> Back
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={submitting}>
                {submitting ? <Spinner size={16} /> : <>Create account <ArrowRight size={16} /></>}
              </button>
            </div>
          </div>
        )}
      </form>
    </AuthShell>
  );
}

function Field({
  id,
  label,
  icon: Icon,
  error,
  children,
}: {
  id: string;
  label: React.ReactNode;
  icon: typeof Mail;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="relative">
        <Icon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
        />
        {children}
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}
