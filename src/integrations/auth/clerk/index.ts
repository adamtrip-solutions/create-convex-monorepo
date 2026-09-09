import type { AuthAdapter, Framework } from '../../../generator/types.js';
import { versions as v } from '../../../templates/versions.js';
import { platform, writeProviders } from '../shared.js';

const bindings: Record<Framework, { sdk: string; version: string }> = {
  next: { sdk: '@clerk/nextjs', version: v.clerkNext },
  vite: { sdk: '@clerk/react', version: v.clerkReact },
  'tanstack-start': { sdk: '@clerk/tanstack-react-start', version: '1.5.12' },
  expo: { sdk: '@clerk/expo', version: v.clerkExpo },
};

export const clerkAdapter: AuthAdapter = {
  id: 'clerk',
  label: 'Clerk',
  async apply(ctx) {
    if (ctx.options.example === 'messages')
      await ctx.write(
        'packages/backend/convex/access.ts',
        `import type { QueryCtx, MutationCtx } from './_generated/server';
export async function getOwner(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Sign in to access messages.');
  return identity.tokenIdentifier;
}
`,
      );
    await ctx.write(
      'packages/backend/convex/auth.config.ts',
      `import type { AuthConfig } from 'convex/server';
const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (!domain) throw new Error('Set CLERK_JWT_ISSUER_DOMAIN on this Convex deployment. See README.md.');
export default { providers: [{ domain, applicationID: 'convex' }] } satisfies AuthConfig;
`,
    );
    await ctx.write(
      'packages/backend/.env.clerk.example',
      '# Configure this on the Convex deployment with convex env set, not in frontend env files.\n# CLERK_JWT_ISSUER_DOMAIN=https://your-instance.clerk.accounts.dev\n',
    );
    for (const app of ctx.options.apps) {
      const dir = `apps/${app.name}`;
      const binding = bindings[app.framework];
      const { native, prefix } = platform(app);
      await ctx.mergePackage(`${dir}/package.json`, {
        dependencies: {
          [binding.sdk]: binding.version,
          ...(native
            ? {
                'expo-secure-store': '57.0.3',
                'expo-auth-session': '57.0.11',
                'expo-web-browser': '57.0.2',
                'expo-crypto': '57.0.2',
                'expo-constants': '57.0.17',
              }
            : {}),
        },
      });
      await ctx.write(
        `${dir}/.env.clerk.example`,
        `# Append these values to .env.local alongside the Convex URL.\n${prefix}_CLERK_PUBLISHABLE_KEY=\n${app.framework === 'next' || app.framework === 'tanstack-start' ? '# Server only. Never prefix this with NEXT_PUBLIC_, VITE_ or EXPO_PUBLIC_.\nCLERK_SECRET_KEY=\n' : ''}${native ? `# Enable Google OAuth and Native API in Clerk.\n# Register redirect URL: ccm-${ctx.options.name}-${app.name}://continue\n# Build a development client with pnpm ios or pnpm android for this scheme.\n` : ''}`,
      );
      await writeProviders(ctx, app, {
        sdk: binding.sdk,
        ...(native
          ? {
              extraImports:
                "import { tokenCache } from '@clerk/expo/token-cache';",
              providerProps: 'tokenCache={tokenCache}',
            }
          : {}),
      });
      if (app.framework === 'next') {
        await ctx.write(
          `${dir}/src/proxy.ts`,
          `import { clerkMiddleware } from '@clerk/nextjs/server';
export default clerkMiddleware();
export const config = { matcher: ['/((?!_next|[^?]*\\\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)', '/(api|trpc)(.*)'] };
`,
        );
      }
      if (app.framework === 'tanstack-start') {
        await ctx.write(
          `${dir}/src/start.ts`,
          `import { createStart } from '@tanstack/react-start';
import { clerkMiddleware } from '@clerk/tanstack-react-start/server';
export const startInstance = createStart(() => ({ requestMiddleware: [clerkMiddleware()] }));
`,
        );
      }
      if (!native) {
        await ctx.write(
          `${dir}/src/auth-controls.tsx`,
          `'use client';
import { useAuth, SignInButton, UserButton } from '${binding.sdk}';
export function AuthControls() {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p>Loading sign-in…</p>;
  return isSignedIn ? <UserButton /> : <SignInButton mode="modal"><button type="button">Sign in</button></SignInButton>;
}
`,
        );
      } else {
        await ctx.write(
          `${dir}/src/auth-controls.tsx`,
          `import { useState } from 'react';
import { Button, Text, View } from 'react-native';
import { useAuth, useSSO } from '@clerk/expo';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
WebBrowser.maybeCompleteAuthSession();
export function AuthControls() {
  const { isLoaded, isSignedIn, signOut } = useAuth();
  const { startSSOFlow } = useSSO();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function authenticate() {
    setPending(true); setError(null);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({
        strategy: 'oauth_google', redirectUrl: AuthSession.makeRedirectUri({ scheme: 'ccm-${ctx.options.name}-${app.name}', path: 'continue' }),
      });
      if (createdSessionId && setActive) await setActive({ session: createdSessionId });
      else setError('Sign-in was cancelled or requires additional verification.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in failed.'); }
    finally { setPending(false); }
  }
  async function logout() {
    try { await signOut(); } catch { setError('Could not sign out. Try again.'); }
  }
  if (!isLoaded) return <Text>Loading sign-in…</Text>;
  return <View>
    {isSignedIn ? <Button title="Sign out" onPress={() => { void logout(); }} /> : <Button title={pending ? 'Signing in…' : 'Sign in with Google'} disabled={pending} onPress={() => { void authenticate(); }} />}
    {error && <Text accessibilityRole="alert">{error}</Text>}
  </View>;
}
`,
        );
      }
    }
  },
};
