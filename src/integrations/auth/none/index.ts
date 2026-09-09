import type { AuthAdapter } from '../../../generator/types.js';
import { writeProviders } from '../shared.js';
export const noneAdapter: AuthAdapter = {
  id: 'none',
  label: 'None',
  async apply(ctx) {
    await ctx.write(
      'packages/backend/convex/access.ts',
      `import type { QueryCtx, MutationCtx } from './_generated/server';
export async function getOwner(_ctx: QueryCtx | MutationCtx): Promise<string | undefined> {
  return undefined;
}
`,
    );
    for (const app of ctx.options.apps) {
      await writeProviders(ctx, app);
      await ctx.write(
        `apps/${app.name}/src/auth-controls.tsx`,
        'export function AuthControls() { return null; }\n',
      );
    }
  },
};
