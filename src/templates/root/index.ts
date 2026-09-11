import { readFile } from 'node:fs/promises';
import type { GeneratorContext } from '../../generator/types.js';
import { getPackageVersion } from '../../version.js';
import { versions as v } from '../versions.js';
import { formattingOptions } from '../../generator/format.js';

export async function generateRoot(ctx: GeneratorContext): Promise<void> {
  const { options, scope } = ctx;
  await ctx.write(
    'scripts/convex-setup.mjs',
    await readFile(
      new URL('../../../assets/setup/convex-setup.mjs', import.meta.url),
      'utf8',
    ),
  );
  const scripts: Record<string, string> = {
    dev: `turbo run dev --ui=stream --concurrency=${options.apps.length + 2}`,
    'convex:dev': `pnpm --filter @${scope}/backend dev`,
    'convex:setup': 'node scripts/convex-setup.mjs',
    'convex:link': 'node scripts/convex-setup.mjs --link-only',
    build: 'turbo run build',
    typecheck: 'turbo run typecheck',
    lint: 'turbo run lint',
    format: 'prettier --write .',
    'format:check': 'prettier --check .',
  };
  for (const app of options.apps)
    scripts[`dev:${app.name}`] = `pnpm --filter @${scope}/${app.name} dev`;
  await ctx.json('package.json', {
    name: options.name,
    private: true,
    version: '0.0.0',
    type: 'module',
    packageManager: `pnpm@${v.pnpm}`,
    engines: { node: '>=22.12.0' },
    scripts,
    devDependencies: { turbo: v.turbo, prettier: v.prettier },
  });
  await ctx.json('.prettierrc.json', formattingOptions);
  await ctx.write(
    '.prettierignore',
    'node_modules/\n**/_generated/\n**/routeTree.gen.ts\n**/.next/\n**/.expo/\n**/.output/\n**/dist/\n**/.turbo/\npnpm-lock.yaml\n.env*\n**/.env*\n',
  );
  await ctx.write(
    'pnpm-workspace.yaml',
    "packages:\n  - 'apps/*'\n  - 'packages/*'\n\nonlyBuiltDependencies:\n  - esbuild\n  - sharp\n  - unrs-resolver\n",
  );
  await ctx.json('turbo.json', {
    $schema: 'https://turborepo.com/schema.json',
    tasks: {
      dev: {
        cache: false,
        persistent: true,
        passThroughEnv: [
          'CONVEX_*',
          'CLERK_*',
          'NEXT_PUBLIC_*',
          'VITE_*',
          'EXPO_PUBLIC_*',
        ],
      },
      build: {
        dependsOn: ['^build'],
        inputs: ['$TURBO_DEFAULT$', '.env*'],
        outputs: ['.next/**', '!.next/cache/**', 'dist/**', '.output/**'],
        env: ['NEXT_PUBLIC_*', 'VITE_*', 'EXPO_PUBLIC_*'],
        passThroughEnv: ['CLERK_SECRET_KEY'],
      },
      [`@${scope}/backend#build`]: { outputs: [] },
      typecheck: { dependsOn: ['^typecheck'], outputs: [] },
      lint: { dependsOn: ['^lint'], outputs: [] },
    },
  });
  await ctx.write(
    '.gitignore',
    'node_modules/\n.turbo/\n.next/\n.output/\ndist/\n.expo/\n.env*\n!.env.example\n!.env.clerk.example\n*.tsbuildinfo\n.DS_Store\n.convex/\n',
  );
  await ctx.json('convex-monorepo.json', {
    version: 1,
    generator: await getPackageVersion(),
    name: options.name,
    packageManager: options.packageManager,
    monorepo: 'turbo',
    apps: options.apps,
    auth: options.auth,
    example: options.example,
  });
  await ctx.json('packages/typescript-config/package.json', {
    name: `@${scope}/typescript-config`,
    private: true,
    version: '0.0.0',
    exports: { './base.json': './base.json' },
  });
  await ctx.json('packages/typescript-config/base.json', {
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      moduleResolution: 'Bundler',
      strict: true,
      noEmit: true,
      isolatedModules: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      jsx: 'react-jsx',
      allowJs: true,
      forceConsistentCasingInFileNames: true,
    },
  });
  await ctx.json('packages/eslint-config/package.json', {
    name: `@${scope}/eslint-config`,
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { '.': './index.js' },
    dependencies: { 'typescript-eslint': v.typescriptEslint },
    peerDependencies: { eslint: `^${v.eslint}` },
  });
  await ctx.write(
    'packages/eslint-config/index.js',
    `import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/_generated/**', '**/routeTree.gen.ts', '**/node_modules/**', '**/dist/**', '**/.next/**', '**/.expo/**', '**/.output/**'] },
  ...tseslint.configs.recommended,
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }] } },
);
`,
  );
  const envTable = options.apps
    .map(
      (app) =>
        `| ${app.name} | ${app.framework === 'next' ? 'NEXT_PUBLIC' : app.framework === 'expo' ? 'EXPO_PUBLIC' : 'VITE'}_CONVEX_URL |`,
    )
    .join('\n');
  await ctx.write(
    'README.md',
    `# ${options.name}

${options.apps.map((a) => a.framework).join(', ')} applications share one Convex backend in packages/backend.

## First run

Use Node 22.12+ and pnpm ${v.pnpm}.

\`\`\`sh
pnpm install
pnpm convex:setup
\`\`\`

The setup command runs Convex in its own package and asks you to select or create a deployment. After a successful push, it copies only CONVEX_URL from packages/backend/.env.local into each app's .env.local using the public variable below. Other settings are preserved. If initialization ran during generation, you can go straight to pnpm dev. Keep backend environment files private. Run pnpm convex:link to refresh frontend URLs after switching deployments; restart the apps after linking. Use a cloud development deployment for physical phones; localhost on a phone is the phone itself.

| Application | Public URL variable |
| --- | --- |
${envTable}

${
  options.auth === 'clerk'
    ? `## Clerk setup

Use one Clerk application across all frontends. Create a JWT template named convex using Clerk's Convex preset. Set the issuer on the Convex deployment before the first setup push:

\`\`\`sh
pnpm --filter @${scope}/backend exec convex env set CLERK_JWT_ISSUER_DOMAIN https://your-instance.clerk.accounts.dev
\`\`\`

On a new deployment, run pnpm convex:setup to select it. If the first push asks for CLERK_JWT_ISSUER_DOMAIN, set it in another terminal with the command above and rerun setup. Repeat this for production. Append each app's .env.clerk.example to its .env.local. These files name publishable keys and any server-only secrets. Never put CLERK_SECRET_KEY in a VITE_, EXPO_PUBLIC_ or NEXT_PUBLIC_ variable.

Expo uses Google OAuth. Enable Google's connection and the Native API in Clerk. Register each mobile scheme redirect listed in that app's .env.clerk.example in Clerk Native applications. Use a development build for a stable app scheme. SecureStore persists the token. Additional MFA or session tasks need a custom flow before production rollout.

${options.example === 'messages' ? 'The backend checks identity and uses an owner index to keep messages private. All frontends share the same identity and messages when signed into the same account.' : 'Clerk is configured, but there are no backend functions yet. Check ctx.auth.getUserIdentity() and enforce authorization in each protected function you add.'}
`
    : options.example === 'none'
      ? `No example tables or functions are included. Add tables to packages/backend/convex/schema.ts and functions to that directory, then run pnpm convex:dev to regenerate the shared API.\n`
      : `The unauthenticated example is a public message board. Anyone with the deployment URL can read and send messages. Add authentication and abuse controls before exposing sensitive data.
`
}
## Development

