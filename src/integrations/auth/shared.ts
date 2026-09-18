import type { AppSpec, GeneratorContext } from '../../generator/types.js';

export function platform(app: AppSpec) {
  const native = app.framework === 'expo';
  const prefix =
    app.framework === 'next' ? 'NEXT_PUBLIC' : native ? 'EXPO_PUBLIC' : 'VITE';
  const env = (name: string) =>
    `${prefix === 'VITE' ? 'import.meta.env' : 'process.env'}.${prefix}_${name}`;
  return { native, prefix, env };
}

export async function writeProviders(
  ctx: GeneratorContext,
  app: AppSpec,
  auth?: {
    sdk: string;
    extraImports?: string;
    providerProps?: string;
  },
): Promise<void> {
  const { native, env } = platform(app);
  const routeAuth = !!auth && app.framework === 'react-router';
  await writeRouteAuth(ctx, app, !!auth);
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
    ? `import { ClerkProvider, useAuth } from '${auth.sdk}';
import { ConvexProviderWithClerk } from 'convex/react-clerk';
import { AuthControls } from './auth-controls';
${auth.extraImports ?? ''}
${routeAuth ? "import { useRouteLoaderData } from 'react-router';\nimport type { loader } from './auth.server';" : ''}`
    : ''
}

export function Providers({ children }: { children: ReactNode }) {
  ${routeAuth ? "const loaderData = useRouteLoaderData<typeof loader>('root');" : ''}
  const url = ${env('CONVEX_URL')};
  ${auth ? `const publishableKey = ${env('CLERK_PUBLISHABLE_KEY')};` : ''}
  if (!url) return ${text(`Set ${platform(app).prefix}_CONVEX_URL in this app's .env.local.`)};
  ${auth ? `if (!publishableKey) return ${text(`Set ${platform(app).prefix}_CLERK_PUBLISHABLE_KEY in this app's .env.local.`)};` : ''}
  return ${auth ? `<ClerkProvider publishableKey={publishableKey} ${routeAuth ? 'loaderData={loaderData}' : ''} ${auth.providerProps ?? ''}>` : ''}<Connection url={url}>{children}</Connection>${auth ? '</ClerkProvider>' : ''};
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

/** Auth adapters supply the root route's server hooks without moving shared client files. */
export async function writeRouteAuth(
  ctx: GeneratorContext,
  app: AppSpec,
  clerk = false,
): Promise<void> {
  if (app.framework !== 'react-router') return;
  await ctx.write(
    `apps/${app.name}/src/auth.server.ts`,
    clerk
      ? `import { clerkMiddleware, rootAuthLoader } from '@clerk/react-router/server';
import type { Route } from '../app/+types/root';
export const middleware: Route.MiddlewareFunction[] = [clerkMiddleware()];
export function loader(args: Route.LoaderArgs) {
  return rootAuthLoader(args);
}
`
      : `import type { Route } from '../app/+types/root';
export const middleware: Route.MiddlewareFunction[] = [];
export function loader() { return null; }
`,
  );
}
