import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type {
  AdminWithdrawal,
  Analytics,
  Client,
  CommissionBalance,
  CreateClientInput,
  LoginResponse,
  CollectResponse,
  ApprovalRequest,
  Paginated,
  Payout,
  SetCommissionInput,
  Transaction,
  TransactionFilters,
  TriggerPayoutInput,
  UpdateClientInput,
  WalletBalancesResponse,
  WebhookLog,
} from '@/types';

export const TOKEN_KEY = 'gw_admin_token';
export const REFRESH_KEY = 'gw_admin_refresh';
export const USER_KEY = 'gw_admin_user';

const baseURL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000/api/v1';

export const api = axios.create({
  baseURL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

// Attach JWT Bearer from localStorage on every request.
api.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/* ==========================================================================
 * SILENT REFRESH.
 *
 * The access token lives fifteen minutes and nothing renewed it: the refresh
 * token was stored at login and never presented, so an operator was thrown back
 * to the sign-in form every quarter of an hour, mid-investigation.
 *
 * SINGLE-FLIGHT IS THE CORRECTNESS CONDITION, not an optimisation. The server
 * ROTATES refresh tokens and treats a re-presented one as theft — presenting the
 * same token twice revokes the whole family and signs the device out. A console
 * screen fires several requests at once, so on expiry they all 401 together;
 * refreshing per failed request would present the same token several times and
 * trip reuse detection on every expiry, turning a silent renewal into a forced
 * logout that also looks like an attack in the audit log.
 *
 * The first 401 starts ONE refresh and every other caller awaits that promise.
 * ======================================================================== */

let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) throw new Error('no refresh token');

  // A BARE axios call, not `api`. Going through the instance would attach the
  // dead token and route a 401 from the refresh endpoint back into this
  // interceptor, recursing until the stack ends.
  const { data } = await axios.post<{ accessToken: string; refreshToken?: string }>(
    `${baseURL}/auth/refresh`,
    { refreshToken },
    { headers: { 'Content-Type': 'application/json' }, timeout: 20000 },
  );
  localStorage.setItem(TOKEN_KEY, data.accessToken);
  if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
  return data.accessToken;
}

function dropSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
  if (window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const status = error.response?.status;
    const url = error.config?.url ?? '';
    const original = error.config as
      | (InternalAxiosRequestConfig & { _retried?: boolean })
      | undefined;

    // Try exactly once per request. `_retried` stops a request whose retry also
    // 401s — a revoked family, a suspended account — from looping.
    const canRetry =
      status === 401 &&
      original &&
      !original._retried &&
      !url.includes('/auth/refresh') &&
      !url.includes('/auth/login') &&
      Boolean(localStorage.getItem(REFRESH_KEY));

    if (canRetry) {
      original._retried = true;
      try {
        refreshInFlight = refreshInFlight ?? refreshAccessToken();
        const fresh = await refreshInFlight;
        original.headers.set('Authorization', `Bearer ${fresh}`);
        return api(original);
      } catch {
        dropSession();
      } finally {
        // Cleared whether it resolved or rejected, so the next expiry starts a
        // fresh attempt rather than awaiting a settled promise forever.
        refreshInFlight = null;
      }
    } else if (status === 401 && !url.includes('/auth/login')) {
      dropSession();
    }

    return Promise.reject(error);
  }
);

