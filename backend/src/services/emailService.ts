/**
 * Outbound transactional email (verification, password reset, welcome, key alerts).
 *
 * ============================ DEV / PROD BEHAVIOUR ============================
 * With SMTP_HOST unset, NOTHING is sent: every message is rendered and written to
 * the log at `info`, including the full action link. That is the intended local
 * development mode — the entire signup flow is walkable without a mail server,
 * you just copy the link out of the console. Production is protected separately:
 * `config/env.ts` refuses to boot when SIGNUP_ENABLED=true in production without
 * SMTP_HOST/SMTP_FROM, so this fallback can never silently swallow a real
 * merchant's verification email.
 *
 * ============================== FAILURE POLICY ===============================
 * Every send is best-effort and returns a boolean; none of them throw. A signup
 * must not 500 because an SMTP server was briefly unreachable — the account is
 * already committed at that point, and the merchant can use "resend
 * verification". Callers log the false and carry on.
 *
 * The transport is a lazy module-level singleton (same shape as db/redis.ts) so
 * that a BEP20-only, signup-disabled deployment never constructs one.
 */
import nodemailer, { Transporter } from 'nodemailer';
import { config } from '../config/env';
import { logger } from './../config/logger';

let transporter: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!config.smtp.enabled) return null;
  if (transporter) return transporter;
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    // An unauthenticated relay (common for in-cluster MTAs) is legitimate.
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.password }
      : undefined,
  });
  return transporter;
}

/** Close the pooled SMTP connection on shutdown. Safe to call when unused. */
export function closeMailer(): void {
  transporter?.close();
  transporter = null;
}

interface Mail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function send(mail: Mail, context: Record<string, unknown>): Promise<boolean> {
  const tx = getTransport();
  if (!tx) {
    logger.info(
      { ...context, to: mail.to, subject: mail.subject, body: mail.text },
      'SMTP not configured — email NOT sent, logged instead',
    );
    return false;
  }
  try {
    await tx.sendMail({
      from: config.smtp.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    logger.info({ ...context, to: mail.to, subject: mail.subject }, 'email sent');
    return true;
  } catch (err) {
    // Never propagate: the caller's transaction has already committed.
    logger.error({ err, ...context, to: mail.to }, 'failed to send email');
    return false;
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const BRAND = config.brand.name;
// Matches the panel's brand-600 (#158055) so mail and dashboard look like one
// product. Inlined because mail clients strip <style> blocks.
const ACCENT = '#158055';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Shared HTML shell. Table-based and inline-styled on purpose — that is what
 * survives Outlook and Gmail. `cta` is optional (some mails are notice-only).
 */
function layout(opts: {
  heading: string;
  body: string; // pre-escaped HTML
  cta?: { label: string; url: string };
  footNote?: string;
}): string {
  const button = opts.cta
    ? `<tr><td style="padding:8px 0 24px">
         <a href="${escapeHtml(opts.cta.url)}"
            style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;
                   padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px">
           ${escapeHtml(opts.cta.label)}
         </a>
       </td></tr>
       <tr><td style="padding:0 0 24px;font-size:13px;color:#64748b;line-height:1.6">
         If the button doesn't work, paste this into your browser:<br>
         <span style="color:${ACCENT};word-break:break-all">${escapeHtml(opts.cta.url)}</span>
       </td></tr>`
    : '';

  const foot = opts.footNote
    ? `<tr><td style="padding:16px 0 0;font-size:13px;color:#64748b;line-height:1.6">
         ${opts.footNote}
       </td></tr>`
    : '';

  const support = config.brand.supportEmail
    ? ` · <a href="mailto:${escapeHtml(config.brand.supportEmail)}" style="color:#64748b">${escapeHtml(config.brand.supportEmail)}</a>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;padding:32px">
        <tr><td style="padding:0 0 20px">
          <span style="display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;
                       background:${ACCENT};color:#fff;border-radius:9px;font-weight:700;font-size:19px">&#8366;</span>
          <span style="font-weight:650;font-size:16px;color:#0f172a;margin-left:10px;vertical-align:middle">
            ${escapeHtml(BRAND)}
          </span>
        </td></tr>
        <tr><td style="padding:0 0 12px;font-size:21px;font-weight:650;color:#0f172a">
          ${escapeHtml(opts.heading)}
        </td></tr>
        <tr><td style="padding:0 0 24px;font-size:15px;color:#334155;line-height:1.65">
          ${opts.body}
        </td></tr>
        ${button}
        ${foot}
      </table>
      <div style="max-width:520px;padding:16px 8px;font-size:12px;color:#94a3b8;text-align:center">
        ${escapeHtml(BRAND)}${support}
      </div>
    </td></tr>
  </table>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Public senders
// ---------------------------------------------------------------------------

export async function sendVerificationEmail(opts: {
  to: string;
  businessName: string;
  token: string;
}): Promise<boolean> {
  const url = `${config.signup.panelUrl}/verify-email?token=${encodeURIComponent(opts.token)}`;
  const hours = config.signup.verifyTtlHours;
  return send(
    {
      to: opts.to,
      subject: `Confirm your email to activate ${BRAND}`,
      html: layout({
        heading: 'Confirm your email address',
        body: `Welcome, <strong>${escapeHtml(opts.businessName)}</strong>. Confirm this address
               to activate your merchant account — you'll be signed in and taken
               straight to your dashboard.`,
        cta: { label: 'Confirm email address', url },
        footNote: `This link expires in ${hours} hours and can be used once.
                   If you didn't create this account you can ignore this email — nothing was activated.`,
      }),
      text:
        `Confirm your email to activate your ${BRAND} merchant account.\n\n${url}\n\n` +
        `This link expires in ${hours} hours and can be used once. ` +
        `If you didn't create this account, ignore this email.`,
    },
    { event: 'email.verify' },
  );
}

