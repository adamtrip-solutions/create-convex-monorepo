import { readdir, readFile } from 'node:fs/promises';
import type { GeneratorContext } from '../../generator/types.js';
import { versions as v } from '../versions.js';

export async function generateBackend(ctx: GeneratorContext): Promise<void> {
  const base = 'packages/backend';
  await ctx.json(`${base}/package.json`, {
    name: `@${ctx.scope}/backend`,
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: {
      './api': {
        types: './convex/_generated/api.d.ts',
        default: './convex/_generated/api.js',
      },
      './dataModel': { types: './convex/_generated/dataModel.d.ts' },
    },
    scripts: {
      dev: 'convex dev',
      codegen: 'convex codegen',
      typecheck: 'tsc --noEmit -p convex/tsconfig.json',
      build: 'tsc --noEmit -p convex/tsconfig.json',
      lint: 'eslint .',
    },
    dependencies: { convex: v.convex },
    devDependencies: {
      typescript: v.typescript,
      '@types/node': '24.12.2',
      eslint: v.eslint,
      [`@${ctx.scope}/eslint-config`]: 'workspace:*',
      [`@${ctx.scope}/typescript-config`]: 'workspace:*',
    },
  });
  await ctx.json(`${base}/convex.json`, {
    $schema: './node_modules/convex/schemas/convex.schema.json',
    aiFiles: { enabled: false },
  });
  await ctx.json(`${base}/tsconfig.json`, {
    extends: './convex/tsconfig.json',
    include: ['convex/**/*.ts'],
  });
  await ctx.write(
    `${base}/eslint.config.js`,
    `export { default } from '@${ctx.scope}/eslint-config';\n`,
  );
  await ctx.write(
    `${base}/.env.example`,
    "# Run pnpm convex:setup from the workspace root.\n# Convex writes deployment selection and public URLs to this package's .env.local.\n# Never copy this file wholesale into an application.\n",
  );
  const assetDir = new URL('../../../assets/backend/convex/', import.meta.url);
  const assetName = `backend${ctx.options.example === 'none' ? '-blank' : ''}${ctx.options.auth === 'convex-auth' ? '-convex-auth' : ''}`;
  const selectedAssets = new URL(
    `../../../assets/${assetName}/convex/`,
    import.meta.url,
  );
  const files =
    ctx.options.example === 'none'
      ? ['schema.ts', 'tsconfig.json']
      : ['schema.ts', 'messages.ts', 'tsconfig.json'];
  for (const file of files) {
    await ctx.write(
      `${base}/convex/${file}`,
      await readFile(
        new URL(file, file === 'tsconfig.json' ? assetDir : selectedAssets),
        'utf8',
      ),
    );
  }
  const generated = new URL('_generated/', selectedAssets);
  for (const file of await readdir(generated)) {
    await ctx.write(
      `${base}/convex/_generated/${file}`,
      await readFile(new URL(file, generated), 'utf8'),
    );
  }
}
