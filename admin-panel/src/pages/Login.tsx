import { Eye, EyeOff, KeyRound, Loader2, Lock, Mail, ShieldCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useLocation, useNavigate } from 'react-router-dom';
import DepthField from '@/components/DepthField';
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
 * It kept its card through the old design because it was the one screen that was
 * genuinely a single object floating on the page. That instinct was right and the
 * page around it was not: a bare slate ground, a masthead closed by a 2px
 * near-white rule, and no atmosphere behind any of it — so the one screen an
 * operator sees before the console looked nothing like the console.
 *
 * IT IS NOW THE MERCHANT PANEL'S AUTH TREATMENT, plane for plane. That panel
 * ships it as `AuthShell`; this one has no such component and inventing a
 * parallel abstraction for a single route would be exactly the drift this pass
 * exists to stop, so the four planes are assembled here and named after theirs:
 *
 *   0 FIELD      <DepthField /> — the same drifting aurora, grid and grain that
 *                sits behind every signed-in route. Signing in and being signed
 *                in are demonstrably the same room.
 *   1 CANVAS     the page, the running head, the <h1>, the standfirst and the
 *                small print. Printed ON the field, no fill of their own.
 *   2 SURFACE    the form. One rim-lit panel, and the only raised thing here, so
 *                there is never a question about where to look.
 *   3 FLOATING   the masthead, as `.glass` — matching Layout's topbar, which is
 *                what an operator sees one route later, down to the border
 *                reset and the flag on the same 4rem line.
 *
 * WHY THE HEADLINE IS NOT ON THE SURFACE. Same call `PageHeader` makes on every
 * signed-in route: the masthead is printed on the canvas and the first surface
 * below it draws the line between "where you are" and "what you do here".
 *
 * NO REVEAL, NO ENTRANCE, NOTHING ON MOUNT. This is a working screen opened by
 * someone already reaching for the password field.
 *
 * SAFE AREAS. This route is outside `Layout`, so it owns its own insets: the
 * masthead grows by the top inset rather than sliding under the status bar, and
 * the page pays the bottom one so the small print clears the home indicator.
 *
 * MFA IS THE POINT OF THIS FORM AND ITS BEHAVIOUR IS UNTOUCHED: the token field
 * is always registered, the SERVER decides when it becomes required, and
 * `mfaRequired` both switches on the validation rule and says so on screen. What
 * changed is that the field is now separated from the credentials by a hairline
 * instead of by a blanket `opacity-70` — a second act rather than a dimmed one.
 * Dimming a whole field group also dims its label below the contrast the rest of
 * the product holds itself to, which is a real cost for a decorative signal.
 */
