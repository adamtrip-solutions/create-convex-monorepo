import type { AppSpec, GeneratorContext } from '../../../generator/types.js';
import { platform } from '../shared.js';

export async function writeConvexAuthProviders(
  ctx: GeneratorContext,
  app: AppSpec,
): Promise<void> {
  const { native, prefix, env } = platform(app);
  const text = (value: string) =>
    native ? `<Text>${value}</Text>` : `<p>${value}</p>`;
  await ctx.write(
    `apps/${app.name}/src/providers.tsx`,
    `'use client';
import { useState, type ReactNode } from 'react';
import { ConvexReactClient, Authenticated, Unauthenticated, AuthLoading } from 'convex/react';
import { ConvexAuthProvider } from '@convex-dev/auth/react';
import { AuthControls } from './auth-controls';
${
  native
    ? `import { Platform, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
const secureStorage = {
  getItem: SecureStore.getItemAsync,
  setItem: SecureStore.setItemAsync,
  removeItem: SecureStore.deleteItemAsync,
};`
    : ''
}

export function Providers({ children }: { children: ReactNode }) {
  const url = ${env('CONVEX_URL')};
  if (!url) return ${text(`Set ${prefix}_CONVEX_URL in this app's .env.local.`)};
  return <Connection url={url}>{children}</Connection>;
}
function Connection({ url, children }: { url: string; children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url${native ? ', { unsavedChangesWarning: false }' : ''}));
  return <ConvexAuthProvider client={client}${native ? ' storage={Platform.OS === "android" || Platform.OS === "ios" ? secureStorage : undefined}' : ''}>
    <AuthLoading>${text('Connecting authentication…')}</AuthLoading>
    <Unauthenticated><AuthControls /></Unauthenticated>
    <Authenticated>${native ? '<View style={{ flex: 1, padding: 24, paddingTop: 64 }}>' : ''}{children}${native ? '</View>' : ''}</Authenticated>
  </ConvexAuthProvider>;
}
`,
  );
}
