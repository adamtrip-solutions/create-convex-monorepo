import type { AppSpec, GeneratorContext } from '../../../generator/types.js';
import { platform } from '../shared.js';

/**
 * Expo has no official AuthKit SDK. The app is a public PKCE client: it opens
 * hosted AuthKit with expo-auth-session and exchanges the code without a secret.
 */
export async function writeWorkosNativeApp(
  ctx: GeneratorContext,
  app: AppSpec,
): Promise<void> {
  const dir = `apps/${app.name}`;
  const { env, prefix } = platform(app);
  await ctx.write(
    `${dir}/src/workos-auth.tsx`,
    `import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState, Platform } from 'react-native';
import { AuthRequest, CodeChallengeMethod } from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';

WebBrowser.maybeCompleteAuthSession();

const authorizeUrl = 'https://api.workos.com/user_management/authorize';
const authenticateUrl = 'https://api.workos.com/user_management/authenticate';
const logoutUrl = 'https://api.workos.com/user_management/sessions/logout';
// Two keys keep each value under the SecureStore size guidance of 2048 bytes.
const accessTokenKey = 'workos.access_token';
const refreshTokenKey = 'workos.refresh_token';
// Refresh shortly before expiry so Convex never receives an expired token.
const expiryLeewaySeconds = 60;
// A request to WorkOS is abandoned after this long, so a hung connection cannot block every caller waiting on the refresh.
const requestTimeoutMs = 8_000;
// A refresh that cannot reach WorkOS is tried up to this many times, waiting 0.5, 1, 2 and 4 s in between,
// or longer when a 429 response sets Retry-After.
const refreshAttempts = 5;
const refreshBackoffMs = 500;
// WorkOS accepts a used refresh token again for 30 s and returns the same rotated tokens, so a refresh whose reply
// was lost can be repeated. Every attempt of one refresh must finish within this budget, which leaves 5 s of margin.
// When every attempt times out, the attempts run 0-8 s, 8.5-16.5 s and 17.5-25 s, the last one shortened to fit.
// When every attempt fails at once, the five attempts finish after 0.5 + 1 + 2 + 4 = 7.5 s.
const refreshBudgetMs = 25_000;
// After a refresh fails for network reasons, requests in this window reuse that result instead of calling WorkOS again.
const refreshCooldownMs = 20_000;
// While WorkOS is unreachable, the session retries on this interval and when the app returns to the foreground.
const offlineRetryMs = 30_000;

// SecureStore exists only on iOS and Android. Expo web is not a build target, so it keeps tokens in memory until reload.
const memory = new Map<string, string>();
const storage = Platform.OS === 'ios' || Platform.OS === 'android'
  ? { get: (key: string) => SecureStore.getItemAsync(key), set: (key: string, value: string) => SecureStore.setItemAsync(key, value), remove: (key: string) => SecureStore.deleteItemAsync(key) }
  : { get: async (key: string) => memory.get(key) ?? null, set: async (key: string, value: string) => { memory.set(key, value); }, remove: async (key: string) => { memory.delete(key); } };

interface Tokens { accessToken: string; refreshToken: string }
interface WorkOSAuth {
  isLoading: boolean;
  /** The sid claim. It changes on sign-in and stays the same across refreshes. */
  sessionId: string | null;
  /** True when the access token expired and WorkOS could not be reached to refresh it. The session is kept. */
  offline: boolean;
  /** Increases each time an offline session should try to refresh again. */
  retryCount: number;
  /** Schedules one more try after a refresh that could not reach WorkOS, if the last one failed. Returns a cancel function. */
  retryAfterFailure(): () => void;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null>;
}

class WorkOSRequestError extends Error {
  transient: boolean;
  retryAfterMs: number;
  constructor(message: string, transient: boolean, retryAfterMs = 0) {
    super(message);
    this.transient = transient;
    this.retryAfterMs = retryAfterMs;
  }
}

function claims(token: string | undefined): { exp?: number; sid?: string } | null {
  try {
    const payload = (token?.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))) as { exp?: number; sid?: string };
  } catch {
    return null;
  }
}
function expiresSoon(token: string, leewaySeconds = expiryLeewaySeconds): boolean {
  const exp = claims(token)?.exp;
  return typeof exp !== 'number' || (exp - leewaySeconds) * 1000 <= Date.now();
}
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/** Time left until the next offline retry, counted from the refresh that failed. */
function retryDelay(failedAt = Date.now()): number {
  return Math.max(0, offlineRetryMs - (Date.now() - failedAt));
}
/** Reads Retry-After as seconds or as an HTTP date. */
function retryAfterMs(header: string | null): number {
  if (!header) return 0;
  const ms = /^\\d+$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

type AuthenticateBody = { access_token?: unknown; refresh_token?: unknown; error?: unknown; error_description?: unknown };

/** Calls the AuthKit authenticate endpoint as a public client. No client secret leaves the server. */
async function authenticate(clientId: string, grant: Record<string, string>, timeoutMs = requestTimeoutMs): Promise<Tokens> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  let text: string;
  try {
    response = await fetch(authenticateUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, ...grant }),
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    // Offline, timed out, or the connection dropped. The refresh token is still valid.
    throw new WorkOSRequestError('Could not reach WorkOS. Check the network connection.', true);
  } finally {
    clearTimeout(timer);
  }
  let body: AuthenticateBody | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') body = parsed as AuthenticateBody;
  } catch {
    // Not JSON, such as a Wi-Fi login page or a proxy error.
  }
  if (response.ok && typeof body?.access_token === 'string' && typeof body.refresh_token === 'string')
    return { accessToken: body.access_token, refreshToken: body.refresh_token };
  // Only an OAuth error from WorkOS ends the session, such as invalid_grant for a revoked or already used refresh token.
  // Captive portals and proxies answer with HTML or other statuses such as 200, 302, 407 and 511, so those are retried.
  const error = typeof body?.error === 'string' ? body.error : null;
  const terminal = error !== null && [400, 401, 403].includes(response.status);
  const description = typeof body?.error_description === 'string' ? body.error_description : error;
  const message = description ?? (body ? 'WorkOS returned HTTP ' + response.status + '.' : 'Could not reach WorkOS. Check the network connection.');
  throw new WorkOSRequestError(message, !terminal, response.status === 429 ? retryAfterMs(response.headers.get('Retry-After')) : 0);
}

const WorkOSContext = createContext<WorkOSAuth | null>(null);

export function WorkOSProvider({ clientId, redirectUri, children }: { clientId: string; redirectUri: string; children: ReactNode }) {
  const tokens = useRef<Tokens | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);
  // Sign-in and sign-out bump the epoch so a refresh that finishes later cannot restore or return an old session.
  const epoch = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const lastFailure = useRef<{ epoch: number; at: number } | null>(null);
  const [state, setState] = useState({ isLoading: true, sessionId: null as string | null, offline: false, retryCount: 0 });

  const store = useCallback((next: Tokens | null, expected: number): Promise<boolean> => {
    const write = writes.current.catch(() => undefined).then(async () => {
      if (expected !== epoch.current) return false;
      // Write the rotated refresh token first. If the app stops between writes, the next launch
      // refreshes with the new refresh token instead of pairing a new access token with a used one.
      if (next) {
        await storage.set(refreshTokenKey, next.refreshToken);
        await storage.set(accessTokenKey, next.accessToken);
      } else {
        await storage.remove(refreshTokenKey);
        await storage.remove(accessTokenKey);
      }
      tokens.current = next;
      setState((current) => ({ ...current, isLoading: false, sessionId: claims(next?.accessToken)?.sid ?? null, offline: false }));
      return true;
    });
    writes.current = write;
    return write;
  }, []);

  useEffect(() => {
    const expected = epoch.current;
    Promise.all([storage.get(accessTokenKey), storage.get(refreshTokenKey)])
      .then(([accessToken, refreshToken]) => {
        if (expected !== epoch.current) return;
        tokens.current = accessToken && refreshToken ? { accessToken, refreshToken } : null;
        setState((current) => ({ ...current, isLoading: false, sessionId: tokens.current ? claims(accessToken ?? undefined)?.sid ?? null : null }));
      })
      .catch(() => setState((current) => ({ ...current, isLoading: false, sessionId: null })));
  }, []);

  // While offline, ask Convex for a token again on an interval and whenever the app returns to the foreground.
  useEffect(() => {
    if (!state.offline) return;
    // Each retry makes one real refresh. Later requests from the same retry reuse its result.
    const retry = () => {
      lastFailure.current = null;
      setState((current) => (current.offline ? { ...current, retryCount: current.retryCount + 1 } : current));
    };
    // The session can go offline up to 20 s after the refresh failed, when the token expires inside the cooldown.
    const timer = setTimeout(retry, retryDelay(lastFailure.current?.at));
    const subscription = AppState.addEventListener('change', (status) => { if (status === 'active') retry(); });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [state.offline, state.retryCount]);

  // Convex drops a token it rejects before it expires, such as after clock skew or a key rotation. When the refresh it
  // forces cannot reach WorkOS, it gets the same token back and stops asking, so the caller retries once per failure.
  const retryAfterFailure = useCallback((): (() => void) => {
    const failed = lastFailure.current;
    if (!failed || failed.epoch !== epoch.current) return () => undefined;
    const timer = setTimeout(() => {
      if (failed.epoch !== epoch.current) return;
      lastFailure.current = null;
      setState((current) => ({ ...current, retryCount: current.retryCount + 1 }));
    }, retryDelay(failed.at));
    return () => clearTimeout(timer);
  }, []);

  const refresh = useCallback(async (current: Tokens, expected: number): Promise<string | null> => {
    // Keep the session. An access token that has not expired yet still works.
    const keep = () => {
      if (!expiresSoon(current.accessToken, 0)) return current.accessToken;
      setState((previous) => (previous.offline ? previous : { ...previous, offline: true }));
      return null;
    };
    // Convex asks again right after a failed refresh. Answer from the last failure until the next offline retry.
    const failed = lastFailure.current;
    if (failed && failed.epoch === expected && Date.now() - failed.at < refreshCooldownMs) return keep();
    const deadline = Date.now() + refreshBudgetMs;
    for (let attempt = 1; ; attempt++) {
      try {
        const next = await authenticate(clientId, { grant_type: 'refresh_token', refresh_token: current.refreshToken }, Math.min(requestTimeoutMs, deadline - Date.now()));
        if (lastFailure.current?.epoch === expected) lastFailure.current = null;
        return (await store(next, expected)) ? next.accessToken : null;
      } catch (error) {
        if (expected !== epoch.current) return null;
        if (!(error instanceof WorkOSRequestError && error.transient)) {
          await store(null, expected);
          return null;
        }
        // WorkOS did not rotate the refresh token, or still accepts it inside the replay window, so retry the same one.
        const delay = Math.max(refreshBackoffMs * 2 ** (attempt - 1), error.retryAfterMs);
        if (attempt < refreshAttempts && Date.now() + delay < deadline) {
          await wait(delay);
          if (expected !== epoch.current) return null;
          continue;
        }
        lastFailure.current = { epoch: expected, at: Date.now() };
        return keep();
      }
    }
  }, [clientId, store]);

  const getAccessToken = useCallback(async ({ forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<string | null> => {
    for (;;) {
      const expected = epoch.current;
      const current = tokens.current;
      if (!current) return null;
      if (!forceRefresh && !expiresSoon(current.accessToken)) return current.accessToken;
      // WorkOS rotates the refresh token on every use, so concurrent callers share one request.
      if (!refreshing.current) {
        const request: Promise<string | null> = refresh(current, expected).finally(() => {
          if (refreshing.current === request) refreshing.current = null;
        });
        refreshing.current = request;
      }
      const token = await refreshing.current;
      if (expected === epoch.current) return token;
      // Sign-in or sign-out replaced the session during the refresh. Discard the result and read the new session.
      await writes.current.catch(() => undefined);
      forceRefresh = false;
    }
  }, [refresh]);

  const signIn = useCallback(async () => {
    const request = new AuthRequest({
      clientId,
      redirectUri,
      usePKCE: true,
      codeChallengeMethod: CodeChallengeMethod.S256,
      extraParams: { provider: 'authkit' },
    });
    const result = await request.promptAsync({ authorizationEndpoint: authorizeUrl });
    if (result.type === 'error') throw new Error(result.error?.description ?? 'Sign-in failed. Try again.');
    // Cancelled, dismissed, or another sign-in is already open.
    if (result.type !== 'success') return;
    const code = result.params.code;
    if (!code || !request.codeVerifier) throw new Error('The sign-in response did not include an authorization code.');
    const next = await authenticate(clientId, { grant_type: 'authorization_code', code, code_verifier: request.codeVerifier });
    epoch.current += 1;
    refreshing.current = null;
    await store(next, epoch.current);
  }, [clientId, redirectUri, store]);

  const signOut = useCallback(async () => {
    const sessionId = claims(tokens.current?.accessToken)?.sid;
    epoch.current += 1;
    refreshing.current = null;
    await store(null, epoch.current);
    if (!sessionId) return;
    // WorkOS ends its session when the browser visits the logout endpoint, then returns to the app.
    await WebBrowser.openAuthSessionAsync(logoutUrl + '?' + new URLSearchParams({ session_id: sessionId, return_to: redirectUri }).toString(), redirectUri);
  }, [redirectUri, store]);

  const value = useMemo(() => ({ ...state, signIn, signOut, getAccessToken, retryAfterFailure }), [state, signIn, signOut, getAccessToken, retryAfterFailure]);
  return <WorkOSContext.Provider value={value}>{children}</WorkOSContext.Provider>;
}

export function useWorkOS(): WorkOSAuth {
  const auth = useContext(WorkOSContext);
  if (!auth) throw new Error('useWorkOS must be used inside WorkOSProvider.');
  return auth;
}
`,
  );
  await ctx.write(
    `${dir}/src/providers.tsx`,
    `import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConvexReactClient, ConvexProviderWithAuth, Authenticated, Unauthenticated, AuthLoading, useConvexAuth } from 'convex/react';
import { Text, View } from 'react-native';
import { WorkOSProvider, useWorkOS } from './workos-auth';
import { AuthControls } from './auth-controls';

export function Providers({ children }: { children: ReactNode }) {
  const url = ${env('CONVEX_URL')};
  const clientId = ${env('WORKOS_CLIENT_ID')};
  const redirectUri = ${env('WORKOS_REDIRECT_URI')};
  if (!url) return <Text>Set ${prefix}_CONVEX_URL in this app's .env.local.</Text>;
  if (!clientId) return <Text>Set ${prefix}_WORKOS_CLIENT_ID in this app's .env.local.</Text>;
  if (!redirectUri) return <Text>Set ${prefix}_WORKOS_REDIRECT_URI in this app's .env.local.</Text>;
  return <WorkOSProvider clientId={clientId} redirectUri={redirectUri}><Connection url={url}>{children}</Connection></WorkOSProvider>;
}
function Connection({ url, children }: { url: string; children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url, { unsavedChangesWarning: false }));
  return <ConvexProviderWithAuth client={client} useAuth={useAuthFromWorkOS}>
    <RetryRejectedToken />
    <AuthLoading><View style={{ flex: 1, padding: 24, paddingTop: 64 }}><Text>Connecting authentication…</Text></View></AuthLoading>
    <Unauthenticated><View style={{ flex: 1, padding: 24, paddingTop: 64 }}><AuthControls /></View></Unauthenticated>
    <Authenticated><View style={{ flex: 1, padding: 24, paddingTop: 64 }}>{children}</View></Authenticated>
  </ConvexProviderWithAuth>;
}
function useAuthFromWorkOS() {
  const { isLoading, sessionId, retryCount, getAccessToken } = useWorkOS();
  // Convex stops asking for a token after it receives null. A new retryCount gives this callback a new
  // identity, so ConvexProviderWithAuth asks again after WorkOS was unreachable.
  const fetchAccessToken = useCallback(async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
    if (!sessionId) return null;
    try {
      return await getAccessToken({ forceRefresh: forceRefreshToken });
    } catch {
      // Convex marks the session unauthenticated; AuthControls offers sign-in again.
      return null;
    }
  }, [sessionId, getAccessToken, retryCount]);
  return useMemo(() => ({ isLoading, isAuthenticated: !!sessionId, fetchAccessToken }), [isLoading, sessionId, fetchAccessToken]);
}
// Convex can reject a token that has not expired and then get the same token back because WorkOS was unreachable.
// It then reports the session as unauthenticated while WorkOS is not offline, so ask again after the last failed refresh.
function RetryRejectedToken() {
  const { sessionId, offline, retryCount, retryAfterFailure } = useWorkOS();
  const { isLoading, isAuthenticated } = useConvexAuth();
  useEffect(
    () => (sessionId && !offline && !isLoading && !isAuthenticated ? retryAfterFailure() : undefined),
    [sessionId, offline, isLoading, isAuthenticated, retryCount, retryAfterFailure],
  );
  return null;
}
`,
  );
  await ctx.write(
    `${dir}/src/auth-controls.tsx`,
    `import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import { useConvexAuth } from 'convex/react';
import { useWorkOS } from './workos-auth';

export function AuthControls() {
  const { isLoading: loading, sessionId, offline, signIn, signOut } = useWorkOS();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [pending, setPending] = useState<'signIn' | 'signOut' | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function authenticate() {
    setPending('signIn'); setError(null);
    try { await signIn(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed. Try again.'); }
    finally { setPending(null); }
  }
  async function logout() {
    setPending('signOut'); setError(null);
    try { await signOut(); }
    catch { setError('Could not sign out. Try again.'); }
    finally { setPending(null); }
  }
  if (loading || isLoading) return <Text>Loading sign-in…</Text>;
  return <View>
    {sessionId ? <Button title={pending === 'signOut' ? 'Signing out…' : 'Sign out'} disabled={!!pending} onPress={() => { void logout(); }} /> : null}
    {!isAuthenticated && <Button title={pending === 'signIn' ? 'Signing in…' : 'Sign in'} disabled={!!pending} onPress={() => { void authenticate(); }} />}
    {sessionId && !isAuthenticated && (offline
      ? <Text accessibilityRole="alert">Could not reach WorkOS to renew this session. Retrying automatically; check the network connection.</Text>
      : <Text accessibilityRole="alert">Convex could not authenticate this session. It retries automatically if WorkOS could not be reached. Otherwise, check the WorkOS JWT template and the Convex deployment configuration, or sign in again.</Text>)}
    {error && <Text accessibilityRole="alert">{error}</Text>}
  </View>;
}
`,
  );
}
