import type { AppSpec, GeneratorContext } from '../../../generator/types.js';
import { platform } from '../shared.js';

export function clientSdk(app: AppSpec): string {
  return app.framework === 'next'
    ? '@workos-inc/authkit-nextjs/components'
    : app.framework === 'tanstack-start'
      ? '@workos/authkit-tanstack-react-start/client'
      : '@workos-inc/authkit-react';
}

export async function writeWorkosProviders(
  ctx: GeneratorContext,
  app: AppSpec,
) {
  const spa = app.framework === 'vite';
  const { env, prefix } = platform(app);
  await ctx.write(
    `apps/${app.name}/src/providers.tsx`,
    `'use client';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ConvexReactClient, ConvexProviderWithAuth, Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { AuthKitProvider, useAuth${spa ? '' : ', useAccessToken'} } from '${clientSdk(app)}';
import { AuthControls } from './auth-controls';

export function Providers({ children }: { children: ReactNode }) {
  const url = ${env('CONVEX_URL')};
  const clientId = ${env('WORKOS_CLIENT_ID')};
  if (!url) return <p>Set ${prefix}_CONVEX_URL in this app's .env.local.</p>;
  if (!clientId) return <p>Set ${prefix}_WORKOS_CLIENT_ID in this app's .env.local.</p>;
  ${
    spa
      ? `const redirectUri = ${env('WORKOS_REDIRECT_URI')};
  if (!redirectUri) return <p>Set ${prefix}_WORKOS_REDIRECT_URI in this app's .env.local.</p>;`
      : ''
  }
  return <AuthKitProvider${spa ? ' clientId={clientId} redirectUri={redirectUri} apiHostname={import.meta.env.VITE_WORKOS_API_HOSTNAME || undefined}' : ''}><Connection url={url}>{children}</Connection></AuthKitProvider>;
}
function Connection({ url, children }: { url: string; children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url));
  return <ConvexProviderWithAuth client={client} useAuth={useAuthFromAuthKit}>
    <AuthLoading><p>Connecting authentication...</p></AuthLoading>
    <Unauthenticated><AuthControls /></Unauthenticated>
    <Authenticated>{children}</Authenticated>
  </ConvexProviderWithAuth>;
}
function useAuthFromAuthKit() {
  const { user, ${spa ? 'isLoading, getAccessToken' : 'loading: isLoading'} } = useAuth();
  ${spa ? '' : 'const { getAccessToken, refresh } = useAccessToken();'}
  const fetchAccessToken = useCallback(async ({ forceRefreshToken }: { forceRefreshToken: boolean }): Promise<string | null> => {
    if (!user) return null;
    try {
      return ${spa ? '(await getAccessToken({ forceRefresh: forceRefreshToken }))' : '(await (forceRefreshToken ? refresh() : getAccessToken()))'} ?? null;
    } catch {
      // Convex marks the session unauthenticated; AuthControls offers sign-in again.
      return null;
    }
  }, [user, getAccessToken${spa ? '' : ', refresh'}]);
  return useMemo(() => ({ isLoading, isAuthenticated: !!user, fetchAccessToken }), [isLoading, user, fetchAccessToken]);
}
`,
  );
}
