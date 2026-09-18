import type { AppSpec } from '../../../generator/types.js';
import { clientSdk } from './providers.js';

export function workosControls(app: AppSpec): string {
  const spa = app.framework === 'vite';
  return `'use client';
import { useEffect, useState } from 'react';
import { useConvexAuth } from 'convex/react';
import { useAuth } from '${clientSdk(app)}';

export function AuthControls() {
  const { user, ${spa ? 'isLoading: loading, getSignInUrl, ' : ''}${spa ? '' : 'loading, '}signOut } = useAuth();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('workos_error') || new URLSearchParams(window.location.search).has('error'))
      setError('Sign-in failed. Try again.');
    ${
      spa
        ? `if (!loading && window.location.pathname === '/sign-in') {
      void signIn(getSignInUrl).catch(() => setError('Could not start sign-in. Try again.'));
    }`
        : ''
    }
  }, [${spa ? 'getSignInUrl, loading' : ''}]);
  async function authenticate() {
    setPending(true); setError(null);
    try { ${spa ? 'await signIn(getSignInUrl);' : "window.location.assign('/sign-in');"} }
    catch { setError('Could not start sign-in. Reload this page and try again.'); }
    finally { setPending(false); }
  }
  async function logout() {
    setPending(true); setError(null);
    try { await signOut({ returnTo: window.location.origin }); }
    catch { setError('Could not sign out. Try again.'); }
    finally { setPending(false); }
  }
  if (loading || isLoading) return <p>Loading sign-in...</p>;
  return <div>
    {user ? <button type="button" disabled={pending} onClick={() => { void logout(); }}>Sign out</button> : null}
    {!isAuthenticated && <button type="button" disabled={pending} onClick={() => { void authenticate(); }}>{pending ? 'Redirecting...' : 'Sign in'}</button>}
    {user && !isAuthenticated && <p role="alert">Convex could not authenticate this session. Check the WorkOS deployment configuration, or sign in again.</p>}
    {error && <p role="alert">{error}</p>}
    {!isAuthenticated && <button type="button" onClick={() => window.location.replace('/')}>Reload sign-in</button>}
  </div>;
}
${
  spa
    ? `async function signIn(getSignInUrl: () => Promise<string>) {
  const url = await getSignInUrl();
  if (!url) throw new Error('AuthKit could not initialize. Reload sign-in.');
  window.location.assign(url);
}
`
    : ''
}`;
}
