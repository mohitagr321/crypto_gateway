import axios, { AxiosError } from 'axios';
import type {
  AdminWithdrawal,
  Analytics,
  Client,
  CommissionBalance,
  CreateClientInput,
  LoginResponse,
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

// On 401, clear session and bounce to /login (unless we're logging in).
api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    const status = error.response?.status;
    const url = error.config?.url ?? '';
    if (status === 401 && !url.includes('/auth/login')) {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(USER_KEY);
      if (window.location.pathname !== '/login') {
        window.location.assign('/login');
      }
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
