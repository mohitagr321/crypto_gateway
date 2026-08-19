import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { login as apiLogin, REFRESH_KEY, TOKEN_KEY, USER_KEY } from '@/lib/api';
import type { AuthUser, LoginResponse, Role } from '@/types';

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  role: Role | null;
  isAuthenticated: boolean;
  /** Returns { mfaRequired } — when true the caller should collect a TOTP token and retry. */
  login: (
    email: string,
    password: string,
    mfaToken?: string
  ) => Promise<{
    mfaRequired: boolean;
    /** Non-null when the sign-in is waiting on an emailed approval. */
    approval: { challenge: string; sentTo: string; expiresAt: string } | null;
  }>;
  /** Adopt the session a pending approval finally produced. */
  completeApproval: (res: LoginResponse) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function decodeJwtRole(token: string): { role?: Role; email?: string; id?: string; name?: string } {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    return {
      role: payload.role as Role | undefined,
      email: payload.email,
      id: payload.sub ?? payload.id,
      name: payload.name,
    };
  } catch {
    return {};
  }
}

function loadUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());

  const persistSession = useCallback((res: LoginResponse) => {
    if (!res.accessToken) return;
    localStorage.setItem(TOKEN_KEY, res.accessToken);
    if (res.refreshToken) localStorage.setItem(REFRESH_KEY, res.refreshToken);

    const claims = decodeJwtRole(res.accessToken);
    const resolved: AuthUser = {
      id: res.user?.id ?? claims.id ?? 'me',
      email: res.user?.email ?? claims.email ?? '',
      role: (res.user?.role ?? claims.role ?? 'ops') as Role,
      name: res.user?.name ?? claims.name,
    };
    localStorage.setItem(USER_KEY, JSON.stringify(resolved));
    setToken(res.accessToken);
    setUser(resolved);
  }, []);

  const login = useCallback(
    async (email: string, password: string, mfaToken?: string) => {
      const res = await apiLogin(email, password, mfaToken);
      // Admin login can return an MFA challenge before issuing a token.
      if (res.mfaRequired && !res.accessToken) {
        return { mfaRequired: true, approval: null };
      }

      // THE PASSWORD WAS RIGHT AND THERE IS STILL NO SESSION. An email has gone
      // to the operator's address and the server is holding a pending request;
      // the challenge is this browser's claim on it. Returned to the caller and
      // held in component state — never persisted, because a stored challenge
      // would let a stolen browser profile finish somebody else's sign-in.
      if (res.approvalRequired && res.challenge) {
        return {
          mfaRequired: false,
          approval: {
            challenge: res.challenge,
            sentTo: res.sentTo ?? '',
            expiresAt: res.expiresAt ?? '',
          },
        };
      }

      persistSession(res);
      return { mfaRequired: false, approval: null };
    },
    [persistSession]
  );

  /**
   * Finish a sign-in that was waiting on an emailed approval. Called by the
   * pending screen's poll on the one response that carries a session.
   */
  const completeApproval = useCallback(
    (res: LoginResponse) => persistSession(res),
    [persistSession]
  );

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      role: user?.role ?? null,
      isAuthenticated: Boolean(token),
      login,
      completeApproval,
      logout,
    }),
    [user, token, login, completeApproval, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
