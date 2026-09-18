import type { AuthAdapter, ProjectOptions } from '../../../generator/types.js';
import { scriptCommand } from '../../../package-manager/index.js';
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
      convexAuthConfig(ctx.options),
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
      `# Run ${scriptCommand(ctx.options.packageManager, 'convex:setup')}, then ${scriptCommand(ctx.options.packageManager, 'convex:auth-keys')} to set the signing keys.
# Use ${scriptCommand(ctx.options.packageManager, 'convex:auth-keys')} --prod for production. The script never stores keys locally.
# Never put JWT_PRIVATE_KEY, JWKS, or SITE_URL in frontend env files.
# JWT_PRIVATE_KEY and JWKS are required for sign-in. See README.md for setup.
# JWT_PRIVATE_KEY=<generated RSA private key>
# JWKS=<generated public JSON Web Key Set>
# SITE_URL=http://localhost:3000
${ctx.options.oauth?.length ? `# SITE_URL is required for OAuth. Run ${scriptCommand(ctx.options.packageManager, 'convex:auth-site')} <site-url>.\n${ctx.options.oauth.map((provider) => `# AUTH_${provider.toUpperCase()}_ID=<client ID>\n# AUTH_${provider.toUpperCase()}_SECRET=<client secret>`).join('\n')}\n# Set OAuth credentials only on the Convex deployment, never in frontend env files.` : '# SITE_URL is optional for Password-only sign-in; it is used for OAuth and email redirects.'}
# CONVEX_SITE_URL is supplied by Convex and used by convex/auth.config.ts.
`,
    );
    for (const app of ctx.options.apps) {
      const { native } = platform(app);
      await ctx.mergePackage(`apps/${app.name}/package.json`, {
        dependencies: {
          '@convex-dev/auth': v.convexAuth,
          ...(native ? { 'expo-secure-store': '57.0.3' } : {}),
          ...(native && ctx.options.oauth?.length
            ? {
                'expo-web-browser': v.expoWebBrowser,
                'expo-linking': v.expoLinking,
              }
            : {}),
        },
      });
      await writeConvexAuthProviders(ctx, app);
      await ctx.write(
        `apps/${app.name}/src/auth-controls.tsx`,
        authControls(
          native,
          ctx.options.oauth,
          `ccm-${ctx.options.name}-${app.name}`,
        ),
      );
    }
  },
};

export function convexAuthConfig(options: ProjectOptions): string {
  const oauth = options.oauth ?? [];
  if (!oauth.length)
    return `import { convexAuth } from '@convex-dev/auth/server';
import { Password } from '@convex-dev/auth/providers/Password';
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({ providers: [Password] });
`;
  const nativeRedirects = options.apps
    .filter((app) => app.framework === 'expo')
    .map((app) => `ccm-${options.name}-${app.name}://auth`);
  return `import { convexAuth } from '@convex-dev/auth/server';
import { Password } from '@convex-dev/auth/providers/Password';
${oauth.map((provider) => `import ${provider === 'github' ? 'GitHub' : 'Google'} from '@auth/core/providers/${provider}';`).join('\n')}
export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password${oauth.map((provider) => `, ${provider === 'github' ? 'GitHub' : 'Google'}`).join('')}],
  ${
    oauth.length && nativeRedirects.length
      ? `callbacks: {
    async redirect({ redirectTo }) {
      // Only these native return URLs and the configured web origin are allowed.
      const siteUrl = process.env.SITE_URL;
      if (!siteUrl) throw new Error('Set SITE_URL on the Convex deployment.');
      if (${JSON.stringify(nativeRedirects)}.includes(redirectTo)) return redirectTo;
      const target = new URL(redirectTo, siteUrl);
      if (target.origin === new URL(siteUrl).origin && ['http:', 'https:'].includes(target.protocol)) return target.toString();
      throw new Error('Invalid OAuth redirect destination.');
    },
  },`
      : ''
  }
});
`;
}
