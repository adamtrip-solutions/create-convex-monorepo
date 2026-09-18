import type { AppSpec, GeneratorContext } from '../../../generator/types.js';
import { platform, writeRouteAuth } from '../shared.js';

export async function writeBetterAuthProviders(
  ctx: GeneratorContext,
  app: AppSpec,
): Promise<void> {
  const { native, prefix, env } = platform(app);
  await writeRouteAuth(ctx, app);
  const text = (value: string) =>
    native ? `<Text>${value}</Text>` : `<p>${value}</p>`;
  await ctx.write(
    `apps/${app.name}/src/auth-client.ts`,
    `'use client';
import { createContext, useContext } from 'react';
import { createAuthClient } from 'better-auth/react';
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
${
  native
    ? `import { expoClient } from '@better-auth/expo/client';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';`
    : ''
}

export function createAppAuthClient(siteUrl: string) {
  return createAuthClient({
    baseURL: siteUrl,
    plugins: [convexClient(), ${
      native
        ? `...(Platform.OS === 'web' ? [crossDomainClient()] : [expoClient({
      scheme: 'ccm-${ctx.options.name}-${app.name}',
      storagePrefix: 'ccm-${ctx.options.name}-${app.name}',
      storage: SecureStore,
    })])`
        : 'crossDomainClient()'
    }],
  });
}
export const AuthClientContext = createContext<ReturnType<typeof createAppAuthClient> | null>(null);
export function useAuthClient() {
  const client = useContext(AuthClientContext);
  if (!client) throw new Error('AuthControls must be inside Providers.');
  return client;
}
`,
  );
  await ctx.write(
    `apps/${app.name}/src/providers.tsx`,
    `'use client';
import { useState, type ReactNode } from 'react';
import { ConvexReactClient, Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { ConvexBetterAuthProvider } from '@convex-dev/better-auth/react';
import { createAppAuthClient, AuthClientContext } from './auth-client';
import { AuthControls } from './auth-controls';
${native ? "import { Text, View } from 'react-native';" : ''}

export function Providers({ children }: { children: ReactNode }) {
  const url = ${env('CONVEX_URL')};
  const siteUrl = ${env('CONVEX_SITE_URL')};
  if (!url) return ${text(`Set ${prefix}_CONVEX_URL in this app's .env.local.`)};
  if (!siteUrl) return ${text(`Set ${prefix}_CONVEX_SITE_URL in this app's .env.local.`)};
  return <Connection url={url} siteUrl={siteUrl}>{children}</Connection>;
}
function Connection({ url, siteUrl, children }: { url: string; siteUrl: string; children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url${native ? ', { unsavedChangesWarning: false }' : ''}));
  const [authClient] = useState(() => createAppAuthClient(siteUrl));
  return <AuthClientContext.Provider value={authClient}>
    <ConvexBetterAuthProvider client={client} authClient={authClient}>
      <AuthLoading>${text('Connecting authentication…')}</AuthLoading>
      <Unauthenticated><AuthControls /></Unauthenticated>
      <Authenticated>${native ? '<View style={{ flex: 1, padding: 24, paddingTop: 64 }}>' : ''}{children}${native ? '</View>' : ''}</Authenticated>
    </ConvexBetterAuthProvider>
  </AuthClientContext.Provider>;
}
`,
  );
}