/** Normalise an axios error into a readable message. */
export function apiErrorMessage(err: unknown): string {
  const e = err as AxiosError<{ message?: string; error?: string }>;
  return (
    e?.response?.data?.message ||
    e?.response?.data?.error ||
    e?.message ||
    'Something went wrong'
  );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export async function login(
  email: string,
  password: string,
  mfaToken?: string
): Promise<LoginResponse> {
  const { data } = await api.post<LoginResponse>('/auth/login', {
    email,
    password,
    ...(mfaToken ? { mfaToken } : {}),
  });
  return data;
}

/**
 * Poll a pending sign-in. Returns `{ status }` until the account holder answers
 * the email, and the session on the one call that finds an approval.
 *
 * The challenge is this browser's claim on the request and is deliberately NOT
 * persisted — it lives in component state for the life of the pending screen.
 * Storing it would make a stolen browser profile enough to complete somebody
 * else's half-finished login.
 */
export async function collectLogin(challenge: string): Promise<CollectResponse> {
  const { data } = await api.post<CollectResponse>('/auth/login/collect', { challenge });
  return data;
}

/** Read-only: what the approval page shows. Safe for a mail scanner to fetch. */
export async function getApprovalRequest(token: string): Promise<ApprovalRequest> {
  const { data } = await api.get<ApprovalRequest>('/auth/login/request', {
    params: { token },
  });
  return data;
}

/**
 * Answer a sign-in request. POST, and that is the point — mail providers fetch
 * the links in a message to scan them, so a GET here would be answered by a
 * robot before the operator saw the email.
 */
export async function decideApproval(
  token: string,
  decision: 'approve' | 'reject',
): Promise<{ status: string }> {
  const { data } = await api.post<{ status: string }>('/auth/login/decision', {
    token,
    decision,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------
export async function listClients(params?: {
  status?: string;
  /** 'self' shows only merchants who registered themselves. */
  signupSource?: 'admin' | 'self';
  page?: number;
  limit?: number;
}): Promise<Paginated<Client>> {
  const { data } = await api.get('/admin/clients', { params });
  return normalisePaginated<Client>(data);
}

export async function getClient(id: string): Promise<Client> {
  const { data } = await api.get<Client>(`/admin/clients/${id}`);
  return data;
}

export async function createClient(input: CreateClientInput): Promise<Client> {
  const { data } = await api.post<Client>('/admin/clients', input);
  return data;
}

export async function updateClient(
  id: string,
  input: UpdateClientInput
): Promise<Client> {
  const { data } = await api.put<Client>(`/admin/clients/${id}`, input);
  return data;
}

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------
export async function setCommission(input: SetCommissionInput): Promise<Client> {
  const { data } = await api.put<Client>('/admin/commission', input);
  return data;
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------
export async function listTransactions(
  filters?: TransactionFilters
): Promise<Paginated<Transaction>> {
  const { data } = await api.get('/admin/transactions', { params: filters });
  return normalisePaginated<Transaction>(data);
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------
export async function listPayouts(params?: {
  status?: string;
  clientId?: string;
  page?: number;
  limit?: number;
}): Promise<Paginated<Payout>> {
  const { data } = await api.get('/admin/payouts', { params });
  return normalisePaginated<Payout>(data);
}

export async function triggerPayout(input: TriggerPayoutInput): Promise<Payout> {
  const { data } = await api.post<Payout>('/admin/payout', input);
  return data;
}

// ---------------------------------------------------------------------------
// Webhook logs
// ---------------------------------------------------------------------------
export async function listWebhookLogs(params?: {
  clientId?: string;
  success?: boolean;
  page?: number;
  limit?: number;
}): Promise<Paginated<WebhookLog>> {
  const { data } = await api.get('/admin/webhook-logs', { params });
  return normalisePaginated<WebhookLog>(data);
}

// ---------------------------------------------------------------------------
// Wallet balances
// ---------------------------------------------------------------------------
export async function walletBalances(): Promise<WalletBalancesResponse> {
  const { data } = await api.get<WalletBalancesResponse>('/admin/wallets');
  return data;
}

// ---------------------------------------------------------------------------
// Commission balance / revenue withdrawals
// ---------------------------------------------------------------------------
export async function commissionBalance(): Promise<CommissionBalance> {
  const { data } = await api.get<CommissionBalance>('/admin/commission-balance');
  return data;
}

export async function withdrawCommission(input: {
  amount: string;
  toAddress: string;
  /** Omitted -> BEP20. Decides which central wallet pays and how the address is validated. */
  network?: string;
  /**
   * Omitted -> the chain's default asset (USDT where it exists, BTC on Bitcoin).
   * Commission accrued in any other asset can only be withdrawn by naming it:
   * the pool is per (network, asset) and the balances are not fungible.
   */
  asset?: string;
}): Promise<{ id: string; status: string }> {
  const { data } = await api.post<{ id: string; status: string }>(
    '/admin/commission-withdraw',
    input
  );
  return data;
}

export async function listCommissionWithdrawals(): Promise<AdminWithdrawal[]> {
  const { data } = await api.get<{ data: AdminWithdrawal[] }>('/admin/commission-withdrawals');
  return data.data ?? [];
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------
export async function analytics(params?: {
  from?: string;
  to?: string;
}): Promise<Analytics> {
  const { data } = await api.get<Analytics>('/admin/analytics', { params });
  return data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * The API returns either `{ data, page, total }` or a bare array depending on
 * the endpoint. Normalise both into a Paginated<T>.
 */
function normalisePaginated<T>(raw: unknown): Paginated<T> {
  if (Array.isArray(raw)) {
    return { data: raw as T[], page: 1, total: (raw as T[]).length };
  }
  const obj = (raw ?? {}) as Partial<Paginated<T>>;
  return {
    data: obj.data ?? [],
    page: obj.page ?? 1,
    total: obj.total ?? obj.data?.length ?? 0,
    limit: obj.limit,
  };
}
