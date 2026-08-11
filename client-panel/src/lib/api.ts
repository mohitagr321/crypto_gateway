import axios, {
  AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  AcceptedResponse,
  AccountSettings,
  AssetBalance,
  AssetInfo,
  CheckoutPayment,
  CheckoutStatus,
  CreateInvoiceInput,
  CreatePaymentLinkInput,
  CreateSubscriptionInput,
  Invoice,
  PaymentLink,
  PublicInvoice,
  PublicLink,
  RatesResponse,
  Subscription,
  SubscriptionInvoice,
  UnexpectedDeposit,
  ApiKeyInfo,
  ApiKeySummary,
  Balance,
  ChangePasswordInput,
  Commission,
  CreateApiKeyInput,
  CreatedApiKey,
  CreatePaymentInput,
  CreatePayoutInput,
  LoginInput,
  LoginResponse,
  OnboardingState,
  Paginated,
  Payment,
  PaymentListParams,
  Payout,
  RegenerateApiKeyResponse,
  RegisterInput,
  UpdateAccountSettings,
  WebhookLog,
  Analytics,
} from '@/types';

// ---------------------------------------------------------------------------
// Config + token storage
// ---------------------------------------------------------------------------
export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export const BSCSCAN_URL =
  import.meta.env.VITE_BSCSCAN_URL ?? 'https://bscscan.com';

export const TRONSCAN_URL =
  import.meta.env.VITE_TRONSCAN_URL ?? 'https://tronscan.org/#';

export const ETHERSCAN_URL =
  import.meta.env.VITE_ETHERSCAN_URL ?? 'https://etherscan.io';

/** Blockstream serves both mainnet and testnet; the path differs, not the host. */
export const BTC_EXPLORER_URL =
  import.meta.env.VITE_BTC_EXPLORER_URL ?? 'https://blockstream.info';