\`\`\`sh
pnpm dev
${options.apps.map((a) => `pnpm dev:${a.name}`).join('\n')}
pnpm convex:dev
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
\`\`\`

pnpm dev starts one backend watcher and all apps with streamed Turbo logs. Run setup first so authentication prompts run in a normal terminal. Individual dev commands only start that app; keep convex:dev running separately. Mobile can also use its ios/android scripts. Expo build exports native JavaScript; it is not an Xcode or Gradle binary build.

## Shared backend types

\`\`\`ts
import { api } from '@${scope}/backend/api';
import type { Doc, Id } from '@${scope}/backend/dataModel';
\`\`\`

These package exports point directly to official Convex generated files. Keep convex/_generated committed. Run convex:dev after adding backend modules. Do not bundle declarations or copy backend code into apps. ${options.example === 'messages' ? 'Each app includes convex-api.type-test.ts with positive and negative compile-time assertions.' : 'The API starts empty and gains typed references when you add functions and run Convex code generation.'} Backend build checks types, it does not deploy functions.

TanStack Start uses client Convex hooks. Server-side data preloading is not configured. Next uses the App Router. Expo uses the default Metro workspace resolver and the SDK's React/React Native versions. Avoid independently upgrading React in one app.

## Deployment and troubleshooting

Deploy the backend explicitly with pnpm --filter @${scope}/backend exec convex deploy, then set each hosting provider's matching public URL and build that app. Never use production deploy keys for local development. Public variables are embedded at build time; rebuild after changing them.

A missing URL screen means that app's .env.local needs its framework-specific URL. Authentication failures usually mean the Clerk convex JWT template or deployment issuer is missing. If generated types are missing, run convex:dev from the backend package and verify that .d.ts files are committed. Metro cache problems after dependency changes can be cleared with pnpm --filter @${scope}/${options.apps.find((a) => a.framework === 'expo')?.name ?? options.apps[0]?.name} exec expo start --clear when using Expo. No symlink resolver overrides should be needed.
`,
  );
}
