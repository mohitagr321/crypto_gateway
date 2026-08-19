import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { login as apiLogin, setUnauthorizedHandler, tokenStore } from '@/lib/api';
import type { LoginInput, LoginResponse } from '@/types';

interface JwtClaims {
  sub?: string;
  email?: string;
  name?: string;
  role?: string;
  exp?: number;
  [k: string]: unknown;
}

/** Best-effort decode of a JWT payload (no verification — display only). */
function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

interface AuthContextValue {
  isAuthenticated: boolean;
  user: JwtClaims | null;
  mfaRequired: boolean;
  /** false while a self-registered merchant has not clicked their email link. */
  emailVerified: boolean;
  login: (input: LoginInput) => Promise<{
    mfaRequired: boolean;
    emailVerified: boolean;
    /** Non-null when the sign-in is waiting on an emailed approval. */
    approval: { challenge: string; sentTo: string; expiresAt: string } | null;
  }>;
  /** Adopt the session a pending approval finally produced. */
  completeApproval: (res: LoginResponse) => boolean;
  /**
   * Adopt a token pair obtained WITHOUT a password — currently only from
   * /auth/verify-email, which signs the merchant in as part of confirming their
   * address so they land in the dashboard instead of at another login form.
   */
  adoptSession: (accessToken: string, refreshToken: string) => void;
  logout: () => void;
}

/**
 * Verification state is kept in localStorage alongside the tokens rather than
 * in the JWT: it changes independently of the token's lifetime (a merchant can
 * verify in another tab, and the access token is short-lived), and nothing
 * security-relevant hangs off it — the server is the authority, this only
 * decides which screen to show.
 */
const VERIFIED_KEY = 'cg_email_verified';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => tokenStore.get());
  const [mfaRequired, setMfaRequired] = useState(false);
  const [emailVerified, setEmailVerified] = useState<boolean>(
    // Default true so an operator-provisioned merchant — who has no
    // verification state at all — is never shown the "confirm your email" gate.
    () => localStorage.getItem(VERIFIED_KEY) !== 'false',
  );

  const logout = useCallback(() => {
    tokenStore.clear();
    localStorage.removeItem(VERIFIED_KEY);
    setToken(null);
    setMfaRequired(false);
    setEmailVerified(true);
  }, []);

  // Force logout on any 401 bubbling up from the API layer.
  useEffect(() => {
    setUnauthorizedHandler(() => logout());
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  const markVerified = useCallback((verified: boolean) => {
    localStorage.setItem(VERIFIED_KEY, String(verified));
    setEmailVerified(verified);
  }, []);

  /**
   * Adopt a token pair from any successful authentication. Shared by the direct
   * login path and the approval-collect path so the two cannot drift in what
   * they set up.
   */
  const acceptTokens = useCallback(
    (res: LoginResponse) => {
      // Older API builds omit the field; absent means "not applicable", not
      // "unverified" — treat it as verified so nothing regresses.
      const verified = res.emailVerified !== false;
      tokenStore.set(res.accessToken!, res.refreshToken!);
      setToken(res.accessToken!);
      setMfaRequired(false);
      markVerified(verified);
      return verified;
    },
    [markVerified],
  );

  const login = useCallback(
    async (input: LoginInput) => {
      const res = await apiLogin(input);
      if (res.mfaRequired && !input.mfaToken) {
        setMfaRequired(true);
        return { mfaRequired: true, emailVerified: true, approval: null };
      }

      // THE PASSWORD WAS RIGHT AND THERE IS STILL NO SESSION. An email has gone
      // to the account and the server is holding a pending request; the
      // challenge is this browser's claim on it. It is returned to the caller
      // and held in component state — never written to storage, because a
      // persisted challenge would let a stolen browser profile finish somebody
      // else's half-completed sign-in.
      if (res.approvalRequired && res.challenge) {
        setMfaRequired(false);
        return {
          mfaRequired: false,
          emailVerified: true,
          approval: {
            challenge: res.challenge,
            sentTo: res.sentTo ?? '',
            expiresAt: res.expiresAt ?? '',
          },
        };
      }

      const verified = acceptTokens(res);
      return { mfaRequired: false, emailVerified: verified, approval: null };
    },
    [acceptTokens],
  );

  /**
   * Finish a sign-in that was waiting on an emailed approval. Called by the
   * pending screen's poll on the one response that carries a session.
   */
  const completeApproval = useCallback(
    (res: LoginResponse) => acceptTokens(res),
    [acceptTokens],
  );

  const adoptSession = useCallback(
    (accessToken: string, refreshToken: string) => {
      tokenStore.set(accessToken, refreshToken);
      setToken(accessToken);
      setMfaRequired(false);
      // Reachable only from the verify-email flow, which has just proven it.
      markVerified(true);
    },
    [markVerified],
  );

  const user = useMemo(() => (token ? decodeJwt(token) : null), [token]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isAuthenticated: Boolean(token),
      user,
      mfaRequired,
      emailVerified,
      login,
      completeApproval,
      adoptSession,
      logout,
    }),
    [token, user, mfaRequired, emailVerified, login, completeApproval, adoptSession, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