export async function sendWelcomeEmail(opts: {
  to: string;
  businessName: string;
}): Promise<boolean> {
  const url = `${config.signup.panelUrl}/onboarding`;
  return send(
    {
      to: opts.to,
      subject: `Your ${BRAND} account is live`,
      html: layout({
        heading: 'Your account is live',
        body: `<strong>${escapeHtml(opts.businessName)}</strong> is verified and approved. Three
               steps left before you can take your first payment:
               <br><br>
               1. Add the wallet address your settlements should be paid to<br>
               2. Create an API key<br>
               3. Point a webhook URL at your server`,
        cta: { label: 'Finish setup', url },
      }),
      text:
        `${opts.businessName} is verified and approved.\n\n` +
        `Next: add a payout wallet, create an API key, set a webhook URL.\n\n${url}`,
    },
    { event: 'email.welcome' },
  );
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  token: string;
}): Promise<boolean> {
  const url = `${config.signup.panelUrl}/reset-password?token=${encodeURIComponent(opts.token)}`;
  const mins = config.signup.resetTtlMinutes;
  return send(
    {
      to: opts.to,
      subject: `Reset your ${BRAND} password`,
      html: layout({
        heading: 'Reset your password',
        body: `We received a request to reset the password for this account.`,
        cta: { label: 'Choose a new password', url },
        footNote: `This link expires in ${mins} minutes and can be used once.
                   If you didn't request it, no action is needed — your password is unchanged.`,
      }),
      text:
        `Reset your ${BRAND} password:\n\n${url}\n\n` +
        `Expires in ${mins} minutes, single use. If you didn't request it, ignore this email.`,
    },
    { event: 'email.password_reset' },
  );
}

/**
 * Sent when someone tries to register with an address that already has an
 * account. This is what makes the register endpoint enumeration-safe: the API
 * returns the SAME response either way, and the truth is delivered only to the
 * inbox that actually owns the address.
 */
export async function sendDuplicateSignupEmail(opts: { to: string }): Promise<boolean> {
  const url = `${config.signup.panelUrl}/forgot-password`;
  return send(
    {
      to: opts.to,
      subject: `Someone tried to sign up with your ${BRAND} email`,
      html: layout({
        heading: 'You already have an account',
        body: `Someone just tried to create a ${escapeHtml(BRAND)} account with this email address.
               You already have one, so nothing was created and nothing changed.
               <br><br>If that was you, sign in instead — or reset your password if you've forgotten it.`,
        cta: { label: 'Reset password', url },
      }),
      text:
        `Someone tried to sign up with this email, but you already have a ${BRAND} account. ` +
        `Nothing changed. Sign in, or reset your password: ${url}`,
    },
    { event: 'email.duplicate_signup' },
  );
}

