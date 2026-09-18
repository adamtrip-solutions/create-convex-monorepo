import type { AppSpec, GeneratorContext } from '../../generator/types.js';

export function platform(app: AppSpec) {
  const native = app.framework === 'expo';
  const prefix =
    app.framework === 'next'
      ? 'NEXT_PUBLIC'
      : native
        ? 'EXPO_PUBLIC'
        : app.framework === 'astro'
          ? 'PUBLIC'
          : 'VITE';
  const env = (name: string) =>
    `${prefix === 'VITE' || prefix === 'PUBLIC' ? 'import.meta.env' : 'process.env'}.${prefix}_${name}`;
  return { native, prefix, env };
}

export async function writeProviders(
  ctx: GeneratorContext,
  app: AppSpec,
  auth?: {
    sdk: string;
    integrationManaged?: boolean;
    extraImports?: string;
    providerProps?: string;
  },
): Promise<void> {
  const { native, env } = platform(app);
  const text = (message: string) =>
    native ? `<Text>${message}</Text>` : `<p>${message}</p>`;
  await ctx.write(
    `apps/${app.name}/src/providers.tsx`,
    `'use client';
import { useState, type ReactNode } from 'react';
import { ConvexReactClient, ${auth ? 'Authenticated, Unauthenticated, AuthLoading' : 'ConvexProvider'} } from 'convex/react';
${native ? "import { Text, View } from 'react-native';" : ''}
${
  auth
    ? `import { ${auth.integrationManaged ? '' : 'ClerkProvider, '}useAuth } from '${auth.sdk}';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { AuthControls } from './auth-controls';
${auth.extraImports ?? ''}`
    : ''
}

export function Providers({ children }: { children: ReactNode }) {
  const url = ${env('CONVEX_URL')};
  ${auth ? `const publishableKey = ${env('CLERK_PUBLISHABLE_KEY')};` : ''}
  if (!url) return ${text(`Set ${platform(app).prefix}_CONVEX_URL in this app's .env.local.`)};
  ${auth ? `if (!publishableKey) return ${text(`Set ${platform(app).prefix}_CLERK_PUBLISHABLE_KEY in this app's .env.local.`)};` : ''}
  return ${auth && !auth.integrationManaged ? `<ClerkProvider publishableKey={publishableKey} ${auth.providerProps ?? ''}>` : ''}<Connection url={url}>{children}</Connection>${auth && !auth.integrationManaged ? '</ClerkProvider>' : ''};
}
function Connection({ url, children }: { url: string; children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(url${native ? ', { unsavedChangesWarning: false }' : ''}));
  return ${
    auth
      ? `<ConvexProviderWithClerk client={client} useAuth={useAuth}>
    <AuthLoading>${text('Connecting authentication…')}</AuthLoading>
    <Unauthenticated><AuthControls /></Unauthenticated>
    <Authenticated>${native ? '<View style={{ flex: 1, padding: 24, paddingTop: 64 }}>' : ''}{children}${native ? '</View>' : ''}</Authenticated>
  </ConvexProviderWithClerk>`
      : `<ConvexProvider client={client}>${native ? '<View style={{ flex: 1, padding: 24, paddingTop: 64 }}>' : ''}{children}${native ? '</View>' : ''}</ConvexProvider>`
  };
}
`,
  );
}
