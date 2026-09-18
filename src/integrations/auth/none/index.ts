import type { AuthAdapter } from '../../../generator/types.js';
import { uiRuntime, writeProviders } from '../shared.js';
export const noneAdapter: AuthAdapter = {
  id: 'none',
  label: 'None',
  supportedRuntimes: ['react', 'svelte'],
  async apply(ctx) {
    if (ctx.options.example === 'messages')
      await ctx.write(
        'packages/backend/convex/access.ts',
        `import type { QueryCtx, MutationCtx } from './_generated/server';
export async function getOwner(_ctx: QueryCtx | MutationCtx): Promise<string | undefined> {
  return undefined;
}
`,
      );
    for (const app of ctx.options.apps) {
      if (app.framework === 'astro')
        await ctx.write(
          `apps/${app.name}/auth.config.mjs`,
          'export default [];\n',
        );
      await writeProviders(ctx, app);
      if (uiRuntime(app.framework) === 'svelte') {
        await ctx.write(
          `apps/${app.name}/src/AuthControls.svelte`,
          '<!-- No authentication controls for --auth none. -->\n',
        );
        continue;
      }
      await ctx.write(
        `apps/${app.name}/src/auth-controls.tsx`,
        'export function AuthControls() { return null; }\n',
      );
    }
  },
};
