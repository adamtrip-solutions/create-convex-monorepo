import type { AuthAdapter } from '../../../generator/types.js';
import { versions as v } from '../../../templates/versions.js';
import { platform } from '../shared.js';
import { writeConvexAuthProviders } from './providers.js';
import { authControls } from './controls.js';

export const convexAuthAdapter: AuthAdapter = {
  id: 'convex-auth',
  label: 'Convex Auth',
  async apply(ctx) {
    await ctx.mergePackage('packages/backend/package.json', {
      dependencies: {
        '@convex-dev/auth': v.convexAuth,
        '@auth/core': v.authCore,
      },
    });
    await ctx.write(
      'packages/backend/convex/auth.ts',
      `import { convexAuth } from '@convex-dev/auth/server';
import { Password } from '@convex-dev/auth/providers/Password';
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [Password] });
`,
    );
    await ctx.write(
      'packages/backend/convex/http.ts',
      `import { httpRouter } from 'convex/server';
import { auth } from './auth';
const http = httpRouter();
auth.addHttpRoutes(http);
export default http;
`,
    );
    await ctx.write(
      'packages/backend/convex/auth.config.ts',
      `export default {
  providers: [{ domain: process.env.CONVEX_SITE_URL, applicationID: 'convex' }],
};
`,
    );
    if (ctx.options.example === 'messages') {
      await ctx.write(
        'packages/backend/convex/access.ts',
        `import { getAuthUserId } from '@convex-dev/auth/server';
import type { QueryCtx, MutationCtx } from './_generated/server';
export async function getOwner(ctx: QueryCtx | MutationCtx): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error('Sign in to access messages.');
  return userId;
}
`,
      );
    }
    await ctx.write(
      'packages/backend/.env.convex-auth.example',
      `# Run pnpm convex:setup, then pnpm convex:auth-keys to set the signing keys.
# Use pnpm convex:auth-keys --prod for production. The script never stores keys locally.
# Never put JWT_PRIVATE_KEY, JWKS, or SITE_URL in frontend env files.
# JWT_PRIVATE_KEY and JWKS are required for sign-in. See README.md for setup.
# JWT_PRIVATE_KEY=<generated RSA private key>
# JWKS=<generated public JSON Web Key Set>
# SITE_URL=http://localhost:3000
# SITE_URL is optional for Password-only sign-in; it is used for OAuth and email redirects.
# CONVEX_SITE_URL is supplied by Convex and used by convex/auth.config.ts.
`,
    );
    for (const app of ctx.options.apps) {
      const { native } = platform(app);
      await ctx.mergePackage(`apps/${app.name}/package.json`, {
        dependencies: {
          '@convex-dev/auth': v.convexAuth,
          ...(native ? { 'expo-secure-store': '57.0.3' } : {}),
        },
      });
      await writeConvexAuthProviders(ctx, app);
      await ctx.write(
        `apps/${app.name}/src/auth-controls.tsx`,
        authControls(native),
      );
    }
  },
};
