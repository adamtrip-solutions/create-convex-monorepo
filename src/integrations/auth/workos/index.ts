import type { AuthAdapter, Framework } from '../../../generator/types.js';
import { versions as v } from '../../../templates/versions.js';
import { port } from '../../../templates/apps/shared.js';
import { platform } from '../shared.js';
import { writeWorkosProviders } from './providers.js';
import { workosControls } from './controls.js';

export const workosBindings: Partial<
  Record<Framework, { sdk: string; version: string }>
> = {
  next: { sdk: '@workos-inc/authkit-nextjs', version: v.workosNext },
  vite: { sdk: '@workos-inc/authkit-react', version: v.workosReact },
  'tanstack-start': {
    sdk: '@workos/authkit-tanstack-react-start',
    version: v.workosTanstack,
  },
};

export const workosAdapter: AuthAdapter = {
  id: 'workos',
  label: 'WorkOS AuthKit',
  async apply(ctx) {
    if (ctx.options.example === 'messages')
      await ctx.write(
        'packages/backend/convex/access.ts',
        `import type { QueryCtx, MutationCtx } from './_generated/server';
export async function getOwner(ctx: QueryCtx | MutationCtx): Promise<string> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error('Sign in to access messages.');
  return identity.subject;
}
`,
      );
    await ctx.write(
      'packages/backend/convex/auth.config.ts',
      `import type { AuthConfig } from 'convex/server';
const domain = process.env.WORKOS_AUTHKIT_ISSUER_DOMAIN;
const clientId = process.env.WORKOS_CLIENT_ID;
if (!domain || !clientId) throw new Error('Set WORKOS_AUTHKIT_ISSUER_DOMAIN and WORKOS_CLIENT_ID on this Convex deployment. See the WorkOS setup guide.');
export default { providers: [{ domain, applicationID: clientId }] } satisfies AuthConfig;
`,
    );
    await ctx.write(
      'packages/backend/.env.workos.example',
      `# Set these on the Convex deployment with convex env set, not in frontend env files.
# The WorkOS session JWT template must set aud to this same client ID.
# WORKOS_CLIENT_ID=client_...
# WORKOS_AUTHKIT_ISSUER_DOMAIN=https://api.workos.com/user_management/client_...
`,
    );
    for (const app of ctx.options.apps) {
      const binding = workosBindings[app.framework];
      if (!binding)
        throw new Error(
          `WorkOS AuthKit does not support framework "${app.framework}".`,
        );
      const dir = `apps/${app.name}`;
      const { prefix } = platform(app);
      const server = app.framework !== 'vite';
      await ctx.mergePackage(`${dir}/package.json`, {
        dependencies: {
          [binding.sdk]: binding.version,
          ...(server ? { '@workos-inc/node': v.workosNode } : {}),
        },
      });
      await ctx.write(
        `${dir}/.env.workos.example`,
        `# Append these values to .env.local alongside the Convex URL.
${prefix}_WORKOS_CLIENT_ID=
${
  server
    ? `# The server SDK also reads this public client ID without a prefix. Use the same value.
WORKOS_CLIENT_ID=
# The server SDK reads this name. Cookies are shared across localhost ports.
WORKOS_COOKIE_NAME=wos-session-${app.name}
# Server secrets. Never prefix these with NEXT_PUBLIC_, VITE_ or EXPO_PUBLIC_.
WORKOS_API_KEY=
# Generate at least 32 random characters, for example: openssl rand -base64 32
WORKOS_COOKIE_PASSWORD=
`
    : '# Production SPAs need a custom Authentication API hostname on the same site.\nVITE_WORKOS_API_HOSTNAME=\n'
}${app.framework === 'tanstack-start' ? 'WORKOS_REDIRECT_URI' : `${prefix}_WORKOS_REDIRECT_URI`}=http://localhost:${port(ctx, app)}${server ? '/callback' : '/'}
# Register this redirect URI, /sign-in as the initiate login URI, and this app origin as an allowed sign-out URI in WorkOS.
${server ? '' : '# Add this app origin to WorkOS CORS allowed origins.\n'}`,
      );
      await writeWorkosProviders(ctx, app);
      await ctx.write(`${dir}/src/auth-controls.tsx`, workosControls(app));
      if (app.framework === 'next') {
        await ctx.write(
          `${dir}/src/proxy.ts`,
          `import { authkitProxy } from '@workos-inc/authkit-nextjs';
export default authkitProxy();
export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
`,
        );
        await ctx.write(
          `${dir}/src/app/callback/route.ts`,
          `import { handleAuth } from '@workos-inc/authkit-nextjs';
export const GET = handleAuth({ onError: ({ request }) => Response.redirect(new URL('/?workos_error=callback', request.url)) });
`,
        );
        await ctx.write(
          `${dir}/src/app/sign-in/route.ts`,
          `import { getSignInUrl } from '@workos-inc/authkit-nextjs';
export async function GET(request: Request) {
  try { return Response.redirect(await getSignInUrl()); }
  catch { return Response.redirect(new URL('/?workos_error=sign-in', request.url)); }
}
`,
        );
      }
      if (app.framework === 'tanstack-start') {
        await ctx.write(
          `${dir}/src/start.ts`,
          `import { createStart, createCsrfMiddleware } from '@tanstack/react-start';
import { authkitMiddleware } from '@workos/authkit-tanstack-react-start';
const csrfMiddleware = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' });
export const startInstance = createStart(() => ({ requestMiddleware: [csrfMiddleware, authkitMiddleware()] }));
`,
        );
        await ctx.write(
          `${dir}/src/routes/callback.tsx`,
          `import { createFileRoute } from '@tanstack/react-router';
import { handleCallbackRoute } from '@workos/authkit-tanstack-react-start';
export const Route = createFileRoute('/callback')({ server: { handlers: { GET: handleCallbackRoute({ errorRedirectUrl: '/?workos_error=callback' }) } } });
`,
        );
        await ctx.write(
          `${dir}/src/routes/sign-in.tsx`,
          `import { createFileRoute } from '@tanstack/react-router';
import { getSignInUrl } from '@workos/authkit-tanstack-react-start';
export const Route = createFileRoute('/sign-in')({ server: { handlers: { GET: async ({ request }) => {
  try { return Response.redirect(await getSignInUrl()); }
  catch { return Response.redirect(new URL('/?workos_error=sign-in', request.url)); }
} } } });
`,
        );
      }
    }
  },
};