/**
 * An invoice, sent to the merchant's customer.
 *
 * ============================ THIS ONE GOES TO A STRANGER ====================
 * Every other message in this file is addressed to someone who already has an
 * account here. This one is sent to an address a MERCHANT typed in, on their
 * behalf, and it carries text they wrote. Two consequences:
 *
 *   1. Everything merchant-supplied is escaped — the business name, the
 *      customer name, every line description, the notes. `layout` takes
 *      pre-escaped HTML, so an unescaped value here would be injected markup in
 *      someone else's inbox, sent from this gateway's domain.
 *   2. The route that triggers it is rate limited per merchant. Sending mail to
 *      arbitrary addresses on request is a spam relay if it is unbounded.
 *
 * The mail deliberately shows the document rather than only a link: a customer
 * should be able to see what they are being asked to pay without clicking
 * anything, which is also what makes it not look like a phishing attempt.
 */
export async function sendInvoiceEmail(opts: {
  to: string;
  merchantName: string;
  number: string;
  customerName: string | null;
  currency: string;
  total: string;
  dueDate: string | null;
  payUrl: string;
  items: Array<{ description: string; amount: string }>;
}): Promise<boolean> {
  const money = (v: string) => `${escapeHtml(opts.currency)} ${escapeHtml(trimZeros(v))}`;

  const rows = opts.items
    .map(
      (i) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155">
          ${escapeHtml(i.description)}
        </td>
        <td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#334155;text-align:right;white-space:nowrap">
          ${money(i.amount)}
        </td>
      </tr>`,
    )
    .join('');

  const due = opts.dueDate
    ? `<br>Due <strong>${escapeHtml(opts.dueDate)}</strong>.`
    : '';

  return send(
    {
      to: opts.to,
      subject: `Invoice ${opts.number} from ${opts.merchantName} — ${opts.currency} ${trimZeros(opts.total)}`,
      html: layout({
        heading: `Invoice ${escapeHtml(opts.number)}`,
        body:
          `${opts.customerName ? `Hello ${escapeHtml(opts.customerName)},<br><br>` : ''}` +
          `<strong>${escapeHtml(opts.merchantName)}</strong> has sent you an invoice.${due}
           <br><br>
           <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
             ${rows}
             <tr>
               <td style="padding:12px 0 0;font-size:15px;font-weight:650;color:#0f172a">Total</td>
               <td style="padding:12px 0 0;font-size:15px;font-weight:650;color:#0f172a;text-align:right;white-space:nowrap">
                 ${money(opts.total)}
               </td>
             </tr>
           </table>`,
        cta: { label: 'View and pay', url: opts.payUrl },
        footNote: `You can pay in a stablecoin of your choice — the amount is
                   converted at the rate current when you open the page, and held
                   while you complete the payment.`,
      }),
      text:
        `Invoice ${opts.number} from ${opts.merchantName}\n\n` +
        opts.items.map((i) => `  ${i.description}  ${opts.currency} ${trimZeros(i.amount)}`).join('\n') +
        `\n\n  Total: ${opts.currency} ${trimZeros(opts.total)}` +
        (opts.dueDate ? `\n  Due: ${opts.dueDate}` : '') +
        `\n\nPay: ${opts.payUrl}\n`,
    },
    { event: 'email.invoice', number: opts.number },
  );
}

/** Drop trailing zeros from a NUMERIC(38,18) string for display. */
function trimZeros(v: string): string {
  if (!v.includes('.')) return v;
  const trimmed = v.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed || '0';
}

/**
 * Security notice on key creation. A merchant who did not do this needs to know
 * immediately — a new key is a new credential against their balance.
 */
export async function sendApiKeyCreatedEmail(opts: {
  to: string;
  label: string;
  maskedKey: string;
  authMode: string;
}): Promise<boolean> {
  const url = `${config.signup.panelUrl}/api-keys`;
  return send(
    {
      to: opts.to,
      subject: `A new API key was created on your ${BRAND} account`,
      html: layout({
        heading: 'New API key created',
        body: `A new <strong>${escapeHtml(opts.authMode)}</strong> API key
               (<code>${escapeHtml(opts.label)}</code> — ${escapeHtml(opts.maskedKey)})
               was just created on your account.`,
        cta: { label: 'Review your API keys', url },
        footNote: `If this wasn't you, revoke the key immediately and change your password.`,
      }),
      text:
        `A new ${opts.authMode} API key (${opts.label} — ${opts.maskedKey}) was created ` +
        `on your ${BRAND} account. If this wasn't you, revoke it now: ${url}`,
    },
    { event: 'email.api_key_created' },
  );
}