const TOKEN_KEY = 'cg_access_token';
const REFRESH_KEY = 'cg_refresh_token';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  set: (accessToken: string, refreshToken?: string) => {
    localStorage.setItem(TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

// ---------------------------------------------------------------------------
// Axios instance — attaches JWT Bearer, normalizes errors, handles 401.
// ---------------------------------------------------------------------------
export const http: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

http.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const token = tokenStore.get();
  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`);
  }
  return config;
});

export interface ApiError {
  status: number;
  error?: string;
  message: string;
}

/**
 * Narrow an unknown thrown value (React Query types errors as `Error`) to a
 * message string. All rejections from `http` are normalized to `ApiError`.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return fallback;
}

/** Callback wired up by AuthContext so a 401 can force a logout/redirect. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

http.interceptors.response.use(
  (res) => res,
  (err: AxiosError<{ error?: string; message?: string }>) => {
    const status = err.response?.status ?? 0;
    if (status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    const apiError: ApiError = {
      status,
      error: err.response?.data?.error,
      message:
        err.response?.data?.message ??
        err.message ??
        'Something went wrong. Please try again.',
    };
    return Promise.reject(apiError);
  },
);

// ---------------------------------------------------------------------------
// Typed endpoint functions
// ---------------------------------------------------------------------------

// ---- Auth ----
export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data } = await http.post<LoginResponse>('/auth/login', input);
  return data;
}

// ---- Self-registration ----
// Note: register / resendVerification / forgotPassword all resolve to the SAME
// acknowledgement whether or not the address exists. That is deliberate on the
// server (no account enumeration) — never branch the UI on their content.

/** Whether this gateway accepts self-registration at all. */
export async function getSignupStatus(): Promise<boolean> {
  try {
    const { data } = await http.get<{ enabled: boolean }>('/auth/signup-status');
    return data.enabled;
  } catch {
    // Older API, or the probe failed. Hide signup rather than offering a link
    // that 404s.
    return false;
  }
}

export async function register(input: RegisterInput): Promise<AcceptedResponse> {
  const { data } = await http.post<AcceptedResponse>('/auth/register', input);
  return data;
}

export async function verifyEmail(token: string): Promise<LoginResponse> {
  const { data } = await http.post<LoginResponse>('/auth/verify-email', { token });
  return data;
}

export async function resendVerification(email: string): Promise<AcceptedResponse> {
  const { data } = await http.post<AcceptedResponse>('/auth/resend-verification', {
    email,
  });
  return data;
}

export async function forgotPassword(email: string): Promise<AcceptedResponse> {
  const { data } = await http.post<AcceptedResponse>('/auth/forgot-password', {
    email,
  });
  return data;
}

export async function resetPassword(
  token: string,
  newPassword: string,
): Promise<{ success: boolean }> {
  const { data } = await http.post<{ success: boolean }>('/auth/reset-password', {
    token,
    newPassword,
  });
  return data;
}

// ---- Payments (JWT dashboard variants) ----
export async function listPayments(
  params: PaymentListParams = {},
): Promise<Paginated<Payment>> {
  const query: Record<string, string | number> = {};
  if (params.status) query.status = params.status;
  if (params.page) query.page = params.page;
  if (params.limit) query.limit = params.limit;
  const { data } = await http.get<Paginated<Payment>>('/payments', {
    params: query,
  });
  return data;
}

export async function getPayment(id: string): Promise<Payment> {
  const { data } = await http.get<Payment>(`/payments/${encodeURIComponent(id)}`);
  return data;
}

export async function createPayment(
  input: CreatePaymentInput,
): Promise<Payment> {
  const { data } = await http.post<Payment>('/payments', input);
  return data;
}

// ---- Payment links (merchant) ----
export async function listPaymentLinks(): Promise<PaymentLink[]> {
  const { data } = await http.get<PaymentLink[]>('/payment-links');
  return data;
}

export async function createPaymentLink(
  input: CreatePaymentLinkInput,
): Promise<PaymentLink> {
  const { data } = await http.post<PaymentLink>('/payment-links', input);
  return data;
}

export async function setPaymentLinkStatus(
  id: string,
  status: 'active' | 'disabled',
): Promise<PaymentLink> {
  const action = status === 'active' ? 'enable' : 'disable';
  const { data } = await http.post<PaymentLink>(
    `/payment-links/${encodeURIComponent(id)}/${action}`,
  );
  return data;
}

/** The full shareable checkout URL for a link. */
export function checkoutUrl(token: string): string {
  return `${window.location.origin}/pay/${token}`;
}

// ---- Hosted checkout (PUBLIC — no credentials) ----
// These use a BARE axios instance, not `http`: the shared client attaches the
// merchant's Bearer token and force-logs-out on 401. A customer paying a link
// has no session, and a 401 from this surface must never sign the merchant out
// of a tab they happen to have open.
const publicHttp = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

export async function getPublicLink(token: string): Promise<PublicLink> {
  const { data } = await publicHttp.get<PublicLink>(
    `/pay/${encodeURIComponent(token)}`,
  );
  return data;
}

export async function startCheckoutPayment(
  token: string,
  input: { asset?: string; network?: string; amount?: string },
): Promise<CheckoutPayment> {
  const { data } = await publicHttp.post<CheckoutPayment>(
    `/pay/${encodeURIComponent(token)}/payments`,
    input,
  );
  return data;
}

/**
 * The invoice behind a checkout link, when the link is an invoice's pay page.
 *
 * Resolves to null on 404 rather than throwing: a plain payment link legitimately
 * has no invoice, and the checkout page probes this for every link.
 */
export async function getPublicInvoice(token: string): Promise<PublicInvoice | null> {
  try {
    const { data } = await publicHttp.get<PublicInvoice>(
      `/pay/${encodeURIComponent(token)}/invoice`,
    );
    return data;
  } catch {
    return null;
  }
}

export async function getCheckoutStatus(
  token: string,
  paymentId: string,
): Promise<CheckoutStatus> {
  const { data } = await publicHttp.get<CheckoutStatus>(
    `/pay/${encodeURIComponent(token)}/payments/${encodeURIComponent(paymentId)}`,
  );
  return data;
}

// ---- Exchange rates ----
/**
 * Live rates for every fiat currency this gateway can price in.
 *
 * `source` and `ageSeconds` come back deliberately: when the gateway is serving
 * a stale rate the UI says so rather than presenting an old number as current.
 * Cached briefly client-side — the server already caches, and a converter that
 * refetches on every keystroke would be pointless traffic.
 */
export async function getRates(): Promise<RatesResponse> {
  const { data } = await http.get<RatesResponse>('/rates');
  return data;
}

// ---- Invoices ----
export async function listInvoices(status?: string): Promise<Invoice[]> {
  const { data } = await http.get<Invoice[]>('/invoices', {
    params: status ? { status } : undefined,
  });
  return data;
}

/** The single-invoice endpoint is the only one that returns line items. */
export async function getInvoice(id: string): Promise<Invoice> {
  const { data } = await http.get<Invoice>(`/invoices/${encodeURIComponent(id)}`);
  return data;
}

export async function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  const { data } = await http.post<Invoice>('/invoices', input);
  return data;
}

/**
 * `sent: false` means the gateway has no SMTP configured and logged the message
 * instead — the documented development behaviour, not a failure.
 */
export async function sendInvoice(id: string): Promise<{ sent: boolean; to: string }> {
  const { data } = await http.post<{ sent: boolean; to: string }>(
    `/invoices/${encodeURIComponent(id)}/send`,
  );
  return data;
}

export async function voidInvoice(id: string): Promise<Invoice> {
  const { data } = await http.post<Invoice>(`/invoices/${encodeURIComponent(id)}/void`);
  return data;
}

// ---- Subscriptions ----
export async function listSubscriptions(): Promise<Subscription[]> {
  const { data } = await http.get<Subscription[]>('/subscriptions');
  return data;
}

export async function createSubscription(
  input: CreateSubscriptionInput,
): Promise<Subscription> {
  const { data } = await http.post<Subscription>('/subscriptions', input);
  return data;
}

export async function setSubscriptionStatus(
  id: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<Subscription> {
  const { data } = await http.post<Subscription>(
    `/subscriptions/${encodeURIComponent(id)}/${action}`,
  );
  return data;
}

export async function getSubscriptionInvoices(
  id: string,
): Promise<SubscriptionInvoice[]> {
  const { data } = await http.get<SubscriptionInvoice[]>(
    `/subscriptions/${encodeURIComponent(id)}/invoices`,
  );
  return data;
}

// ---- Unexpected deposits ----
export async function listUnexpectedDeposits(): Promise<UnexpectedDeposit[]> {
  const { data } = await http.get<UnexpectedDeposit[]>('/account/unexpected-deposits');
  return data;
}

export async function recoverUnexpectedDeposit(
  id: string,
): Promise<{ success: boolean; txHash: string }> {
  const { data } = await http.post<{ success: boolean; txHash: string }>(
    `/account/unexpected-deposits/${encodeURIComponent(id)}/recover`,
  );
  return data;
}

// ---- Assets (capability probe) ----
// Which (network, asset) pairs this gateway can actually settle. Drives every
// coin picker, so the panel offers only what will succeed.
export async function getAssets(): Promise<AssetInfo[]> {
  const { data } = await http.get<{ assets: AssetInfo[] }>('/assets');
  return data.assets;
}

/** Per-asset balances, one row per (network, asset). */
export async function getAllBalances(): Promise<AssetBalance[]> {
  const { data } = await http.get<AssetBalance[]>('/balance', {
    params: { all: 'true' },
  });
  return data;
}

// ---- Networks (capability probe) ----
// Which chains this gateway can actually settle on. Always includes BEP20; adds
// TRC20 only when Tron is enabled server-side.
export async function getNetworks(): Promise<string[]> {
  const { data } = await http.get<{ networks: string[] }>('/networks');
  return data.networks;
}

// ---- Balance ----
export async function getBalance(): Promise<Balance> {
  const { data } = await http.get<Balance>('/balance');
  return data;
}

// ---- Payouts ----

/** Server ceiling on GET /payouts?limit (routes/payouts.ts clamps to 1..100). */
const PAYOUTS_PAGE_SIZE = 100;
/**
 * Hard stop on how many pages this helper will walk: 20 x 100 = 2,000 payouts.
 *
 * The page has no pager and sorts client-side, so it wants the whole history —
 * but "the whole history" must not become an unbounded fan-out of requests from
 * a browser tab. Beyond the cap the merchant sees the 2,000 most recent payouts
 * (newest first) and `Payouts.tsx` says so, rather than silently truncating.
 */
const PAYOUTS_MAX_PAGES = 20;

export interface PayoutHistory {
  rows: Payout[];
  /** Total the SERVER holds, which may exceed rows.length once the cap bites. */
  total: number;
  truncated: boolean;
}

/**
 * GET /api/v1/payouts USED TO RETURN A BARE ARRAY OF EVERY PAYOUT EVER.
 *
 * It is now paginated (`{ data, page, total }`, default limit 20) because the
 * unbounded version materialised a merchant's entire payout history on every
 * page load. This helper restores the panel's previous "show me all of it"
 * behaviour on top of the bounded endpoint by walking pages, so the table is
 * not silently reduced to the 20 most recent rows.
 *
 * The bare-array branch is kept so a panel deployed against an older backend
 * still works during a rolling upgrade.
 */
export async function listPayouts(): Promise<PayoutHistory> {
  const first = await http.get<Payout[] | Paginated<Payout>>('/payouts', {
    params: { page: 1, limit: PAYOUTS_PAGE_SIZE },
  });
  if (Array.isArray(first.data)) {
    return { rows: first.data, total: first.data.length, truncated: false };
  }

  const total = first.data.total ?? first.data.data.length;
  const rows = [...first.data.data];
  const pages = Math.ceil(total / PAYOUTS_PAGE_SIZE);
  const lastPage = Math.min(pages, PAYOUTS_MAX_PAGES);

  // Sequential, not Promise.all: this is a background refetch on a dashboard,
  // and firing 20 parallel requests at an API whose per-key budget is shared
  // with the merchant's own integration traffic is not worth the latency.
  for (let page = 2; page <= lastPage; page += 1) {
    const { data } = await http.get<Payout[] | Paginated<Payout>>('/payouts', {
      params: { page, limit: PAYOUTS_PAGE_SIZE },
    });
    const chunk = Array.isArray(data) ? data : data.data;
    if (chunk.length === 0) break;
    rows.push(...chunk);
  }

  return { rows, total, truncated: pages > PAYOUTS_MAX_PAGES };
}

export async function createPayout(input: CreatePayoutInput): Promise<Payout> {
  const { data } = await http.post<Payout>('/payouts', input);
  return data;
}

// ---- Account: API keys ----
export async function listApiKeys(
  includeRevoked = false,
): Promise<ApiKeySummary[]> {
  const { data } = await http.get<ApiKeySummary[]>('/account/api-keys', {
    params: includeRevoked ? { includeRevoked: 'true' } : undefined,
  });
  return data;
}

/** The response carries `apiSecret` — the only time it exists. Show it once. */
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  const { data } = await http.post<CreatedApiKey>('/account/api-keys', input);
  return data;
}

export async function revokeApiKey(id: string): Promise<{ success: boolean }> {
  const { data } = await http.delete<{ success: boolean }>(
    `/account/api-keys/${encodeURIComponent(id)}`,
  );
  return data;
}

/** Legacy single-key shape, kept for the documented SDK flow. */
export async function getApiKeys(): Promise<ApiKeyInfo> {
  const { data } = await http.get<ApiKeyInfo>('/account/api-keys/primary');
  return data;
}

export async function regenerateApiKeys(): Promise<RegenerateApiKeyResponse> {
  const { data } = await http.post<RegenerateApiKeyResponse>(
    '/account/api-keys/regenerate',
  );
  return data;
}

// ---- Account: onboarding ----
export async function getOnboarding(): Promise<OnboardingState> {
  const { data } = await http.get<OnboardingState>('/account/onboarding');
  return data;
}

// ---- Account: settings ----
export async function getSettings(): Promise<AccountSettings> {
  const { data } = await http.get<AccountSettings>('/account/settings');
  return data;
}

export async function updateSettings(
  input: UpdateAccountSettings,
): Promise<AccountSettings> {
  const { data } = await http.put<AccountSettings>('/account/settings', input);
  return data;
}

// ---- Account: commission ----
export async function getCommission(): Promise<Commission> {
  const { data } = await http.get<Commission>('/account/commission');
  return data;
}

// ---- Account: change password ----
export async function changePassword(
  input: ChangePasswordInput,
): Promise<{ success: boolean }> {
  const { data } = await http.post<{ success: boolean }>(
    '/account/change-password',
    { currentPassword: input.currentPassword, newPassword: input.newPassword },
  );
  return data;
}

// ---- Account: webhook logs ----
export async function getWebhookLogs(): Promise<WebhookLog[]> {
  const { data } = await http.get<WebhookLog[] | Paginated<WebhookLog>>(
    '/account/webhook-logs',
  );
  return Array.isArray(data) ? data : data.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
export const bscscanTx = (txHash: string) => `${BSCSCAN_URL}/tx/${txHash}`;
export const bscscanAddress = (addr: string) => `${BSCSCAN_URL}/address/${addr}`;

/**
 * Explorer links, resolved by the payment's/payout's own network.
 *
 * A hash from one chain is a dead link on another's explorer, so anything that
 * renders a hash MUST pass the network alongside it. `network` is optional and
 * defaults to BEP20 so older records — which predate the column and are BEP20
 * by definition — keep linking exactly where they always did.
 *
 * ERC20 needs its own entry even though it is an EVM chain like BEP20: the two
 * share an address FORMAT, which is exactly what makes a wrong link look
 * plausible instead of obviously broken.
 */
export const explorerTx = (txHash: string, network?: string) =>
  network === 'TRC20'
    ? `${TRONSCAN_URL}/transaction/${txHash}`
    : network === 'ERC20'
      ? `${ETHERSCAN_URL}/tx/${txHash}`
      : network === 'BTC'
        ? `${BTC_EXPLORER_URL}/tx/${txHash}`
        : bscscanTx(txHash);

export const explorerAddress = (addr: string, network?: string) =>
  network === 'TRC20'
    ? `${TRONSCAN_URL}/address/${addr}`
    : network === 'ERC20'
      ? `${ETHERSCAN_URL}/address/${addr}`
      : network === 'BTC'
        ? `${BTC_EXPLORER_URL}/address/${addr}`
        : bscscanAddress(addr);

/**
 * Human label for a network. Kept here rather than inlined at each call site so
 * adding a chain does not mean hunting for ternaries that quietly say "or else
 * it's BSC".
 */
export function networkLabel(network?: string | null): string {
  switch (network) {
    case 'TRC20':
      return 'TRC20 (Tron)';
    case 'ERC20':
      return 'ERC20 (Ethereum)';
    case 'BTC':
      return 'Bitcoin';
    default:
      return 'BEP20 (BNB Smart Chain)';
  }
}

// ---- Analytics ----

/**
 * Server-side aggregates for the dashboard.
 *
 * Replaces the old approach of pulling 500 payments and summing them in the
 * browser, which was accurate for a small account and quietly understated for a
 * busy one — the merchants who most need correct figures were the ones getting
 * wrong ones.
 */
export async function getAnalytics(days = 30): Promise<Analytics> {
  const { data } = await http.get<Analytics>('/account/analytics', {
    params: { days },
  });
  return data;
}
