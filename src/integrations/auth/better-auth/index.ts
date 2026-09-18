import type { AuthAdapter } from '../../../generator/types.js';
import { versions as v } from '../../../templates/versions.js';
import { scriptCommand } from '../../../package-manager/index.js';
import { platform } from '../shared.js';
import { writeBetterAuthProviders } from './providers.js';
import { authControls } from './controls.js';

export const betterAuthAdapter: AuthAdapter = {
  id: 'better-auth',
  label: 'Better Auth',
  async apply(ctx) {
    await ctx.mergePackage('packages/backend/package.json', {
      dependencies: {
        '@convex-dev/better-auth': v.convexBetterAuth,
        'better-auth': v.betterAuth,
        '@better-auth/expo': v.betterAuthExpo,
        '@better-auth/core': v.betterAuth,
      },
    });
    await ctx.write(
      'packages/backend/convex/convex.config.ts',
      `import { defineApp } from 'convex/server';
import betterAuth from '@convex-dev/better-auth/convex.config';
const app = defineApp();
app.use(betterAuth);
export default app;
`,
    );
    await ctx.write(
      'packages/backend/convex/auth.config.ts',
      `import { getAuthConfigProvider } from '@convex-dev/better-auth/auth-config';
import type { AuthConfig } from 'convex/server';
export default { providers: [getAuthConfigProvider()] } satisfies AuthConfig;
`,
    );
    await ctx.write(
      'packages/backend/convex/auth.ts',
      `import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import { expo } from '@better-auth/expo';
import { betterAuth } from 'better-auth/minimal';
import { components } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { query } from './_generated/server';
import authConfig from './auth.config';

export const authComponent = createClient<DataModel>(components.betterAuth);

export const createAuth = (ctx: GenericCtx<DataModel>) => {
  const siteUrl = process.env.SITE_URL!;
  const trustedOrigins: string = process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? '';
  return betterAuth({
    baseURL: process.env.CONVEX_SITE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    database: authComponent.adapter(ctx),
    trustedOrigins: [siteUrl, ...trustedOrigins.split(',').map((origin) => origin.trim()).filter(Boolean)],
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [expo(), convex({ authConfig }), crossDomain({ siteUrl })],
  });
};

export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => authComponent.getAuthUser(ctx),
});
`,
    );
    await ctx.write(
      'packages/backend/convex/http.ts',
      `import { httpRouter } from 'convex/server';
import { authComponent, createAuth } from './auth';
const http = httpRouter();
authComponent.registerRoutes(http, createAuth, { cors: true });
export default http;
`,
    );
    if (ctx.options.example === 'messages') {
      await ctx.write(
        'packages/backend/convex/access.ts',
        `import { authComponent } from './auth';
import type { QueryCtx, MutationCtx } from './_generated/server';
export async function getOwner(ctx: QueryCtx | MutationCtx): Promise<string> {
  const user = await authComponent.getAuthUser(ctx);
  return user._id;
}
`,
      );
    }
    await ctx.write(
      'packages/backend/.env.better-auth.example',
      `# Set deployment variables with ${scriptCommand(ctx.options.packageManager, 'convex:better-auth-env')} --site-url http://localhost:3000.
# Required deployment settings: BETTER_AUTH_SECRET and SITE_URL.
# BETTER_AUTH_TRUSTED_ORIGINS is a comma-separated list of additional app origins and native schemes.
# CONVEX_SITE_URL is supplied by Convex. Never copy BETTER_AUTH_SECRET into a frontend.
`,
    );
    for (const app of ctx.options.apps) {
      if (app.framework === 'astro')
        await ctx.write(
          `apps/${app.name}/auth.config.mjs`,
          'export default [];\n',
        );
      const { native, prefix } = platform(app);
      await ctx.mergePackage(`apps/${app.name}/package.json`, {
        dependencies: {
          '@convex-dev/better-auth': v.convexBetterAuth,
          'better-auth': v.betterAuth,
          ...(native
            ? {
                '@better-auth/expo': v.betterAuthExpo,
                '@better-auth/core': v.betterAuth,
                'expo-secure-store': v.expoSecureStore,
                'expo-network': v.expoNetwork,
                'expo-linking': v.expoLinking,
                'expo-web-browser': v.expoWebBrowser,
                'expo-constants': v.expoConstants,
              }
            : {}),
        },
      });
      await ctx.write(
        `apps/${app.name}/.env.better-auth.example`,
        `# Append to .env.local alongside ${prefix}_CONVEX_URL.
# HTTP action URL from the Convex dashboard, usually https://<deployment>.convex.site.
# For local or self-hosted deployments, use the actual HTTP action origin.
${prefix}_CONVEX_SITE_URL=
${native ? `# Add ccm-${ctx.options.name}-${app.name}:// to BETTER_AUTH_TRUSTED_ORIGINS on the deployment.\n` : ''}`,
      );
      await writeBetterAuthProviders(ctx, app);
      await ctx.write(
        `apps/${app.name}/src/auth-controls.tsx`,
        authControls(native),
      );
    }
  },
};