export default function Login() {
  const { login, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } })?.from?.pathname ?? '/';

  const [mfaRequired, setMfaRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);

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
    <div className="relative flex min-h-dvh flex-col">
      {/* PLANE 0. */}
      <DepthField />

      {/* PLANE 3 — the same glass chrome as the console topbar. `.glass` rings
          all four sides; only the bottom edge is wanted on a full-bleed bar, so
          the other three are reset off. The flag is the Sidebar's, glyph for
          glyph: the mark an operator signs in under has to be the mark they then
          work under. */}
      <header className="glass sticky top-0 z-30 shrink-0 border-x-0 border-t-0 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))]">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* THE TILE IS A LIGHT SOURCE, NOT AN ELEVATED OBJECT, which is why
                it carries a coloured bloom rather than a grey shadow — nothing
                outside the floating plane casts, but a bloom is not a cast, it
                is the light the mark itself throws. Asset-neutral glyph: the ₮
                tile this replaced predated every chain but one. */}
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-500 to-accent-600 text-white shadow-[0_0_0_1px_oklch(var(--b-400)/0.35),0_6px_18px_-8px_oklch(var(--b-500)/0.85)]"
              aria-hidden
            >
              <PayCrypoMark size={17} />
            </span>
            <span className="min-w-0 leading-tight">
              <span className="block truncate text-[15px] font-semibold text-slate-900 dark:text-slate-50">
                {BRAND_NAME}
              </span>
              <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">
                {BRAND_CONSOLE_LABEL}
              </span>
            </span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* `justify-center` optically centres a short form without trapping a tall
          one: `flex-1` items keep their auto min-height, so the MFA step simply
          grows the element and the centring stops applying rather than pushing
          the top of the form out of reach. */}
      <main className="relative z-10 flex flex-1 flex-col justify-center px-4 pb-[calc(2.5rem+env(safe-area-inset-bottom))] pt-10 sm:px-6 sm:pt-14">
        {/* 28rem: wide enough for a label, a field and an inline error, narrow
            enough that the eye does not travel to find the next input. The same
            measure the merchant panel's funnel uses. */}
        <div className="mx-auto w-full min-w-0 max-w-[28rem]">
          <span className="runhead">Sign in</span>
          {/* The console's own display step, from PageHeader. `.h-section` is a
              marketing class and is deliberately not ported to this panel. */}
          <h1 className="mt-1.5 text-[1.75rem] font-semibold leading-[1.1] tracking-[-0.035em] text-slate-900 sm:text-3xl dark:text-slate-50">
            Welcome back
          </h1>
          <p className="measure mt-2 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Sign in to the operator console.
          </p>

          {/* PLANE 2. NOT a `.spot`: the cursor-follow highlight belongs on small
              discrete objects that read as tiles, and lighting a single 28rem
              panel that fills the reader's field of view is a wash rather than a
              highlight. It would also cost the rim — `.spot::after` and
              `.surface::after` are the same pseudo-element. */}
          <form onSubmit={handleSubmit(onSubmit)} className="surface mt-6 space-y-4 p-5 sm:p-7">
            {error && <FormError title="Could not sign in">{error}</FormError>}

            <Field id="login-email" label="Email" icon={Mail} error={errors.email?.message}>
              <input
                id="login-email"
                type="email"
                autoComplete="username"
                className="input pl-9"
                placeholder="admin@example.com"
                {...register('email', { required: 'Email is required' })}
              />
            </Field>

            <Field
              id="login-password"
              label="Password"
              icon={Lock}
              error={errors.password?.message}
            >
              <input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                className="input pl-9 pr-12"
                placeholder="••••••••"
                {...register('password', { required: 'Password is required' })}
              />
              {/* A 44px TARGET AROUND A 16px GLYPH. The box is transparent and
                  the icon sits optically where a bare glyph would; only the hit
                  area is real. At `sm` it relaxes to 36px alongside the field,
                  which is the same floor `.btn` and `.input` keep. */}
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0.5 top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-lg text-slate-400 transition-colors duration-[var(--dur-press)] hover:text-slate-700 sm:h-9 sm:w-9 dark:hover:text-slate-200"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff size={16} aria-hidden /> : <Eye size={16} aria-hidden />}
              </button>
            </Field>

            {/* The second factor is a second act, so it gets a hairline rather
                than another 16px of the same gap. A rule DIVIDING within a
                surface is what rules are for now. */}
            <div className="rule pt-4">
              <Field
                id="login-mfa"
                icon={KeyRound}
                error={errors.mfaToken?.message}
                label={
                  <span className="flex items-center gap-1.5">
                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> MFA token
                    {/* Amber: the sign-in is now waiting on something only the
                        operator has. The WORD is what says so. */}
                    {mfaRequired && (
                      <span className="text-xs font-semibold uppercase tracking-[0.1em] text-amber-600 dark:text-amber-400">
                        Required
                      </span>
                    )}
                  </span>
                }
              >
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
              </Field>
              {mfaRequired && (
                <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                  Enter the 6-digit code from your authenticator app.
                </p>
              )}
            </div>

            {/* `.motion-keep` is required: the reduced-motion catch-all in
                index.css would otherwise freeze the spinner, and a frozen
                spinner reads as a hung request. */}
            <button type="submit" disabled={isSubmitting} className="btn-primary w-full">
              {isSubmitting && <Loader2 className="motion-keep h-4 w-4 animate-spin" aria-hidden />}
              {mfaRequired ? 'Verify & sign in' : 'Sign in'}
            </button>
          </form>

          {/* Small print, set as small print, on the canvas — it is context for
              the panel above, not part of the task. The panel's own edge
              separates them, which is the trade this redesign makes everywhere:
              an edge instead of a stroke. */}
          <p className="measure mt-5 text-xs leading-relaxed text-slate-500 dark:text-slate-400">
            Admin access requires TOTP MFA. Contact a super admin if you are locked out.
          </p>
        </div>
      </main>
    </div>
  );
}

/**
 * Label, leading icon, control, inline error — the same four parts, in the same
 * order, as the merchant panel's funnel `Field`.
 *
 * Kept local to this page rather than lifted into components/: this is the only
 * screen in the console with a signed-out form, and a shared "form field"
 * abstraction is the thing that quietly grows six props.
 *
 * The icon is `z-10` and `pointer-events-none` so it sits over `.input`'s fill
 * without eating a click that belongs to the field.
 */
function Field({
  id,
  label,
  icon: Icon,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  icon: typeof Mail;
  error?: string;
  children: ReactNode;
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
          aria-hidden
        />
        {children}
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}
